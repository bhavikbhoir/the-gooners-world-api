/**
 * Branded matchday card generator.
 *
 * Composites: [optional real match photo OR brand gradient] → dark bottom
 * gradient for legibility → both club crests → text overlay (score/fixture,
 * competition, date, brand). Output: 1080×1080 JPEG (works for IG feed + X).
 *
 * Fonts: sharp rasterises SVG text via librsvg/fontconfig. On Lambda that needs
 * a bundled font. Drop a TTF at functions/social/fonts/ and point FONTCONFIG_PATH
 * at it (see fonts/README). Locally it uses your system fonts.
 */

const sharp = require('sharp');

const SIZE = 1080;
const RED = '#EF0107';
const NAVY = '#0a0a1e';

const escapeXml = (s) => String(s || '').replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function fetchImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Base background: the supplied photo (cover-cropped) or a brand gradient.
async function baseLayer(photoBuffer) {
  if (photoBuffer) {
    return sharp(photoBuffer).resize(SIZE, SIZE, { fit: 'cover', position: 'attention' });
  }
  const svg = `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${NAVY}"/><stop offset="100%" stop-color="#2a0208"/>
    </linearGradient></defs>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#g)"/>
  </svg>`;
  return sharp(Buffer.from(svg));
}

function textOverlay(o) {
  const isFT = o.type !== 'prematch';
  const centerY = 470;

  const scoreBlock = isFT
    ? `<text x="540" y="${centerY}" text-anchor="middle" font-size="150" font-weight="800" fill="#fff">${o.homeScore} – ${o.awayScore}</text>`
    : `<text x="540" y="${centerY}" text-anchor="middle" font-size="92" font-weight="800" fill="#fff" letter-spacing="4">MATCHDAY</text>`;

  const vsLine = isFT
    ? `${escapeXml(o.homeName)}  v  ${escapeXml(o.awayName)}`
    : `${escapeXml(o.homeName)}  vs  ${escapeXml(o.awayName)}`;

  return Buffer.from(`<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="55%" stop-color="#000" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.92"/>
    </linearGradient></defs>
    <rect width="${SIZE}" height="${SIZE}" fill="url(#shade)"/>
    <rect x="0" y="0" width="${SIZE}" height="10" fill="${RED}"/>
    <style>text{font-family:'Gooners','DejaVu Sans','Arial',sans-serif;}</style>

    ${scoreBlock}
    <text x="540" y="${centerY + 70}" text-anchor="middle" font-size="46" font-weight="700" fill="#fff">${vsLine}</text>

    <text x="540" y="880" text-anchor="middle" font-size="34" font-weight="600" fill="${RED}" letter-spacing="2">${escapeXml((o.competition || '').toUpperCase())}</text>
    <text x="540" y="928" text-anchor="middle" font-size="30" font-weight="400" fill="#d0d0d8">${escapeXml(o.dateLabel || '')}</text>

    <text x="540" y="1015" text-anchor="middle" font-size="30" font-weight="700" fill="#fff" letter-spacing="3">THE GOONERS WORLD</text>
  </svg>`);
}

/**
 * @returns {Promise<Buffer>} 1080×1080 JPEG
 */
async function renderCard(o) {
  const [homeCrest, awayCrest] = await Promise.all([fetchImage(o.homeCrest), fetchImage(o.awayCrest)]);

  const composites = [{ input: textOverlay(o) }];

  const crestSize = 150;
  const crestY = 250;
  if (homeCrest) {
    composites.unshift({
      input: await sharp(homeCrest).resize(crestSize, crestSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
      top: crestY, left: 235,
    });
  }
  if (awayCrest) {
    composites.unshift({
      input: await sharp(awayCrest).resize(crestSize, crestSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
      top: crestY, left: SIZE - 235 - crestSize,
    });
  }

  const base = await baseLayer(o.photoBuffer);
  return base
    .composite(composites)
    .jpeg({ quality: 88 })
    .toBuffer();
}

module.exports = { renderCard };
