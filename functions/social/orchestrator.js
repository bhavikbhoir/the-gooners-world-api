/**
 * Autopilot orchestrator (scheduled, hourly).
 *
 * Reads Arsenal's fixtures, detects two moments — build-up (~3h before kickoff)
 * and full-time (just after the whistle) — and for each generates copy + a
 * branded card, then writes a DRAFT awaiting 1-tap approval. Idempotent: a
 * given match+type is only ever drafted once.
 */

const { generateMatchCopy, compLabel, dateLabel } = require('./copy');
const { renderCard } = require('./graphics');
const { putImage } = require('./media');
const { createDraft, draftExists } = require('./store');

const ARSENAL_ID = 57;
const API = 'https://api.football-data.org/v4';
const HOUR = 3600 * 1000;

const iso = (d) => new Date(d).toISOString().slice(0, 10);

async function fd(path) {
  const res = await fetch(`${API}${path}`, { headers: { 'X-Auth-Token': process.env.FOOTBALL_API_KEY } });
  if (!res.ok) throw new Error(`football-data ${res.status}: ${await res.text()}`);
  return res.json();
}

function isArsenal(team) {
  return team?.id === ARSENAL_ID || team?.name === 'Arsenal FC';
}

// Last 5 Arsenal results as W/D/L, most recent first.
function computeForm(matches) {
  return matches
    .filter((m) => m.status === 'FINISHED')
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 5)
    .map((m) => {
      const home = isArsenal(m.homeTeam);
      const gf = home ? m.score.fullTime.home : m.score.fullTime.away;
      const ga = home ? m.score.fullTime.away : m.score.fullTime.home;
      return gf > ga ? 'W' : gf === ga ? 'D' : 'L';
    })
    .join(' ');
}

function toPayload(type, m, recentForm) {
  return {
    type,
    matchId: m.id,
    home: m.homeTeam.name,
    away: m.awayTeam.name,
    homeScore: m.score?.fullTime?.home,
    awayScore: m.score?.fullTime?.away,
    homeCrest: m.homeTeam.crest,
    awayCrest: m.awayTeam.crest,
    competition: m.competition?.name,
    stage: m.stage,
    date: m.utcDate,
    recentForm,
  };
}

async function buildDraft(type, match, recentForm) {
  if (await draftExists(type, match.id)) return { skipped: true };

  const payload = toPayload(type, match, recentForm);
  const copy = await generateMatchCopy(payload);

  const cardBuffer = await renderCard({
    type,
    homeName: match.homeTeam.shortName || match.homeTeam.name,
    awayName: match.awayTeam.shortName || match.awayTeam.name,
    homeScore: payload.homeScore,
    awayScore: payload.awayScore,
    competition: payload.competition,
    dateLabel: dateLabel(payload.date),
    // No photo at generation time — admin can attach one at approval.
    photoBuffer: null,
  });
  const imageKey = `drafts/${type}-${match.id}.jpg`;
  await putImage(imageKey, cardBuffer);

  await createDraft({
    ...payload,
    type,
    matchId: String(match.id),
    instagram: copy.instagram,
    x: copy.x,
    imageKey,
    needsPhoto: type === 'fulltime', // FT posts look best with a real photo
  });
  return { created: true, matchId: match.id, type };
}

exports.handler = async () => {
  const now = Date.now();
  const from = iso(now - 3 * 24 * HOUR);
  const to = iso(now + 8 * 24 * HOUR);

  const { matches } = await fd(`/teams/${ARSENAL_ID}/matches?dateFrom=${from}&dateTo=${to}`);
  const recentForm = computeForm(matches);
  const actions = [];

  for (const m of matches) {
    const kickoff = new Date(m.utcDate).getTime();

    // Build-up: kickoff within the next 3 hours.
    if (['SCHEDULED', 'TIMED'].includes(m.status) && kickoff - now > 0 && kickoff - now <= 3 * HOUR) {
      actions.push(await buildDraft('prematch', m, recentForm));
    }
    // Full-time: finished within the last 6 hours.
    if (m.status === 'FINISHED' && now - kickoff <= 6 * HOUR) {
      actions.push(await buildDraft('fulltime', m, recentForm));
    }
  }

  const created = actions.filter((a) => a?.created);
  console.log(`[orchestrator] ${created.length} draft(s) created`, created);
  return { created: created.length, actions };
};
