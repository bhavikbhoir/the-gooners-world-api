const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const https = require('https');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');
const ADMIN_KEY = process.env.ADMIN_KEY;
const s3 = new S3Client({ region: 'us-east-1' });

function verifyToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ') || !ADMIN_KEY) return false;
  const [timestamp, hmac] = authHeader.slice(7).split('.');
  if (!timestamp || !hmac) return false;
  if (Math.floor(Date.now() / 1000) - parseInt(timestamp, 10) > 8 * 3600) return false;
  const expected = crypto.createHmac('sha256', ADMIN_KEY).update(timestamp).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex')); }
  catch { return false; }
}

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function matchSlug(home, away, homeScore, awayScore) {
  const clean = (s) => (s || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${clean(home)}-vs-${clean(away)}-${homeScore ?? 'x'}-${awayScore ?? 'x'}-${ts}`;
}

async function uploadToS3(base64Data, mimeType, matchMeta) {
  const bucket = process.env.S3_IMAGES_BUCKET;
  if (!bucket) throw new Error('S3_IMAGES_BUCKET not configured');
  const ext = mimeType.split('/')[1] || 'jpg';
  const slug = matchSlug(matchMeta?.home, matchMeta?.away, matchMeta?.homeScore, matchMeta?.awayScore);
  const key = `social/${slug}.${ext}`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: Buffer.from(base64Data, 'base64'),
    ContentType: mimeType,
  }));
  // Pre-signed URL valid for 5 minutes — enough for Instagram to fetch, expires after
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 300 });
}

async function postToInstagram({ imageUrl, caption }) {
  const accountId = process.env.IG_ACCOUNT_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  if (!accountId || !token) throw new Error('Instagram credentials not configured');

  const containerUrl = `https://graph.facebook.com/v18.0/${accountId}/media`;
  const containerBody = JSON.stringify({ image_url: imageUrl, caption, access_token: token });
  const containerRes = await httpPost(containerUrl, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(containerBody) }, containerBody);

  if (containerRes.status !== 200) throw new Error(`IG container: ${containerRes.body}`);
  const { id: creationId } = JSON.parse(containerRes.body);

  await new Promise((r) => setTimeout(r, 4000));

  const publishUrl = `https://graph.facebook.com/v18.0/${accountId}/media_publish`;
  const publishBody = JSON.stringify({ creation_id: creationId, access_token: token });
  const publishRes = await httpPost(publishUrl, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(publishBody) }, publishBody);

  if (publishRes.status !== 200) throw new Error(`IG publish: ${publishRes.body}`);
  return JSON.parse(publishRes.body);
}

function buildXAuthHeader(method, url) {
  const appKey = process.env.X_APP_KEY;
  const appSecret = process.env.X_APP_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const tokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!appKey || !appSecret || !accessToken || !tokenSecret) throw new Error('X credentials not configured');

  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams = {
    oauth_consumer_key: appKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: '1.0',
  };

  const paramStr = Object.entries(oauthParams)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const baseStr = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramStr)].join('&');
  const signingKey = `${encodeURIComponent(appSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');

  oauthParams.oauth_signature = signature;
  return 'OAuth ' + Object.entries(oauthParams)
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(', ');
}

async function postToX({ text }) {
  const url = 'https://api.twitter.com/2/tweets';
  const authHeader = buildXAuthHeader('POST', url);
  const body = JSON.stringify({ text });
  const res = await httpPost(url, {
    Authorization: authHeader,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  }, body);
  if (res.status < 200 || res.status >= 300) throw new Error(`X API: ${res.body}`);
  return JSON.parse(res.body);
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const isAllowed = !origin || ALLOWED_ORIGINS.some((o) => o.trim() === origin);
  const corsOrigin = isAllowed ? (origin || ALLOWED_ORIGINS[0]) : ALLOWED_ORIGINS[0];
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!verifyToken(authHeader)) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { platform, instagramCaption, xText, imageBase64, mimeType, home, away, homeScore, awayScore } = JSON.parse(event.body || '{}');
    const results = {};

    if (platform === 'instagram' || platform === 'both') {
      if (!imageBase64) throw new Error('Image required for Instagram');
      const imageUrl = await uploadToS3(imageBase64, mimeType || 'image/jpeg', { home, away, homeScore, awayScore });
      results.instagram = await postToInstagram({ imageUrl, caption: instagramCaption });
    }

    if (platform === 'x' || platform === 'both') {
      results.x = await postToX({ text: xText });
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, results }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
