/**
 * Bedrock Agent Core — Action Group Handler
 *
 * This Lambda is invoked by Bedrock Agent Core when the agent decides
 * to use one of our tools. The agent autonomously picks which action
 * to call based on the user's question.
 *
 * Action Groups:
 *   - GetFixtures: upcoming/recent Arsenal matches
 *   - GetStandings: Premier League table
 *   - GetLiveScore: current live match
 *   - GetSquad: Arsenal squad info
 *   - GetNews: latest Arsenal news
 *   - GetPrediction: AI match prediction
 *   - GetMatchSummary: AI post-match summary
 */

const https = require('https');

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const REGION = process.env.AWS_REGION || 'us-east-1';
const ARSENAL_ID = 57;

// ── HTTP helper ────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Bedrock helper ─────────────────────────────────────────────────
async function callBedrock(prompt) {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({ region: REGION });
  const res = await client.send(new InvokeModelCommand({
    modelId: 'amazon.nova-micro-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inferenceConfig: { maxTokens: 400 },
      messages: [{ role: 'user', content: [{ text: prompt }] }],
    }),
  }));
  const body = JSON.parse(new TextDecoder().decode(res.body));
  return body.output?.message?.content?.[0]?.text || '';
}

// ── Football API helper ────────────────────────────────────────────
function footballApi(path) {
  return httpGet(`https://api.football-data.org/v4${path}`, {
    'X-Auth-Token': FOOTBALL_API_KEY,
  });
}

// ── Action implementations ─────────────────────────────────────────

async function getFixtures(params) {
  const limit = params.limit || 10;
  const type = params.type || 'upcoming';
  const competition = (params.competition || '').toUpperCase();

  const statusMap = {
    upcoming: 'SCHEDULED,TIMED',
    recent: 'FINISHED',
    all: 'SCHEDULED,TIMED,FINISHED',
  };
  const status = statusMap[type] || statusMap.upcoming;

  // If specific competition requested
  if (competition === 'CL' || competition === 'UCL' || competition === 'CHAMPIONS LEAGUE') {
    const data = await footballApi(`/teams/${ARSENAL_ID}/matches?competitions=CL&status=${status}&limit=${limit}`);
    return { matches: formatMatches(data.matches) };
  }

  if (competition === 'PL' || competition === 'PREMIER LEAGUE') {
    // Use general endpoint and filter — more reliable than competitions=PL
    const data = await footballApi(`/teams/${ARSENAL_ID}/matches?status=${status}&limit=20`);
    const plOnly = (data.matches || []).filter(m => m.competition.code === 'PL').slice(0, limit);
    return { matches: formatMatches(plOnly) };
  }

  // Default: use general endpoint (most reliable) + CL supplement
  const [generalData, clData] = await Promise.all([
    footballApi(`/teams/${ARSENAL_ID}/matches?status=${status}&limit=${limit}`),
    footballApi(`/teams/${ARSENAL_ID}/matches?competitions=CL&status=${status}&limit=${limit}`),
  ]);

  const seen = new Set();
  const allMatches = [...(generalData.matches || []), ...(clData.matches || [])]
    .filter((m) => {
      const key = `${m.utcDate}-${m.homeTeam.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
    .slice(0, limit);

  return { matches: formatMatches(allMatches) };
}

function formatMatches(matches) {
  return (matches || []).map((m) => ({
    home: m.homeTeam.shortName,
    away: m.awayTeam.shortName,
    date: m.utcDate,
    status: m.status,
    score: m.score?.fullTime?.home != null ? `${m.score.fullTime.home}-${m.score.fullTime.away}` : null,
    competition: m.competition.name,
  }));
}

async function getStandings(params) {
  const league = params.league || 'PL';
  const data = await footballApi(`/competitions/${league}/standings`);
  const table = (data.standings?.[0]?.table || []).map((t) => ({
    position: t.position,
    team: t.team.shortName,
    played: t.playedGames,
    won: t.won,
    drawn: t.draw,
    lost: t.lost,
    points: t.points,
    gd: t.goalDifference,
  }));
  return { league: data.competition?.name, table };
}

async function getLiveScore() {
  const data = await footballApi(`/teams/${ARSENAL_ID}/matches?status=LIVE,IN_PLAY,PAUSED&limit=1`);
  const m = data.matches?.[0];
  if (!m) return { live: false, message: 'No Arsenal match currently live.' };
  return {
    live: true,
    home: m.homeTeam.shortName,
    away: m.awayTeam.shortName,
    homeScore: m.score?.fullTime?.home ?? m.score?.halfTime?.home ?? 0,
    awayScore: m.score?.fullTime?.away ?? m.score?.halfTime?.away ?? 0,
    minute: m.minute,
    competition: m.competition.name,
  };
}

async function getSquad() {
  const data = await footballApi(`/teams/${ARSENAL_ID}`);
  const squad = (data.squad || []).map((p) => ({
    name: p.name,
    position: p.position,
    nationality: p.nationality,
    number: p.shirtNumber,
  }));
  return { team: data.name, coach: data.coach?.name, squad };
}

async function getScorers(params) {
  const league = params.league || 'PL';
  const data = await footballApi(`/competitions/${league}/scorers?limit=20`);
  const scorers = (data.scorers || []).map((s) => ({
    player: s.player.name,
    team: s.team.shortName,
    goals: s.goals,
    assists: s.assists,
    penalties: s.penalties,
  }));
  return { competition: data.competition?.name, scorers };
}

async function getNews() {
  const url = `https://newsdata.io/api/1/latest?apikey=${NEWS_API_KEY}&q=%22Arsenal%20FC%22%20OR%20%22Arsenal%20Football%20Club%22&category=sports&language=en&size=5`;
  const data = await httpGet(url);
  const articles = (data.results || []).map((a) => ({
    title: a.title,
    description: a.description?.slice(0, 200),
    source: a.source_name,
    date: a.pubDate,
    link: a.link,
  }));
  return { articles };
}

async function getPrediction(params) {
  const { home, away, competition, date, recentForm } = params;
  const prompt = `You are an Arsenal FC football analyst. Write a 3-4 sentence match prediction with a predicted score and win/draw/loss percentage.
Rules: Write in third person. Be realistic based on form. Most recent result is listed first.
Next match: ${home} vs ${away}
Competition: ${competition}
Date: ${date}
Last 5 results (most recent first): ${recentForm}
Respond in plain text only.`;
  const text = await callBedrock(prompt);
  return { prediction: text };
}

async function getMatchSummary(params) {
  const { home, away, homeScore, awayScore, competition, date, stage } = params;

  // Fetch league context for richer summaries
  let context = '';
  try {
    if (competition.includes('Premier League') || competition.includes('PL')) {
      const standings = await footballApi('/competitions/PL/standings');
      const table = standings.standings?.[0]?.table || [];
      const arsenal = table.find(t => t.team.id === ARSENAL_ID);
      const top3 = table.slice(0, 3).map(t => `${t.position}. ${t.team.shortName} ${t.points}pts`).join(', ');
      if (arsenal) {
        context = `Arsenal are ${arsenal.position === 1 ? 'TOP of the league' : `${arsenal.position}th in the league`} with ${arsenal.points} points after ${arsenal.playedGames} games. Top 3: ${top3}. ${table[0]?.points - arsenal.points <= 2 ? 'The title race is extremely tight.' : ''}`;
      }
    } else if (competition.includes('Champions League') || competition.includes('CL') || competition.includes('UEFA')) {
      context = stage ? `This is a ${stage} match in the Champions League.` : 'This is a Champions League knockout match.';
      // A draw away from home in CL knockouts is generally a good result
      const arsenalAway = away === 'Arsenal';
      if (arsenalAway && parseInt(homeScore) === parseInt(awayScore)) {
        context += ' An away draw in a CL knockout tie is a strong result heading into the home leg.';
      }
    }
  } catch { /* continue without context */ }

  const prompt = `You are an Arsenal FC match reporter writing for a passionate fan site.

CONTEXT: ${context || 'No additional context available.'}

TASK: Write exactly 2 sentences summarizing this result for Arsenal fans.

RULES:
- Do NOT mention specific goalscorers — you do not have that data
- Use the CONTEXT above to explain what this result MEANS: title race implications, knockout tie advantage, qualification impact
- For Premier League: relate to title race, points gap, games remaining
- For Champions League knockouts: explain the tie situation (home/away leg advantage, aggregate implications)
- Be passionate but factual about the score
- Never use generic phrases like "keeping hopes alive" — be SPECIFIC about the situation

Match: ${home} ${homeScore} - ${awayScore} ${away}
Competition: ${competition}${stage ? ' — ' + stage : ''}
Date: ${date}

Respond in plain text only.`;

  const text = await callBedrock(prompt);
  return { summary: text };
}

// ── Action router ──────────────────────────────────────────────────
const ACTIONS = {
  GetFixtures: getFixtures,
  GetStandings: getStandings,
  GetLiveScore: getLiveScore,
  GetSquad: getSquad,
  GetScorers: getScorers,
  GetNews: getNews,
  GetPrediction: getPrediction,
  GetMatchSummary: getMatchSummary,
};

// ── Lambda handler (Bedrock Agent Core format) ─────────────────────
exports.handler = async (event) => {
  const actionGroup = event.actionGroup;
  const apiPath = event.apiPath;
  const httpMethod = event.httpMethod;
  const params = {};

  // Extract parameters from Agent Core event
  if (event.parameters) {
    event.parameters.forEach((p) => { params[p.name] = p.value; });
  }
  if (event.requestBody?.content?.['application/json']?.properties) {
    event.requestBody.content['application/json'].properties.forEach((p) => {
      params[p.name] = p.value;
    });
  }

  // Map apiPath to action function (e.g. "/GetFixtures" → "GetFixtures")
  const actionName = apiPath.replace(/^\//, '');
  const fn = ACTIONS[actionName];

  if (!fn) {
    return {
      messageVersion: '1.0',
      response: {
        actionGroup,
        apiPath,
        httpMethod,
        httpStatusCode: 400,
        responseBody: {
          'application/json': { body: JSON.stringify({ error: `Unknown action: ${apiPath}` }) },
        },
      },
    };
  }

  try {
    const result = await fn(params);
    return {
      messageVersion: '1.0',
      response: {
        actionGroup,
        apiPath,
        httpMethod,
        httpStatusCode: 200,
        responseBody: {
          'application/json': { body: JSON.stringify(result) },
        },
      },
    };
  } catch (err) {
    return {
      messageVersion: '1.0',
      response: {
        actionGroup,
        apiPath,
        httpMethod,
        httpStatusCode: 500,
        responseBody: {
          'application/json': { body: JSON.stringify({ error: err.message }) },
        },
      },
    };
  }
};
