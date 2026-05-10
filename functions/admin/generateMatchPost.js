const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const crypto = require('crypto');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');
const ADMIN_KEY = process.env.ADMIN_KEY;
const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const MODEL = 'us.anthropic.claude-sonnet-4-6';

function verifyToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ') || !ADMIN_KEY) return false;
  const [timestamp, hmac] = authHeader.slice(7).split('.');
  if (!timestamp || !hmac) return false;
  if (Math.floor(Date.now() / 1000) - parseInt(timestamp, 10) > 8 * 3600) return false;
  const expected = crypto.createHmac('sha256', ADMIN_KEY).update(timestamp).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex')); }
  catch { return false; }
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const isAllowed = !origin || ALLOWED_ORIGINS.some((o) => o.trim() === origin);
  const corsOrigin = isAllowed ? (origin || ALLOWED_ORIGINS[0]) : ALLOWED_ORIGINS[0];
  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!verifyToken(authHeader)) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { home, homeScore, awayScore, away, competition, date, stage, recentForm } = body;

    const isArsenalHome = home === 'Arsenal' || home === 'Arsenal FC';
    const arsenalScore = isArsenalHome ? homeScore : awayScore;
    const oppScore = isArsenalHome ? awayScore : homeScore;
    const opponent = isArsenalHome ? away : home;
    const outcome = arsenalScore > oppScore ? 'win' : arsenalScore === oppScore ? 'draw' : 'loss';
    const compLabel = stage && stage !== 'REGULAR_SEASON' ? `${competition} · ${stage.replace(/_/g, ' ')}` : competition;
    const dateLabel = new Date(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const prompt = `You are the social media voice for The Gooners World, an Arsenal FC fan site with Instagram @thegoonersworld and X @TheGoonersWorld.

Match result:
- Arsenal ${arsenalScore}–${oppScore} ${opponent}
- Competition: ${compLabel}
- Date: ${dateLabel}
- Outcome: Arsenal ${outcome}
- Arsenal recent form (last 5, most recent first): ${recentForm || 'N/A'}

Generate two posts using EXACTLY these formats:

INSTAGRAM (fill in the [...] sections only, keep everything else verbatim):
FULL TIME 🔴⚪

Arsenal ${arsenalScore} – ${oppScore} ${opponent}
${compLabel} · ${dateLabel}

━━━━━━━━━━━━━━━
[2-3 sentences: key moment of the match, standout performer, what this result means for Arsenal's season. Passionate fan voice — real, not generic.]
━━━━━━━━━━━━━━━

The Gooners World 🔫
#Arsenal #Gunners #COYG [2-4 relevant hashtags for competition/opponent]

X (strict ≤280 characters total including hashtags):
FT: Arsenal ${arsenalScore}–${oppScore} ${opponent} 🔴⚪

[One punchy memorable line about the match]

[One line — raw emotion or season significance]

#Arsenal #COYG [1 extra relevant hashtag]

Tone rules:
- Win: celebratory but grounded, not hyperbolic
- Draw: honest, find what worked or what frustrated
- Loss: honest and real, no doom, trust in the squad

Respond with ONLY valid JSON, no explanation before or after:
{"instagram":"...","x":"..."}`;

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
    const posts = JSON.parse(jsonMatch[0]);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(posts),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
