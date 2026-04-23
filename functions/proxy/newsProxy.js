const https = require('https');

const API_KEY = process.env.NEWS_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const BASE = 'https://newsdata.io/api/1/latest';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
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
    const params = new URLSearchParams({
      apikey: API_KEY,
      q: '"Arsenal FC" OR "Arsenal Football Club"',
      category: 'sports',
      language: 'en',
      size: '10',
    });

    const res = await fetch(`${BASE}?${params}`);

    return {
      statusCode: res.status,
      headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=1800' },
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
