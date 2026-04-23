const https = require('https');

const API_KEY = process.env.FOOTBALL_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
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
  const corsOrigin = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin',
  };

  if (origin && origin !== ALLOWED_ORIGIN) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const type = event.queryStringParameters?.type || 'matches';
    let url;

    if (type === 'standings') {
      url = `${BASE}/competitions/PL/standings`;
    } else {
      url = `${BASE}/teams/${ARSENAL_ID}/matches?status=SCHEDULED,TIMED,FINISHED&limit=20`;
    }

    const res = await fetch(url, { 'X-Auth-Token': API_KEY });

    return {
      statusCode: res.status,
      headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=900' },
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
