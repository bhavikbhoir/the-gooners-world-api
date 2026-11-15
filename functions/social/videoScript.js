/**
 * Match review video script (Claude Sonnet via Bedrock).
 *
 * Produces everything the Remotion composition and the narration need: a hook,
 * a written verdict, one narration line per scene, and the platform captions.
 *
 * Two hard constraints shape this file.
 *
 * 1. Anti-hallucination. football-data.org's plan gives us scores, scorers,
 *    minutes, standings and form — NOT shots, xG, possession or passes. So the
 *    hook is chosen from a list of candidates computed here in code; the model
 *    picks one and writes around it, and is never asked to supply a number.
 *
 * 2. Originality. YouTube withholds monetisation from "generic or unoriginal
 *    templates giving the impression of mass production without adding the
 *    creator's original, authentic insights". The verdict is the scene that
 *    answers that, so the prompt pushes for a read on the game and explicitly
 *    rejects restating the scoreline.
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { compLabel, dateLabel } = require('./copy');

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const MODEL = 'us.anthropic.claude-sonnet-4-6';

// Must stay in step with VARIANTS in src/remotion/MatchReview.jsx. The backend
// owns the order: it emits narration segments in sequence and the composition
// times itself from them.
const SCENE_ORDERS = {
  hookFirst: ['hook', 'score', 'moments', 'verdict', 'table', 'outro'],
  scoreFirst: ['score', 'hook', 'verdict', 'moments', 'table', 'outro'],
  verdictLed: ['hook', 'verdict', 'score', 'moments', 'table', 'outro'],
};

const isArsenal = (name) => /^arsenal/i.test(String(name || ''));

/**
 * Verifiable hook candidates, derived only from data we actually receive.
 * Returning an empty list is fine — the prompt falls back to the margin.
 */
function hookCandidates(m) {
  const home = isArsenal(m.home);
  const gf = home ? m.homeScore : m.awayScore;
  const ga = home ? m.awayScore : m.homeScore;
  const out = [];

  if (gf >= 3) out.push({ key: 'goals', label: 'Goals scored', value: String(gf) });
  if (ga === 0 && Number.isInteger(gf)) out.push({ key: 'cleanSheet', label: 'Goals conceded', value: '0' });
  if (gf - ga >= 3) out.push({ key: 'margin', label: 'Winning margin', value: String(gf - ga) });

  const arsenalGoals = (m.goals || []).filter((g) => isArsenal(g.team));
  if (arsenalGoals.length >= 2) {
    const first = Math.min(...arsenalGoals.map((g) => Number(g.minute) || 99));
    if (first <= 15) out.push({ key: 'fastStart', label: 'First goal', value: `${first}'` });
  }
  const scorers = new Set(arsenalGoals.map((g) => g.scorer).filter(Boolean));
  if (scorers.size >= 3) out.push({ key: 'scorers', label: 'Different scorers', value: String(scorers.size) });

  if (m.table?.position) out.push({ key: 'position', label: 'League position', value: String(m.table.position) });
  if (m.table?.points) out.push({ key: 'points', label: 'Points', value: String(m.table.points) });

  const wins = (m.recentForm || '').split(/\s+/).filter((c) => c === 'W').length;
  if (wins >= 4) out.push({ key: 'form', label: 'Wins in five', value: String(wins) });

  return out;
}

function buildPrompt(m) {
  const home = isArsenal(m.home);
  const gf = home ? m.homeScore : m.awayScore;
  const ga = home ? m.awayScore : m.homeScore;
  const outcome = gf > ga ? 'win' : gf === ga ? 'draw' : 'loss';
  const venue = home ? 'home' : 'away';

  // Scoreline notation is always home team first. Never reorder to put Arsenal
  // first — "Napoli 0-1 Arsenal" must not become "Arsenal 1-0 Napoli".
  const scoreLine = `${m.home} ${m.homeScore}–${m.awayScore} ${m.away}`;

  const goals = (m.goals || []).length
    ? m.goals.map((g) => `  - ${g.minute}' ${g.scorer} (${g.team})${g.type && g.type !== 'REGULAR' ? ` [${g.type}]` : ''}`).join('\n')
    : '  - (no goalscorer data available)';

  const candidates = hookCandidates(m);
  const candidateList = candidates.length
    ? candidates.map((c) => `  - key "${c.key}": ${c.label} = ${c.value}`).join('\n')
    : '  - (none — build the hook from the scoreline margin)';

  return `You are the voice of The Gooners World, an Arsenal FC fan channel, writing a short vertical match-review video (Instagram Reels / YouTube Shorts).

MATCH DATA — this is the complete set of facts. Do NOT introduce any other number, player, statistic, tactic, injury, or stadium.
- Score: ${scoreLine} (home team first, standard notation)
- Arsenal played: ${venue}
- Venue name: UNKNOWN — we do not have it. Never name a stadium, ground or city.
- Outcome for Arsenal: ${outcome}
- Competition: ${compLabel(m.competition, m.stage)}
- Date: ${dateLabel(m.date)}
- Arsenal recent form (last 5, most recent first): ${m.recentForm || 'unknown'}
- League position after this match: ${m.table?.position || 'unknown'}
- Points: ${m.table?.points || 'unknown'}
- Goals:
${goals}

APPROVED HOOK STATS — you MUST choose exactly one of these keys. You may not invent a statistic. We do not have shots, xG, possession, passes or distance covered, so never mention them.
${candidateList}

WRITE A SCRIPT WITH SIX SCENES, each one spoken line:
- hook    — open on the chosen stat. Do NOT open with the scoreline; the viewer already knows it. Make them stay.
- score   — state the result plainly, once.
- moments — walk the goals in order. Only the scorers listed above.
- verdict — THE MOST IMPORTANT LINE. A genuine read on what this result means: what changed, what it costs or buys Arsenal, what it says about the run. One or two sentences with a point of view. Do NOT restate the scoreline or list stats here. An honest, specific opinion — not hype, and not doom after a loss.
- table   — where this leaves Arsenal, using only the position and points above.
- outro   — invite a follow for the verdict after every match. One short line.

TONE: a knowledgeable Arsenal fan talking to other fans. Confident, never arrogant. After a loss be honest, not catastrophic. British English. Spoken aloud by a text-to-speech voice, so write for the ear: short sentences, no emoji, no hashtags, no brackets, no symbols, and write numbers as words where a person would say them.

Respond with ONLY valid JSON in exactly this shape:
{
  "variant": "hookFirst" | "scoreFirst" | "verdictLed",
  "hookKey": "<one key from the approved list>",
  "hookCaption": "<short on-screen line under the number, max 12 words>",
  "verdict": "<the on-screen verdict text, max 22 words>",
  "tableDetail": "<short on-screen phrase, e.g. 'four clear at the top', max 6 words>",
  "narration": {
    "hook": "...", "score": "...", "moments": "...",
    "verdict": "...", "table": "...", "outro": "..."
  },
  "youtubeTitle": "<search-shaped, max 70 chars, include both team names and the score>",
  "youtubeDescription": "<2 sentences, plain text>",
  "instagramCaption": "<reaction-shaped, ends with one specific question, 3-5 hashtags>"
}`;
}

/**
 * Stadium names are the hallucination this prompt actually produces: asked for
 * an away loss at Newcastle, the model volunteered "Away at St James' Park"
 * from the club name alone. We never supply a venue, so any ground mentioned is
 * invented. Checked in code because the prompt rule alone did not hold.
 */
const BANNED = [
  /\bst\.? james'?s? park\b/i, /\banfield\b/i, /\betihad\b/i, /\bold trafford\b/i,
  /\bstamford bridge\b/i, /\bemirates\b/i, /\bvilla park\b/i, /\bselhurst\b/i,
  /\bgoodison\b/i, /\bmolineux\b/i, /\bthe bridge\b/i, /\btottenham hotspur stadium\b/i,
  /\b(?:stadium|arena|ground)\b/i,
  // Stats the data plan does not include — if these appear, they are invented.
  /\bx\.?g\b/i, /\bpossession\b/i, /\bshots? on target\b/i, /\bpass(?:es|ing) accuracy\b/i,
  /\bcorners?\b/i, /\bkilometres|\bdistance covered\b/i,
  // Tactical detail we cannot see from a scoreline. The model reached for
  // "conceding late set-pieces" on a match whose goals were on 23 and 71
  // minutes — plausible-sounding and entirely invented.
  /\bset[- ]piece/i, /\bcounter[- ]attack/i, /\bformation\b/i, /\bsubstitution/i,
  /\boffside\b/i, /\bpenalty (?:box|area)\b/i, /\bbooking|\bred card|\byellow card/i,
  /\binjur(?:y|ed|ies)\b/i, /\bhigh press\b/i, /\bback (?:three|four|five)\b/i,
];

function findInvented(script) {
  const haystack = [
    ...Object.values(script.narration || {}),
    script.verdict, script.hookCaption, script.tableDetail,
  ].filter(Boolean).join(' \n ');

  return BANNED.filter((re) => re.test(haystack)).map((re) => String(re));
}

/** Narration lines in scene order, ready for synthesizeNarration(). */
function toLines(variant, narration) {
  const order = SCENE_ORDERS[variant] || SCENE_ORDERS.hookFirst;
  return order
    .map((key) => ({ key, text: String(narration?.[key] || '').trim() }))
    .filter((l) => l.text);
}

/**
 * Generate the full script for one finished match.
 *
 * @returns {Promise<{variant, hook, verdict, table, lines, youtubeTitle, youtubeDescription, instagramCaption}>}
 */
async function askModel(messages) {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1200,
      messages,
    }),
  }));
  const raw = JSON.parse(Buffer.from(res.body).toString()).content[0].text.trim();
  const json = raw.match(/\{[\s\S]*\}/);
  if (!json) throw new Error('Model did not return valid JSON');
  return { parsed: JSON.parse(json[0]), raw };
}

async function generateVideoScript(match) {
  const candidates = hookCandidates(match);
  const prompt = buildPrompt(match);

  let { parsed: out, raw } = await askModel([{ role: 'user', content: prompt }]);

  // One corrective pass. A draft reaches a human before it publishes, but the
  // point of this pipeline is that it does not need one, so fail rather than
  // ship invented detail.
  let invented = findInvented(out);
  if (invented.length) {
    console.warn('[videoScript] invented detail, retrying:', invented);
    ({ parsed: out } = await askModel([
      { role: 'user', content: prompt },
      { role: 'assistant', content: raw },
      {
        role: 'user',
        content: `That response named a stadium or a statistic that was not in the match data. We do not know where the match was played and we have no shots, xG, possession, passing or corner data. Rewrite the JSON with every such reference removed. Change nothing else. Respond with ONLY the JSON.`,
      },
    ]));
    invented = findInvented(out);
    if (invented.length) {
      throw new Error(`Script still contains invented detail after retry: ${invented.join(', ')}`);
    }
  }

  // Trust the model's wording, never its arithmetic: the hook number comes from
  // our computed candidate, not from anything the model wrote.
  const chosen = candidates.find((c) => c.key === out.hookKey) || candidates[0];
  if (!chosen) throw new Error('No verifiable hook stat available for this match');

  const variant = SCENE_ORDERS[out.variant] ? out.variant : 'hookFirst';

  return {
    variant,
    hook: { label: chosen.label, value: chosen.value, caption: out.hookCaption || '' },
    verdict: out.verdict || '',
    table: {
      position: match.table?.position || '—',
      points: match.table?.points || '—',
      detail: out.tableDetail || '',
    },
    lines: toLines(variant, out.narration),
    youtubeTitle: out.youtubeTitle || '',
    youtubeDescription: out.youtubeDescription || '',
    instagramCaption: out.instagramCaption || '',
  };
}

module.exports = { generateVideoScript, hookCandidates, findInvented, SCENE_ORDERS };
