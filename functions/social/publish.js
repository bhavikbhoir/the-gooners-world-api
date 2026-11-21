/**
 * Publishing to Instagram + X, including X image upload (which the old
 * text-only publishPost lacked).
 *
 * Instagram: Graph API container → publish, using a presigned S3 image URL.
 * X: v1.1 media/upload (OAuth 1.0a) → v2 tweet with the media id.
 */

const crypto = require('crypto');
const { getImage, presignGet, presignFrom } = require('./media');
const { getSecret } = require('./secrets');

const GRAPH_VERSION = 'v21.0';

function httpsRequest(method, url, headers, body) {
  return fetch(url, { method, headers, body }).then(async (res) => ({
    status: res.status,
    body: await res.text(),
  }));
}

// ── Instagram ───────────────────────────────────────────────────────
async function postToInstagram({ imageKey, caption }) {
  const accountId = process.env.IG_ACCOUNT_ID;
  // Read at runtime — refreshIgToken rotates this in SSM.
  const token = await getSecret('/tgw/ig-access-token');
  if (!accountId || !token) throw new Error('Instagram credentials not configured');

  const imageUrl = await presignGet(imageKey, 300);

  const containerBody = JSON.stringify({ image_url: imageUrl, caption, access_token: token });
  const c = await httpsRequest('POST', `https://graph.facebook.com/${GRAPH_VERSION}/${accountId}/media`,
    { 'Content-Type': 'application/json' }, containerBody);
  if (c.status !== 200) throw new Error(`IG container: ${c.body}`);
  const creationId = JSON.parse(c.body).id;

  await new Promise((r) => setTimeout(r, 4000));

  const pubBody = JSON.stringify({ creation_id: creationId, access_token: token });
  const p = await httpsRequest('POST', `https://graph.facebook.com/${GRAPH_VERSION}/${accountId}/media_publish`,
    { 'Content-Type': 'application/json' }, pubBody);
  if (p.status !== 200) throw new Error(`IG publish: ${p.body}`);
  return JSON.parse(p.body);
}

/**
 * Publish a Reel.
 *
 * Unlike a photo, Instagram transcodes video asynchronously: the container is
 * accepted immediately but publishing before it reports FINISHED fails. So this
 * polls status_code rather than using the photo path's fixed sleep.
 *
 * The URL must be fetchable by Meta's servers, so the caller passes a presigned
 * one — the rendered mp4 lives in Remotion's private output bucket.
 */
async function postReelToInstagram({ videoUrl, caption, coverUrl }) {
  const accountId = process.env.IG_ACCOUNT_ID;
  const token = await getSecret('/tgw/ig-access-token');
  if (!accountId || !token) throw new Error('Instagram credentials not configured');

  const body = {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: true,
    access_token: token,
    ...(coverUrl ? { cover_url: coverUrl } : {}),
  };

  const c = await httpsRequest('POST', `https://graph.facebook.com/${GRAPH_VERSION}/${accountId}/media`,
    { 'Content-Type': 'application/json' }, JSON.stringify(body));
  if (c.status !== 200) throw new Error(`IG reel container: ${c.body}`);
  const creationId = JSON.parse(c.body).id;

  await waitForContainer(creationId, token);

  const p = await httpsRequest('POST', `https://graph.facebook.com/${GRAPH_VERSION}/${accountId}/media_publish`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ creation_id: creationId, access_token: token }));
  if (p.status !== 200) throw new Error(`IG reel publish: ${p.body}`);
  return JSON.parse(p.body);
}

/** Poll a video container until Instagram finishes transcoding it. */
async function waitForContainer(creationId, token, { timeoutMs = 300000, intervalMs = 5000 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const res = await httpsRequest('GET',
      `https://graph.facebook.com/${GRAPH_VERSION}/${creationId}?fields=status_code,status&access_token=${token}`,
      {});
    const { status_code: code, status } = JSON.parse(res.body || '{}');

    if (code === 'FINISHED') return;
    if (code === 'ERROR') throw new Error(`IG transcode failed: ${status || 'unknown'}`);
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`IG transcode timed out after ${timeoutMs / 1000}s (container ${creationId})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── X (Twitter) OAuth 1.0a ──────────────────────────────────────────
function xAuthHeader(method, url, extraParams = {}) {
  const { X_APP_KEY, X_APP_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = process.env;
  if (!X_APP_KEY || !X_APP_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_TOKEN_SECRET) {
    throw new Error('X credentials not configured');
  }
  const oauth = {
    oauth_consumer_key: X_APP_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  // Only oauth + (for signing) any x-www-form-urlencoded params. For multipart
  // uploads we pass no extraParams so the binary body isn't signed.
  const allParams = { ...oauth, ...extraParams };
  const paramStr = Object.entries(allParams).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const baseStr = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramStr)].join('&');
  const signingKey = `${encodeURIComponent(X_APP_SECRET)}&${encodeURIComponent(X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');
  return 'OAuth ' + Object.entries(oauth).map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(', ');
}

// Upload an image to X and return its media_id_string. Uses multipart so the
// binary is excluded from the OAuth signature base.
async function uploadXMedia(buffer) {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';
  const boundary = '----gooners' + crypto.randomBytes(8).toString('hex');
  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="card.jpg"\r\n` +
    `Content-Type: image/jpeg\r\n\r\n`);
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([pre, buffer, post]);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: xAuthHeader('POST', url),
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) throw new Error(`X media upload: ${text}`);
  return JSON.parse(text).media_id_string;
}

async function postToX({ text, mediaId }) {
  const url = 'https://api.twitter.com/2/tweets';
  const payload = { text };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  const res = await httpsRequest('POST', url,
    { Authorization: xAuthHeader('POST', url), 'Content-Type': 'application/json' },
    JSON.stringify(payload));
  if (res.status < 200 || res.status >= 300) throw new Error(`X tweet: ${res.body}`);
  return JSON.parse(res.body);
}

/**
 * Publish a stored draft to the requested platforms.
 * @param draft  the DynamoDB draft item (has imageKey, instagram, x)
 * @param platforms  array like ['instagram','x']
 */
async function publishDraft(draft, platforms) {
  const results = {};
  const imageBuffer = draft.imageKey ? await getImage(draft.imageKey) : null;

  if (platforms.includes('instagram')) {
    if (!draft.imageKey) throw new Error('Instagram requires an image');
    results.instagram = await postToInstagram({ imageKey: draft.imageKey, caption: draft.instagram });
  }
  if (platforms.includes('reel')) {
    if (!draft.videoKey || !draft.videoBucket) throw new Error('No rendered video on this draft');
    // Long TTL: Meta fetches the file during transcoding, which can take minutes.
    const videoUrl = await presignFrom(draft.videoBucket, draft.videoKey, 1800);
    results.reel = await postReelToInstagram({
      videoUrl,
      caption: draft.instagramReelCaption || draft.instagram,
    });
  }
  if (platforms.includes('x')) {
    let mediaId = null;
    if (imageBuffer) mediaId = await uploadXMedia(imageBuffer);
    results.x = await postToX({ text: draft.x, mediaId });
  }
  return results;
}

module.exports = { publishDraft, postToInstagram, postReelToInstagram, postToX, uploadXMedia };
