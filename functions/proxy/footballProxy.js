const https = require('https');

const API_KEY = process.env.FOOTBALL_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '').split(',');
const BASE = 'https://api.football-data.org/v4';
const ARSENAL_ID = 57;

function fetch(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const corsOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];
  const corsHeaders = { 'Access-Control-Allow-Origin': corsOrigin, 'Vary': 'Origin' };

  if (origin && !isAllowed) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const type = event.queryStringParameters?.type || 'matches';
    const matchId = event.queryStringParameters?.matchId;
    const season = event.queryStringParameters?.season;
    const league = event.queryStringParameters?.league || 'PL';
    let url, cache;

    switch (type) {
      case 'standings':
        url = `${BASE}/competitions/${league}/standings`;
        cache = 900;
        break;
      case 'cl-standings':
        url = `${BASE}/competitions/CL/standings`;
        cache = 900;
        break;
      case 'cl-matches':
        url = `${BASE}/teams/${ARSENAL_ID}/matches?competitions=CL&status=SCHEDULED,TIMED,FINISHED&limit=40`;
        cache = 900;
        break;
      case 'scorers':
        url = `${BASE}/competitions/${league}/scorers?limit=20`;
        cache = 1800;
        break;
      case 'competition-matches':
        url = `${BASE}/competitions/${league}/matches?matchday=${event.queryStringParameters?.matchday || ''}`;
        cache = 900;
        break;
      case 'matches':
        url = `${BASE}/teams/${ARSENAL_ID}/matches?status=SCHEDULED,TIMED,FINISHED&limit=20`;
        cache = 900;
        break;
      case 'h2h':
        if (!matchId) throw new Error('matchId required');
        url = `${BASE}/matches/${matchId}/head2head?limit=10`;
        cache = 86400;
        break;
      case 'match':
        if (!matchId) throw new Error('matchId required');
        url = `${BASE}/matches/${matchId}`;
        cache = 900;
        break;
      case 'live':
        url = `${BASE}/teams/${ARSENAL_ID}/matches?status=LIVE,IN_PLAY,PAUSED&limit=1`;
        cache = 30;
        break;
      case 'squad':
      case 'team':
        url = `${BASE}/teams/${ARSENAL_ID}`;
        cache = 86400;
        break;
      case 'season-compare':
        url = `${BASE}/competitions/PL/standings?season=${season || 2024}`;
        cache = 86400;
        break;
      default:
        url = `${BASE}/teams/${ARSENAL_ID}/matches?status=SCHEDULED,TIMED,FINISHED&limit=20`;
        cache = 900;
    }

    const res = await fetch(url, { 'X-Auth-Token': API_KEY });

    return {
      statusCode: res.status,
      headers: { ...corsHeaders, 'Cache-Control': `public, max-age=${cache}` },
      body: res.body,
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
