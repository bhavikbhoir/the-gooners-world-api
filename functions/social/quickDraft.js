/**
 * Quick Draft composer — POST /admin/quick-draft
 *
 * Admin picks a template (signing / injury / appreciation / …), types the facts,
 * optionally attaches a photo. We generate the caption + a branded statement
 * card and drop a draft into the same approval queue as the autopilot posts.
 *
 * Body: { type, details, competition?, imageBase64?, mimeType? }
 */

const crypto = require('crypto');
const { generateQuickCopy } = require('./quickCopy');
const { renderStatement } = require('./graphics');
const { putImage, presignGet } = require('./media');
const { createDraft } = require('./store');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');
const ADMIN_KEY = process.env.ADMIN_KEY;

function verifyToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ') || !ADMIN_KEY) return false;
  const [timestamp, hmac] = authHeader.slice(7).split('.');
  if (!timestamp || !hmac) return false;
  if (Math.floor(Date.now() / 1000) - parseInt(timestamp, 10) > 8 * 3600) return false;
  const expected = crypto.createHmac('sha256', ADMIN_KEY).update(timestamp).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex')); }
  catch { return false; }
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const isAllowed = !origin || ALLOWED_ORIGINS.some((o) => o.trim() === origin);
  const corsOrigin = isAllowed ? (origin || ALLOWED_ORIGINS[0]) : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Content-Type': 'application/json',
  };
  const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!verifyToken(authHeader)) return reply(401, { error: 'Unauthorized' });

  try {
    const { type, details, competition, imageBase64, mimeType } = JSON.parse(event.body || '{}');
    if (!type || !details) return reply(400, { error: 'type and details are required' });

    const copy = await generateQuickCopy({ type, details });
    const photoBuffer = imageBase64 ? Buffer.from(imageBase64, 'base64') : null;

    const cardBuffer = await renderStatement({
      tag: copy.tag,
      headline: copy.headline,
      subhead: copy.subhead,
      competition, // optional — themes the accent if it's a comp-specific post
      photoBuffer,
    });

    const id = Date.now();
    const imageKey = `drafts/quick-${type}-${id}.jpg`;
    await putImage(imageKey, cardBuffer);

    const draft = await createDraft({
      kind: 'statement',
      type,
      matchId: String(id),
      tag: copy.tag,
      headline: copy.headline,
      subhead: copy.subhead,
      competition: competition || null,
      instagram: copy.instagram,
      x: copy.x,
      imageKey,
      needsPhoto: !photoBuffer,
    });

    return reply(200, { ok: true, draft: { ...draft, previewUrl: await presignGet(imageKey, 600) } });
  } catch (err) {
    return reply(500, { error: err.message });
  }
};
