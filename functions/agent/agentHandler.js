/**
 * Bedrock Agent Core — Action Group Handler
 *
 * Invoked by the Bedrock Agent (Claude Sonnet) when it selects a tool.
 * Each action returns structured raw data — Sonnet synthesises the final response.
 *
 * Action Groups:
 *   - GetFixtures      upcoming/recent Arsenal matches across all competitions
 *   - GetStandings     Premier League or Champions League table
 *   - GetScorers       top scorers in a competition
 *   - GetLiveScore     current live match score
 *   - GetSquad         Arsenal squad and coach
 *   - GetNews          latest Arsenal news headlines
 *   - GetPrediction    upcoming match data + recent form for Sonnet to predict
 *   - GetMatchSummary  completed match result + standings context for Sonnet to summarise
 */

const https = require('https');

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
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

function footballApi(path) {
  return httpGet(`https://api.football-data.org/v4${path}`, { 'X-Auth-Token': FOOTBALL_API_KEY });
}

// ── Action implementations ─────────────────────────────────────────

async function getFixtures(params) {
  const limit = parseInt(params.limit) || 10;
  const type = params.type || 'upcoming';

  const statusMap = {
    upcoming: 'SCHEDULED,TIMED',
    recent: 'FINISHED',
    all: 'SCHEDULED,TIMED,FINISHED',
  };
  const status = statusMap[type] || statusMap.upcoming;

  // Always return all competitions sorted chronologically — never filter
  // by competition here. The agent reads the competition field per match
  // and can answer competition-specific questions from the full sorted list.
  // This ensures the chronologically nearest match is always first.
  const [generalData, clData] = await Promise.all([
    footballApi(`/teams/${ARSENAL_ID}/matches?status=${status}&limit=20`),
    footballApi(`/teams/${ARSENAL_ID}/matches?competitions=CL&status=${status}&limit=10`),
  ]);

  const seen = new Set();
  const sortFn = type === 'recent'
    ? (a, b) => new Date(b.utcDate) - new Date(a.utcDate)
    : (a, b) => new Date(a.utcDate) - new Date(b.utcDate);

  const allMatches = [...(generalData.matches || []), ...(clData.matches || [])]
    .filter((m) => {
      const key = `${m.utcDate}-${m.homeTeam.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(sortFn)
    .slice(0, limit);

  return { matches: formatMatches(allMatches, type) };
}

function formatMatches(matches, type) {
  return (matches || []).map((m, i) => ({
    label: type === 'upcoming' && i === 0 ? 'NEXT MATCH' : `Match ${i + 1}`,
    home: m.homeTeam.shortName,
    away: m.awayTeam.shortName,
    date: m.utcDate,
    status: m.status,
    score: m.score?.fullTime?.home != null ? `${m.score.fullTime.home}-${m.score.fullTime.away}` : null,
    competition: m.competition.name,
    stage: m.stage || null,
  }));
}

async function getStandings(params) {
  const league = (params.league || 'PL').toUpperCase();
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
  const arsenal = table.find(t => t.team === 'Arsenal');
  return { league: data.competition?.name, table, arsenalPosition: arsenal?.position };
}

async function getScorers(params) {
  const league = (params.league || 'PL').toUpperCase();
  const data = await footballApi(`/competitions/${league}/scorers?limit=20`);
  const scorers = (data.scorers || []).map((s) => ({
    player: s.player.name,
    team: s.team.shortName,
    goals: s.goals,
    assists: s.assists || 0,
    penalties: s.penalties || 0,
  }));
  const arsenalTop = scorers.find(s => s.team === 'Arsenal');
  return { competition: data.competition?.name, scorers, arsenalTopScorer: arsenalTop || null };
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
    minute: m.minute || null,
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

async function getNews() {
  const url = `https://newsdata.io/api/1/latest?apikey=${NEWS_API_KEY}&q=%22Arsenal%20FC%22%20OR%20%22Arsenal%20Football%20Club%22&category=sports&language=en&size=5`;
  const data = await httpGet(url);
  const articles = (data.results || []).map((a) => ({
    title: a.title,
    description: a.description?.slice(0, 200),
    source: a.source_name,
    date: a.pubDate,
  }));
  return { articles };
}

async function getPrediction(params) {
  // Returns structured match data for Sonnet to reason over and predict
  const [upcomingData, recentData] = await Promise.all([
    footballApi(`/teams/${ARSENAL_ID}/matches?status=SCHEDULED,TIMED&limit=3`),
    footballApi(`/teams/${ARSENAL_ID}/matches?status=FINISHED&limit=5`),
  ]);

  const upcoming = (upcomingData.matches || [])[0];
  if (!upcoming) return { error: 'No upcoming match found.' };

  const recentForm = (recentData.matches || []).map(m => {
    const isHome = m.homeTeam.id === ARSENAL_ID;
    const gs = isHome ? m.score?.fullTime?.home : m.score?.fullTime?.away;
    const gc = isHome ? m.score?.fullTime?.away : m.score?.fullTime?.home;
    const result = gs > gc ? 'W' : gs < gc ? 'L' : 'D';
    return `${result} ${m.homeTeam.shortName} ${m.score?.fullTime?.home}-${m.score?.fullTime?.away} ${m.awayTeam.shortName} (${m.competition.name})`;
  });

  return {
    nextMatch: {
      home: upcoming.homeTeam.shortName,
      away: upcoming.awayTeam.shortName,
      date: upcoming.utcDate,
      competition: upcoming.competition.name,
      stage: upcoming.stage || null,
    },
    arsenalRecentForm: recentForm,
  };
}

async function getMatchSummary(params) {
  // Returns match result + league context for Sonnet to summarise
  const [recentData, standingsData] = await Promise.all([
    footballApi(`/teams/${ARSENAL_ID}/matches?status=FINISHED&limit=5`),
    footballApi('/competitions/PL/standings').catch(() => null),
  ]);

  const matches = recentData.matches || [];
  const match = matches[0];
  if (!match) return { error: 'No recent match found.' };

  let arsenalStandings = null;
  if (standingsData) {
    const table = standingsData.standings?.[0]?.table || [];
    const entry = table.find(t => t.team.id === ARSENAL_ID);
    if (entry) {
      arsenalStandings = {
        position: entry.position,
        points: entry.points,
        played: entry.playedGames,
        pointsFromTop: table[0].points - entry.points,
      };
    }
  }

  return {
    result: {
      home: match.homeTeam.shortName,
      away: match.awayTeam.shortName,
      homeScore: match.score?.fullTime?.home,
      awayScore: match.score?.fullTime?.away,
      competition: match.competition.name,
      stage: match.stage || null,
      date: match.utcDate,
    },
    arsenalStandings,
  };
}

// ── Action router ──────────────────────────────────────────────────
const ACTIONS = {
  GetFixtures: getFixtures,
  GetStandings: getStandings,
  GetScorers: getScorers,
  GetLiveScore: getLiveScore,
  GetSquad: getSquad,
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

  if (event.parameters) {
    event.parameters.forEach((p) => { params[p.name] = p.value; });
  }
  if (event.requestBody?.content?.['application/json']?.properties) {
    event.requestBody.content['application/json'].properties.forEach((p) => {
      params[p.name] = p.value;
    });
  }

  const actionName = apiPath.replace(/^\//, '');
  console.log(`Agent tool call: ${actionName}`, JSON.stringify(params));
  const fn = ACTIONS[actionName];

  if (!fn) {
    return {
      messageVersion: '1.0',
      response: {
        actionGroup, apiPath, httpMethod,
        httpStatusCode: 400,
        responseBody: { 'application/json': { body: JSON.stringify({ error: `Unknown action: ${apiPath}` }) } },
      },
    };
  }

  try {
    const result = await fn(params);
    return {
      messageVersion: '1.0',
      response: {
        actionGroup, apiPath, httpMethod,
        httpStatusCode: 200,
        responseBody: { 'application/json': { body: JSON.stringify(result) } },
      },
    };
  } catch (err) {
    console.error(`Action ${actionName} error:`, err);
    return {
      messageVersion: '1.0',
      response: {
        actionGroup, apiPath, httpMethod,
        httpStatusCode: 500,
        responseBody: { 'application/json': { body: JSON.stringify({ error: err.message }) } },
      },
    };
  }
};
