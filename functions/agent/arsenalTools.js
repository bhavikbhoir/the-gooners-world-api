/**
 * Arsenal FC Tool Layer — single source of truth
 *
 * Ten data tools over football-data.org + NewsData.io. Consumed by TWO clients:
 *   1. Bedrock Agent Core  → functions/agent/agentHandler.js (HTTP action groups)
 *   2. MCP server          → mcp-server/server.js (stdio, Model Context Protocol)
 *
 * Each tool is defined once here with { name, description, inputSchema, handler }.
 * Both consumers derive their surface from the exported TOOLS registry, so the
 * Arsenal capabilities stay identical across the agent and MCP without duplication.
 *
 * Env required: FOOTBALL_API_KEY, NEWS_API_KEY
 */

const https = require('https');

const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const ARSENAL_ID = 57;

// ── HTTP helpers ───────────────────────────────────────────────────
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

// ── Tool implementations ───────────────────────────────────────────

// ISO date (YYYY-MM-DD) offset from now — used for fixture date windows.
function isoDate(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

async function getFixtures(params = {}) {
  const limit = parseInt(params.limit) || 10;
  const type = params.type || 'upcoming';

  const statusMap = {
    upcoming: 'SCHEDULED,TIMED',
    recent: 'FINISHED',
    all: 'SCHEDULED,TIMED,FINISHED',
  };
  const status = statusMap[type] || statusMap.upcoming;

  // Use a date window, NOT `limit=N`. On /teams/{id}/matches, football-data.org
  // applies limit to the SEASON TAIL (last N), so the true next match gets cut.
  // upcoming: today → +120d · recent: -120d → today · all: -120d → +120d
  const from = type === 'upcoming' ? isoDate(0) : isoDate(-120);
  const to = type === 'recent' ? isoDate(0) : isoDate(120);
  const window = `dateFrom=${from}&dateTo=${to}`;

  const [generalData, clData] = await Promise.all([
    footballApi(`/teams/${ARSENAL_ID}/matches?status=${status}&${window}`),
    footballApi(`/teams/${ARSENAL_ID}/matches?competitions=CL&status=${status}&${window}`),
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

async function getStandings(params = {}) {
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

async function getScorers(params = {}) {
  const league = (params.league || 'PL').toUpperCase();
  const data = await footballApi(`/competitions/${league}/scorers?limit=20`);
  const scorers = (data.scorers || []).map((s) => ({
    player: s.player.name,
    team: s.team.shortName,
    goals: s.goals,
    assists: s.assists || 0,
    penalties: s.penalties || 0,
  }));
  const arsenalScorers = scorers.filter(s => s.team === 'Arsenal');
  return {
    competition: data.competition?.name,
    scorers,
    arsenalTopScorer: arsenalScorers[0] || null,
    arsenalScorers,
  };
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
  const url = `https://newsdata.io/api/1/latest?apikey=${NEWS_API_KEY}&q=%22Arsenal%22&category=sports&language=en&size=10`;
  const data = await httpGet(url);
  const articles = (data.results || [])
    .filter((a) => {
      if (!a.title) return false;
      if (/\bwag\b|\btwerk\b/i.test(a.title)) return false;
      if (/^(Premier League|Bundesliga|La Liga|Serie A|Ligue 1):/i.test(a.title) && !/arsenal|gunners/i.test(a.title)) return false;
      if (a.description && a.description.trim() === a.title.trim()) return false;
      return true;
    })
    .slice(0, 5)
    .map((a) => ({
      title: a.title,
      description: a.description?.slice(0, 200),
      source: a.source_name,
      date: a.pubDate,
    }));
  return { articles };
}

async function getPrediction() {
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

async function getMatchSummary() {
  const recentData = await footballApi(`/teams/${ARSENAL_ID}/matches?status=FINISHED&limit=5`);
  const matches = recentData.matches || [];
  const match = matches[0];
  if (!match) return { error: 'No recent match found.' };

  const competition = match.competition.name;
  const isPL = competition.includes('Premier League');
  const isCL = competition.includes('Champions League') || competition.includes('UEFA');

  let leagueContext = null;
  if (isPL) {
    const standingsData = await footballApi('/competitions/PL/standings').catch(() => null);
    if (standingsData) {
      const table = standingsData.standings?.[0]?.table || [];
      const entry = table.find(t => t.team.id === ARSENAL_ID);
      if (entry) {
        const gamesRemaining = 38 - entry.playedGames;
        const emphasiseGamesRemaining =
          gamesRemaining <= 8 &&
          entry.position <= 3 &&
          (table[0].points - entry.points) <= 8;
        leagueContext = {
          position: entry.position,
          points: entry.points,
          played: entry.playedGames,
          gamesRemaining,
          pointsFromTop: table[0].points - entry.points,
          emphasiseGamesRemaining,
          top5: table.slice(0, 5).map(t => ({
            position: t.position,
            team: t.team.shortName,
            points: t.points,
            played: t.playedGames,
            gamesRemaining: 38 - t.playedGames,
          })),
        };
      }
    }
  }

  let competitionContext = null;
  if (isCL) {
    const stage = match.stage || '';
    const isKnockout = stage && !stage.toUpperCase().includes('LEAGUE') && !stage.toUpperCase().includes('GROUP');
    const arsenalAway = match.awayTeam.id === ARSENAL_ID;
    const homeScore = match.score?.fullTime?.home;
    const awayScore = match.score?.fullTime?.away;
    competitionContext = {
      stage: stage || 'Champions League',
      isKnockout: !!isKnockout,
      awayDraw: !!(isKnockout && arsenalAway && homeScore === awayScore),
    };
  }

  return {
    result: {
      home: match.homeTeam.shortName,
      away: match.awayTeam.shortName,
      homeScore: match.score?.fullTime?.home,
      awayScore: match.score?.fullTime?.away,
      competition,
      stage: match.stage || null,
      date: match.utcDate,
    },
    leagueContext,
    competitionContext,
  };
}

async function getHeadToHead(params = {}) {
  const opponent = (params.opponent || '').toLowerCase().trim();
  if (!opponent) return { matches: [], message: 'Please specify an opponent team name.' };

  const data = await footballApi(`/teams/${ARSENAL_ID}/matches?status=FINISHED&limit=38`);
  const matches = (data.matches || []).filter((m) => {
    const home = `${m.homeTeam.name} ${m.homeTeam.shortName}`.toLowerCase();
    const away = `${m.awayTeam.name} ${m.awayTeam.shortName}`.toLowerCase();
    return home.includes(opponent) || away.includes(opponent);
  });

  if (!matches.length) {
    return { matches: [], message: `No finished matches found against "${params.opponent}" this season.` };
  }
  return { matches: formatMatches(matches, 'recent') };
}

async function getPlayerStats(params = {}) {
  const query = (params.name || '').toLowerCase().trim();
  if (!query) return { error: 'Please provide a player name.' };

  const [squadData, scorersData] = await Promise.all([
    footballApi(`/teams/${ARSENAL_ID}`),
    footballApi(`/competitions/PL/scorers?limit=20`),
  ]);

  const player = (squadData.squad || []).find((p) =>
    p.name.toLowerCase().includes(query)
  );

  if (!player) return { found: false, message: `No Arsenal player found matching "${params.name}".` };

  const scorerEntry = (scorersData.scorers || []).find((s) =>
    s.player.name.toLowerCase().includes(query)
  );

  return {
    found: true,
    name: player.name,
    position: player.position || null,
    nationality: player.nationality || null,
    shirtNumber: player.shirtNumber || null,
    age: player.dateOfBirth ? Math.floor((Date.now() - new Date(player.dateOfBirth)) / 31557600000) : null,
    plGoals: scorerEntry?.goals ?? 0,
    plAssists: scorerEntry?.assists ?? 0,
    plPenalties: scorerEntry?.penalties ?? 0,
    inPLScorersList: !!scorerEntry,
  };
}

// ── Tool registry — the single source of truth ─────────────────────
// name: matches the Bedrock Agent apiPath and the MCP tool name.
// inputSchema: JSON Schema (used directly by MCP; documents the agent contract).
const TOOLS = [
  {
    name: 'GetFixtures',
    description: "Arsenal's upcoming or recent matches across all competitions (Premier League, Champions League, cups). The first upcoming match is labelled NEXT MATCH.",
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['upcoming', 'recent', 'all'], description: 'Which matches to return. Default: upcoming.' },
        limit: { type: 'number', description: 'Max matches to return. Default: 10.' },
      },
    },
    handler: getFixtures,
  },
  {
    name: 'GetStandings',
    description: 'The Premier League or Champions League table, with Arsenal\'s position highlighted.',
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', enum: ['PL', 'CL'], description: 'PL = Premier League, CL = Champions League. Default: PL.' },
      },
    },
    handler: getStandings,
  },
  {
    name: 'GetScorers',
    description: 'Top scorers in a competition, plus Arsenal\'s top scorer and all Arsenal players on the list.',
    inputSchema: {
      type: 'object',
      properties: {
        league: { type: 'string', enum: ['PL', 'CL'], description: 'Competition. Default: PL.' },
      },
    },
    handler: getScorers,
  },
  {
    name: 'GetLiveScore',
    description: 'The current live Arsenal match score, if a match is in play right now.',
    inputSchema: { type: 'object', properties: {} },
    handler: getLiveScore,
  },
  {
    name: 'GetSquad',
    description: 'The full Arsenal squad (players, positions, nationalities, shirt numbers) and the head coach.',
    inputSchema: { type: 'object', properties: {} },
    handler: getSquad,
  },
  {
    name: 'GetNews',
    description: 'The latest Arsenal news headlines, filtered to genuine football content.',
    inputSchema: { type: 'object', properties: {} },
    handler: getNews,
  },
  {
    name: 'GetPrediction',
    description: "Data for Arsenal's next match plus their recent form (last 5 results), for generating a match prediction.",
    inputSchema: { type: 'object', properties: {} },
    handler: getPrediction,
  },
  {
    name: 'GetMatchSummary',
    description: "Arsenal's most recent completed match result with league/competition context, for generating a post-match summary.",
    inputSchema: { type: 'object', properties: {} },
    handler: getMatchSummary,
  },
  {
    name: 'GetHeadToHead',
    description: "Arsenal's results against a specific opponent this season.",
    inputSchema: {
      type: 'object',
      properties: {
        opponent: { type: 'string', description: 'Opponent team name, e.g. "Tottenham" or "Man City".' },
      },
      required: ['opponent'],
    },
    handler: getHeadToHead,
  },
  {
    name: 'GetPlayerStats',
    description: 'Profile and Premier League stats (goals, assists, penalties) for a specific Arsenal player.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Player name or partial name, e.g. "Saka".' },
      },
      required: ['name'],
    },
    handler: getPlayerStats,
  },
];

const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

module.exports = { TOOLS, TOOLS_BY_NAME, ARSENAL_ID };
