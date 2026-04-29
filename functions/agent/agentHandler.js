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

  // If specific competition requested, query just that
  if (competition === 'CL' || competition === 'UCL' || competition === 'CHAMPIONS LEAGUE') {
    const data = await footballApi(`/teams/${ARSENAL_ID}/matches?competitions=CL&status=${status}&limit=${limit}`);
    return { matches: formatMatches(data.matches) };
  }

  if (competition === 'PL' || competition === 'PREMIER LEAGUE') {
    const data = await footballApi(`/teams/${ARSENAL_ID}/matches?competitions=PL&status=${status}&limit=${limit}`);
    return { matches: formatMatches(data.matches) };
  }

  // Default: fetch PL + CL and merge
  const [plData, clData] = await Promise.all([
    footballApi(`/teams/${ARSENAL_ID}/matches?status=${status}&limit=${limit}`),
    footballApi(`/teams/${ARSENAL_ID}/matches?competitions=CL&status=${status}&limit=${limit}`),
  ]);

  const seen = new Set();
  const allMatches = [...(plData.matches || []), ...(clData.matches || [])]
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
  const { home, away, homeScore, awayScore, competition, date } = params;
  const prompt = `You are an Arsenal FC match reporter. Write exactly 2 sentences summarizing this result for Arsenal fans.
Rules: Do NOT mention specific goalscorers. Focus on what the result means (league position, qualification, momentum).
Match: ${home} ${homeScore} - ${awayScore} ${away}
Competition: ${competition}
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
