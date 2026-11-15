/**
 * Match review video pipeline — script → narration → render props.
 *
 * One call turns a finished match into everything the renderer needs. Nothing
 * here is hand-written: the script comes from Bedrock, the voice from Polly,
 * and the timings are measured from the audio rather than estimated.
 *
 * Deliberately stops short of invoking the renderer. Remotion Lambda is a
 * separate deployment with its own lifecycle, so this module produces the
 * payload and the caller decides where it is rendered — which also means the
 * whole chain is testable locally without any render infrastructure.
 */

const { generateVideoScript } = require('./videoScript');
const { synthesizeNarration } = require('./narration');
const { compTheme } = require('./graphics');
const { putAudio, presignGet } = require('./media');

// Long enough to cover a cold Lambda plus the render itself.
const AUDIO_URL_TTL = 3600;

const isArsenal = (name) => /^arsenal/i.test(String(name || ''));

/** Goals in the shape the composition expects, chronological. */
function toGoals(goals) {
  return (goals || [])
    .map((g) => ({
      minute: Number(g.minute) || 0,
      scorer: shortScorer(g.scorer),
      isArsenal: isArsenal(g.team),
    }))
    .filter((g) => g.scorer)
    .sort((a, b) => a.minute - b.minute);
}

/** Surnames only — a full name at 62px overflows the goal row. */
function shortScorer(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || '';
}

/**
 * Build a complete render payload for one finished match.
 *
 * @param match  orchestrator payload + { matchId, goals?, table? }
 * @returns {Promise<{props: object, audioKey: string, durationMs: number, script: object, voice: object}>}
 */
async function generateMatchVideo(match) {
  const script = await generateVideoScript(match);

  const narration = await synthesizeNarration({
    lines: script.lines,
    competition: match.competition,
  });

  const audioKey = `video/narration-${match.matchId || Date.now()}.mp3`;
  await putAudio(audioKey, narration.audio);

  // The same accent the card renderer uses, so a clip and its card match.
  const { accent } = compTheme(match.competition);

  const props = {
    variant: script.variant,
    accent,
    narrationUrl: await presignGet(audioKey, AUDIO_URL_TTL),
    durationMs: narration.durationMs,
    segments: narration.segments,
    match: {
      home: match.home,
      away: match.away,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      competition: match.competition,
    },
    hook: script.hook,
    goals: toGoals(match.goals),
    verdict: script.verdict,
    table: script.table,
  };

  return {
    props,
    audioKey,
    durationMs: narration.durationMs,
    voice: { voiceId: narration.voiceId, engine: narration.engine },
    script: {
      youtubeTitle: script.youtubeTitle,
      youtubeDescription: script.youtubeDescription,
      instagramCaption: script.instagramCaption,
    },
  };
}

module.exports = { generateMatchVideo, toGoals, shortScorer };
