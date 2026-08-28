/**
 * Card renderer — "Classic" design, Oswald type, competition-themed, no crests.
 *
 * Two card types share the visual language:
 *   renderCard      — matchday scoreboard (pre-match / full-time)
 *   renderStatement — generic post (signing, injury, appreciation, on-this-day…)
 *
 * Both composite over an optional real photo (with legibility scrims) or fall
 * back to a solid themed background. Text uses Oswald, bundled at
 * functions/social/fonts (see fonts/README) and mapped via fontconfig on Lambda.
 */

const sharp = require('sharp');

const SIZE = 1080;
const RED = '#EF0107';
const FONT = "Oswald, 'DejaVu Sans', sans-serif";

const escapeXml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// ── competition theming ────────────────────────────────────────────
function compTheme(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('premier'))                                return { accent: '#e90052', primary: '#37003c', label: 'PREMIER LEAGUE' };
  if (n.includes('champions'))                              return { accent: '#3d9be0', primary: '#0a1a3f', label: 'CHAMPIONS LEAGUE' };
  if (n.includes('europa'))                                 return { accent: '#ff7a00', primary: '#2a1500', label: 'EUROPA LEAGUE' };
  if (n.includes('fa cup'))                                 return { accent: '#d9b44a', primary: '#6d1026', label: 'EMIRATES FA CUP' };
  if (n.includes('carabao') || n.includes('efl') || n.includes('league cup')) return { accent: '#00b3e3', primary: '#012a5e', label: 'CARABAO CUP' };
  return { accent: RED, primary: '#7a0a0a', label: (name || '').toUpperCase() };
}

async function fetchPhoto(input) {
  if (!input) return null;
  if (Buffer.isBuffer(input)) return input;
  try {
    const res = await fetch(input);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { return null; }
}

// Scrim + brand footer shared by both card types (SVG fragment).
function scrims(photo) {
  return photo ? `
    <rect width="${SIZE}" height="${SIZE}" fill="#000" opacity="0.34"/>
    <rect width="${SIZE}" height="460" fill="url(#topScrim)"/>
    <rect y="540" width="${SIZE}" height="540" fill="url(#botScrim)"/>` : '';
}
function defs() {
  return `<defs>
    <linearGradient id="topScrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.82"/><stop offset="0.3" stop-color="#000" stop-opacity="0"/></linearGradient>
    <linearGradient id="botScrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.94"/></linearGradient>
  </defs>`;
}
function footer(primary) {
  return `
    <rect x="0" y="962" width="${SIZE}" height="118" fill="${primary}"/>
    <text x="540" y="1024" text-anchor="middle" font-size="40" font-weight="700" fill="#fff" letter-spacing="2" font-family="${FONT}">THE GOONERS WORLD</text>
    <text x="540" y="1058" text-anchor="middle" font-size="20" fill="rgba(255,255,255,0.85)" font-family="${FONT}">@thegoonersworld</text>`;
}

// ── matchday scoreboard ────────────────────────────────────────────
function scoreboardSvg(o, t, photo) {
  const head = o.type === 'prematch' ? 'MATCHDAY' : 'FULL TIME';
  const scoreFill = photo ? '#fff' : t.accent;
  const centre = o.type === 'prematch'
    ? `<text x="540" y="565" text-anchor="middle" font-size="130" font-weight="700" letter-spacing="8" fill="${scoreFill}" font-family="${FONT}">VS</text>`
    : `<text x="540" y="600" text-anchor="middle" font-size="196" font-weight="700" fill="${scoreFill}" font-family="${FONT}">${escapeXml(o.homeScore)} – ${escapeXml(o.awayScore)}</text>`;
  const base = photo ? '' : `<rect width="${SIZE}" height="${SIZE}" fill="#0b0b11"/><rect width="${SIZE}" height="640" fill="${t.primary}" opacity="0.5"/>`;

  return `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    ${defs()}
    ${base}
    ${scrims(photo)}
    <rect width="${SIZE}" height="12" fill="${t.accent}"/>
    <text x="60" y="98" font-size="34" font-weight="600" fill="#fff" letter-spacing="3" font-family="${FONT}">${head}</text>
    <text x="1020" y="98" text-anchor="end" font-size="30" font-weight="600" fill="${photo ? '#fff' : t.accent}" letter-spacing="2" font-family="${FONT}">${escapeXml(t.label)}</text>
    <text x="540" y="320" text-anchor="middle" font-size="82" font-weight="600" fill="#fff" font-family="${FONT}">${escapeXml(o.homeName)}</text>
    ${centre}
    <text x="540" y="748" text-anchor="middle" font-size="82" font-weight="600" fill="#fff" font-family="${FONT}">${escapeXml(o.awayName)}</text>
    <text x="540" y="858" text-anchor="middle" font-size="30" fill="#e6e6ee" letter-spacing="1" font-family="${FONT}">${escapeXml(o.dateLabel)}${o.venue ? ' · ' + escapeXml(o.venue) : ''}</text>
    ${footer(t.primary)}
  </svg>`;
}

// ── generic statement card ─────────────────────────────────────────
function splitHeadline(text, max = 14) {
  const words = String(text || '').toUpperCase().split(/\s+/);
  const lines = [''];
  for (const w of words) {
    if ((lines[lines.length - 1] + ' ' + w).trim().length > max && lines[lines.length - 1]) lines.push(w);
    else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + w).trim();
    if (lines.length === 2) break;
  }
  return lines.slice(0, 2);
}
function statementSvg(o, photo) {
  const accent = o.accent || RED;
  const primary = o.primary || '#7a0a0a';
  const lines = splitHeadline(o.headline);
  const hy = lines.length === 2 ? [520, 640] : [590];
  const headlineText = lines.map((l, i) =>
    `<text x="60" y="${hy[i]}" font-size="120" font-weight="700" fill="#fff" font-family="${FONT}">${escapeXml(l)}</text>`).join('');
  const base = photo ? '' : `<rect width="${SIZE}" height="${SIZE}" fill="#0b0b11"/><rect width="${SIZE}" height="${SIZE}" fill="${primary}" opacity="0.35"/>`;

  return `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    ${defs()}
    ${base}
    ${scrims(photo)}
    <rect width="${SIZE}" height="12" fill="${accent}"/>
    <rect x="60" y="120" width="${28 + (o.tag || '').length * 20}" height="52" rx="6" fill="${accent}"/>
    <text x="${74}" y="156" font-size="28" font-weight="600" fill="#fff" letter-spacing="2" font-family="${FONT}">${escapeXml((o.tag || '').toUpperCase())}</text>
    ${headlineText}
    <text x="60" y="${(lines.length === 2 ? 640 : 590) + 70}" font-size="46" font-weight="500" fill="#e6e6ee" font-family="${FONT}">${escapeXml(o.subhead || '')}</text>
    ${footer(primary)}
  </svg>`;
}

async function compose(svg, photoBuffer) {
  const overlay = Buffer.from(svg);
  if (photoBuffer) {
    return sharp(photoBuffer)
      .resize(SIZE, SIZE, { fit: 'cover', position: 'attention' })
      .composite([{ input: overlay }])
      .jpeg({ quality: 88 })
      .toBuffer();
  }
  return sharp(overlay).jpeg({ quality: 88 }).toBuffer();
}

/** Matchday scoreboard card → JPEG buffer. */
async function renderCard(o) {
  const t = compTheme(o.competition);
  const photo = await fetchPhoto(o.photo || o.photoBuffer);
  return compose(scoreboardSvg(o, t, !!photo), photo);
}

/** Generic statement card (signing / injury / appreciation / …) → JPEG buffer. */
async function renderStatement(o) {
  const t = o.competition ? compTheme(o.competition) : { accent: RED, primary: '#7a0a0a' };
  const photo = await fetchPhoto(o.photo || o.photoBuffer);
  return compose(statementSvg({ ...o, accent: o.accent || t.accent, primary: o.primary || t.primary }, !!photo), photo);
}

module.exports = { renderCard, renderStatement, compTheme };
