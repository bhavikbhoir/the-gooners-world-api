const https = require('https');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const API_KEY = process.env.NEWS_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '').split(',');
const BASE = 'https://newsdata.io/api/1/latest';
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

const STOP_WORDS = new Set(['the','a','an','in','of','for','on','at','to','and','or','is','are','was','were','has','have','with','as','by','from','its','this','that','how','why','what','who','when','their','our','his','her','been','be','but','not','after','over','about','up']);

function titleFingerprint(title) {
  return title.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function isSameStory(titleA, titleB) {
  const a = new Set(titleFingerprint(titleA));
  const b = new Set(titleFingerprint(titleB));
  if (!a.size || !b.size) return false;
  const overlap = [...a].filter((w) => b.has(w)).length;
  return overlap / Math.min(a.size, b.size) >= 0.6;
}

function deduplicateByStory(articles) {
  const kept = [];
  for (const article of articles) {
    if (!kept.some((k) => isSameStory(k.title, article.title))) kept.push(article);
  }
  return kept;
}

async function curateArticles(articles) {
  if (!articles.length) return articles;
  const titles = articles.map((a, i) => `${i}. ${a.title}`).join('\n');

  try {
    const response = await bedrock.send(new InvokeModelCommand({
      modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `You are a strict content filter for an Arsenal FC football fan site. Return ONLY the indices of articles that are genuinely about Arsenal football.

INCLUDE: match results, fixtures, team news, transfers, injuries, player/manager interviews, tactics, Premier League standings, Champions League, contracts, training ground news.

EXCLUDE (reject any of these):
- Celebrity gossip, WAGs, influencer lifestyle, beauty, fashion, music
- Cultural or social stories only loosely connected to football
- Non-Arsenal match score summaries (e.g. "Man City 3-1 Chelsea")
- Meme culture, social media trends, entertainment
- Articles where Arsenal is a passing mention, not the main subject

Reply with ONLY a JSON array of 0-based indices, nothing else. Example: [0,2,4,7]

${titles}`,
        }],
      }),
    }));

    const text = JSON.parse(Buffer.from(response.body).toString()).content[0].text.trim();
    const match = text.match(/\[[\d,\s]*\]/);
    if (!match) return articles;
    const indices = JSON.parse(match[0]);
    return indices.filter((i) => i >= 0 && i < articles.length).map((i) => articles[i]);
  } catch {
    return articles;
  }
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
    const params = new URLSearchParams({
      apikey: API_KEY,
      q: '"Arsenal FC" OR "Arsenal Football Club"',
      category: 'sports',
      language: 'en',
      size: '10',
    });

    const res = await httpGet(`${BASE}?${params}`);
    if (res.status !== 200) {
      return { statusCode: res.status, headers: corsHeaders, body: res.body };
    }

    const json = JSON.parse(res.body);
    const raw = (json.results || []).filter((a) => a.title);
    const deduped = deduplicateByStory(raw);
    const curated = await curateArticles(deduped);

    const body = JSON.stringify({ ...json, results: curated });
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=1800', 'Content-Type': 'application/json' },
      body,
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
