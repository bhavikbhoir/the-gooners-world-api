/**
 * Admin drafts API — the 1-tap approval surface.
 *
 *   GET  /admin/drafts            → list pending drafts (+ presigned previews)
 *   POST /admin/drafts            → { action, draftId, ... }
 *        action=approve  { platforms:['instagram','x'], imageBase64?, mimeType? }
 *        action=reject
 *        action=edit     { instagram?, x? }
 *
 * Approving with an imageBase64 re-renders the card over that real match photo
 * before publishing.
 */

const crypto = require('crypto');
const { listByStatus, getDraft, updateDraft } = require('./store');
const { publishDraft } = require('./publish');
const { renderCard } = require('./graphics');
const { putImage, presignGet } = require('./media');
const { compLabel, dateLabel } = require('./copy');

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

async function reRenderWithPhoto(draft, imageBase64, mimeType) {
  const photoBuffer = Buffer.from(imageBase64, 'base64');
  const cardBuffer = await renderCard({
    type: draft.type,
    homeName: draft.home,
    awayName: draft.away,
    homeScore: draft.homeScore,
    awayScore: draft.awayScore,
    homeCrest: draft.homeCrest,
    awayCrest: draft.awayCrest,
    competition: compLabel(draft.competition, draft.stage),
    dateLabel: dateLabel(draft.date),
    photoBuffer,
  });
  await putImage(draft.imageKey, cardBuffer); // overwrite same key
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const isAllowed = !origin || ALLOWED_ORIGINS.some((o) => o.trim() === origin);
  const corsOrigin = isAllowed ? (origin || ALLOWED_ORIGINS[0]) : ALLOWED_ORIGINS[0];
  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json',
  };
  const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!verifyToken(authHeader)) return reply(401, { error: 'Unauthorized' });

  try {
    if (event.httpMethod === 'GET') {
      const drafts = await listByStatus('pending');
      const withPreview = await Promise.all(drafts.map(async (d) => ({
        ...d,
        previewUrl: d.imageKey ? await presignGet(d.imageKey, 600) : null,
      })));
      return reply(200, { drafts: withPreview });
    }

    const body = JSON.parse(event.body || '{}');
    const { action, draftId } = body;
    const draft = await getDraft(draftId);
    if (!draft) return reply(404, { error: 'Draft not found' });

    if (action === 'reject') {
      await updateDraft(draftId, { status: 'rejected' });
      return reply(200, { ok: true, status: 'rejected' });
    }

    // Manual route: you posted it yourself (copy + paste). No API call.
    if (action === 'markPosted') {
      await updateDraft(draftId, {
        status: 'published',
        publishedAt: new Date().toISOString(),
        manual: true,
      });
      return reply(200, { ok: true, status: 'published' });
    }

    if (action === 'edit') {
      const fields = {};
      if (typeof body.instagram === 'string') fields.instagram = body.instagram;
      if (typeof body.x === 'string') fields.x = body.x;
      const updated = await updateDraft(draftId, fields);
      return reply(200, { ok: true, draft: updated });
    }

    if (action === 'approve') {
      if (draft.status !== 'pending') return reply(409, { error: `Draft already ${draft.status}` });
      const platforms = Array.isArray(body.platforms) && body.platforms.length ? body.platforms : ['instagram', 'x'];

      if (body.imageBase64) await reRenderWithPhoto(draft, body.imageBase64, body.mimeType);

      try {
        const results = await publishDraft(draft, platforms);
        const updated = await updateDraft(draftId, {
          status: 'published',
          publishedAt: new Date().toISOString(),
          results,
        });
        return reply(200, { ok: true, results, draft: updated });
      } catch (err) {
        await updateDraft(draftId, { status: 'failed', error: err.message });
        return reply(502, { error: `Publish failed: ${err.message}` });
      }
    }

    return reply(400, { error: 'Unknown action' });
  } catch (err) {
    return reply(500, { error: err.message });
  }
};
