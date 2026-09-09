/**
 * Match card renderer — POST /admin/generate-card
 *
 * Compose's server-side counterpart to the autopilot orchestrator: builds the
 * same branded scoreboard card (functions/social/graphics.js renderCard) so
 * manual and automated posts always look identical. Goal scorers / referee are
 * included when the admin has match detail to hand. No club crests.
 *
 * Body: { type, home, away, homeScore, awayScore, competition, date,
 *         venue?, goals?, referee?, imageBase64? }
 */

const crypto = require('crypto');
const { renderCard } = require('../social/graphics');
const { dateLabel } = require('../social/copy');

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
    const {
      type, home, away, homeScore, awayScore,
      competition, date, venue, goals, referee, imageBase64,
    } = JSON.parse(event.body || '{}');

    if (!home || !away || !date) return reply(400, { error: 'home, away and date are required' });

    const photoBuffer = imageBase64 ? Buffer.from(imageBase64, 'base64') : null;

    const cardBuffer = await renderCard({
      type: type === 'prematch' ? 'prematch' : 'fulltime',
      homeName: home,
      awayName: away,
      homeScore,
      awayScore,
      competition,
      dateLabel: dateLabel(date),
      venue: venue || undefined,
      goals: goals || undefined,
      referee: referee || undefined,
      photoBuffer,
    });

    return reply(200, {
      ok: true,
      imageBase64: cardBuffer.toString('base64'),
      mimeType: 'image/jpeg',
    });
  } catch (err) {
    return reply(500, { error: err.message });
  }
};
