/**
 * Autopilot orchestrator (scheduled, hourly).
 *
 * Reads Arsenal's fixtures, detects full-time (just after the whistle), then
 * generates copy + a branded card and writes a DRAFT awaiting 1-tap approval.
 * Idempotent: a given match+type is only ever drafted once.
 *
 * Build-up (pre-match) drafts were removed deliberately — the site's own
 * MatchPrediction card covers pre-kickoff, and the social feed is reaction-led.
 */

const { generateMatchCopy, compLabel, dateLabel } = require('./copy');
const { renderCard } = require('./graphics');
const { putImage } = require('./media');
const { createDraft, draftExists } = require('./store');
const { generateMatchVideo } = require('./matchVideo');
const { renderMatchVideo, isRenderAvailable } = require('./renderVideo');

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

  const video = await buildVideo(payload, match);

  await createDraft({
    ...payload,
    type,
    matchId: String(match.id),
    instagram: copy.instagram,
    x: copy.x,
    imageKey,
    needsPhoto: type === 'fulltime', // FT posts look best with a real photo
    ...video,
  });
  return { created: true, matchId: match.id, type, video: Boolean(video.videoUrl) };
}

/**
 * Goalscorers for one match.
 *
 * The team-matches listing carries scores but no goal detail — that only comes
 * from the single-match endpoint. Without this the video's "how it happened"
 * scene would be empty on every match. Returns [] rather than throwing: a
 * missing goal list should soften the video, not lose it.
 */
async function fetchGoals(matchId) {
  try {
    const { goals } = await fd(`/matches/${matchId}`);
    return (goals || []).map((g) => ({
      minute: g.minute,
      scorer: g.scorer?.name,
      team: g.team?.name,
      type: g.type,
    }));
  } catch (err) {
    console.warn(`[orchestrator] no goal detail for match ${matchId}:`, err.message);
    return [];
  }
}

/**
 * Attach a rendered match-review video to the draft.
 *
 * Never fails the draft. The card and copy are the product that has shipped for
 * months; video is the new half and is not worth losing a full-time post over,
 * so a render failure is recorded on the draft and surfaced in the queue rather
 * than thrown.
 */
async function buildVideo(payload, match) {
  if (!isRenderAvailable()) return {};

  try {
    const { props, script, durationMs, voice } = await generateMatchVideo({
      ...payload,
      home: match.homeTeam.name,
      away: match.awayTeam.name,
      goals: await fetchGoals(match.id),
    });
    const rendered = await renderMatchVideo(props);

    return {
      videoUrl: rendered.url,
      videoKey: rendered.outKey,
      videoBucket: rendered.bucketName,
      videoDurationMs: durationMs,
      videoVoice: `${voice.voiceId}/${voice.engine}`,
      youtubeTitle: script.youtubeTitle,
      youtubeDescription: script.youtubeDescription,
      instagramReelCaption: script.instagramCaption,
    };
  } catch (err) {
    console.error(`[orchestrator] video failed for match ${match.id}:`, err.message);
    return { videoError: err.message };
  }
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

    // Full-time: finished within the last 6 hours.
    if (m.status === 'FINISHED' && now - kickoff <= 6 * HOUR) {
      actions.push(await buildDraft('fulltime', m, recentForm));
    }
  }

  const created = actions.filter((a) => a?.created);
  console.log(`[orchestrator] ${created.length} draft(s) created`, created);
  return { created: created.length, actions };
};
