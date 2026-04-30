const https = require('https');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '').split(',');
const REGION = process.env.AWS_REGION || 'us-east-1';

async function callBedrock(prompt) {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({ region: REGION });

  const res = await client.send(new InvokeModelCommand({
    modelId: 'amazon.nova-micro-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      inferenceConfig: { maxTokens: 300 },
      messages: [{ role: 'user', content: [{ text: prompt }] }]
    })
  }));

  const body = JSON.parse(new TextDecoder().decode(res.body));
  return body.output?.message?.content?.[0]?.text || '';
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
    const type = event.queryStringParameters?.type;
    const matchData = event.queryStringParameters?.data;

    if (!type || !matchData) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing type or data' }) };
    }

    const data = JSON.parse(decodeURIComponent(matchData));
    let prompt, cache;

    if (type === 'prediction') {
      prompt = `You are an Arsenal FC football analyst writing for a fan site.

TASK: Write a 3-4 sentence match prediction. Include a predicted score and win/draw/loss percentage.

RULES:
- Write in third person. Never say "I predict" or "I think"
- Use phrases like "Arsenal are expected to", "This one looks like", "The Gunners should"
- Focus ONLY on the league form when predicting a league match, and cup form for cup matches
- The most recent result is the FIRST one listed — weight it most heavily
- If Arsenal lost 2 of the last 3, acknowledge poor form — do not predict a dominant win
- Be realistic, not blindly optimistic

Next match: ${data.home} vs ${data.away}
Competition: ${data.competition}
Date: ${data.date}

Last 5 results (MOST RECENT FIRST — first result is the latest):
${data.recentForm}

Respond in plain text only, no markdown.`;
      cache = 3600;
    } else if (type === 'summary') {
      // Fetch standings context for richer summaries
      let context = '';
      try {
        if (!data.competition || data.competition.includes('Premier League')) {
          const standingsRes = await new Promise((resolve, reject) => {
            const req = https.get('https://api.football-data.org/v4/competitions/PL/standings', {
              headers: { 'X-Auth-Token': process.env.FOOTBALL_API_KEY }
            }, (res) => {
              let body = '';
              res.on('data', c => body += c);
              res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
          });
          const table = standingsRes.standings?.[0]?.table || [];
          const arsenal = table.find(t => t.team.id === 57);
          const top3 = table.slice(0, 3).map(t => `${t.position}. ${t.team.shortName} ${t.points}pts`).join(', ');
          if (arsenal) {
            context = `Arsenal are ${arsenal.position === 1 ? 'TOP of the league' : `${arsenal.position}th`} with ${arsenal.points} points after ${arsenal.playedGames} games. Top 3: ${top3}.`;
          }
        } else if (data.competition.includes('Champions') || data.competition.includes('UEFA')) {
          const arsenalAway = data.away === 'Arsenal';
          context = data.stage ? `This is a ${data.stage} match.` : 'This is a Champions League knockout match.';
          if (arsenalAway && data.homeScore === data.awayScore) {
            context += ' An away draw in a CL knockout is a strong result heading into the home leg.';
          }
        }
      } catch { /* continue without context */ }

      prompt = `You are an Arsenal FC match reporter writing for a fan site.

CONTEXT: ${context || 'No additional context.'}

TASK: Write exactly 2 sentences summarizing this match result for Arsenal fans.

RULES:
- Do NOT mention specific goalscorers, assists, or match events — you do not have that data
- Use the CONTEXT to explain what this result MEANS specifically
- For Premier League: mention title race, points gap, games remaining
- For Champions League knockouts: explain tie situation, home/away advantage, aggregate implications
- Be passionate but specific — never use generic phrases like "keeping hopes alive"

Match: ${data.home} ${data.homeScore} - ${data.awayScore} ${data.away}
Competition: ${data.competition}${data.stage ? ' — ' + data.stage : ''}
Date: ${data.date}

Respond in plain text only, no markdown.`;
      cache = 86400;
    } else {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid type' }) };
    }

    const text = await callBedrock(prompt);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Cache-Control': `public, max-age=${cache}` },
      body: JSON.stringify({ text }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
