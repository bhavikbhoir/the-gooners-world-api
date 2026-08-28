/**
 * Match post copy generation (Claude Sonnet via Bedrock).
 *
 * Single source of truth for social copy — used by the manual admin endpoint
 * AND the autopilot orchestrator. Supports full-time and pre-match posts.
 * Hard rule: never invent goalscorers, tactics, stats, or table positions.
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const MODEL = 'us.anthropic.claude-sonnet-4-6';

function compLabel(competition, stage) {
  return stage && stage !== 'REGULAR_SEASON' ? `${competition} · ${stage.replace(/_/g, ' ')}` : competition;
}
function dateLabel(date) {
  return new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fulltimePrompt(m) {
  const isHome = m.home === 'Arsenal' || m.home === 'Arsenal FC';
  const arsenalScore = isHome ? m.homeScore : m.awayScore;
  const oppScore = isHome ? m.awayScore : m.homeScore;
  const opponent = isHome ? m.away : m.home;
  const outcome = arsenalScore > oppScore ? 'win' : arsenalScore === oppScore ? 'draw' : 'loss';
  const comp = compLabel(m.competition, m.stage);

  return `You are the social media voice for The Gooners World, an Arsenal FC fan site (@thegoonersworld / @TheGoonersWorld).

Match data (use ONLY this — do not invent goalscorers, player names, tactics, positions, points, or games remaining):
- Score: Arsenal ${arsenalScore}–${oppScore} ${opponent}
- Competition: ${comp}
- Date: ${dateLabel(m.date)}
- Outcome: Arsenal ${outcome}
- Arsenal recent form (last 5, most recent first): ${m.recentForm || 'N/A'}

Generate two posts using EXACTLY these formats (fill [...] only, keep other text verbatim):

INSTAGRAM:
Arsenal ${arsenalScore} – ${oppScore} ${opponent} 🔴
${comp} · ${dateLabel(m.date)}

[2-3 sentences on the result and what it means, based only on outcome + form above. Passionate fan voice — real, not generic.]

The Gooners World 🔴
#Arsenal #Gunners #COYG [2-4 relevant hashtags]

X (strict ≤280 chars total incl hashtags):
FT: Arsenal ${arsenalScore}–${oppScore} ${opponent} 🔴

[One punchy line on the result. One line — raw emotion or season significance from the form.]

#Arsenal #COYG [1 extra hashtag]

Tone: Win = celebratory but grounded. Draw = honest. Loss = honest and real, no doom, trust the squad.

Respond with ONLY valid JSON: {"instagram":"...","x":"..."}`;
}

function prematchPrompt(m) {
  const isHome = m.home === 'Arsenal' || m.home === 'Arsenal FC';
  const opponent = isHome ? m.away : m.home;
  const venue = isHome ? 'home' : 'away';
  const comp = compLabel(m.competition, m.stage);

  return `You are the social media voice for The Gooners World, an Arsenal FC fan site (@thegoonersworld / @TheGoonersWorld).

Upcoming match (use ONLY this — do not invent lineups, injuries, tactics, positions, or predicted scores):
- Fixture: Arsenal vs ${opponent} (${venue})
- Competition: ${comp}
- Kickoff: ${dateLabel(m.date)}
- Arsenal recent form (last 5, most recent first): ${m.recentForm || 'N/A'}

Generate two matchday build-up posts (fill [...] only, keep other text verbatim):

INSTAGRAM:
MATCHDAY 🔴
Arsenal vs ${opponent}
${comp} · ${dateLabel(m.date)}

[2-3 sentences of anticipation based only on the fixture + form. Rally the fans. No predicted score, no lineup.]

The Gooners World 🔴
#Arsenal #Gunners #COYG [2-4 relevant hashtags]

X (strict ≤280 chars total incl hashtags):
🔴 MATCHDAY | Arsenal vs ${opponent}
${comp}

[One line of build-up energy based only on the fixture + form.]

#Arsenal #COYG [1 extra hashtag]

Tone: confident, hungry, united — never arrogant, never predict a scoreline.

Respond with ONLY valid JSON: {"instagram":"...","x":"..."}`;
}

async function generateMatchCopy(match) {
  const prompt = match.type === 'prematch' ? prematchPrompt(match) : fulltimePrompt(match);

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  }));

  const raw = JSON.parse(Buffer.from(response.body).toString()).content[0].text.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Model did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

module.exports = { generateMatchCopy, compLabel, dateLabel };
