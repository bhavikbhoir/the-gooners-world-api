const https = require('https');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
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
  const corsOrigin = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  const corsHeaders = { 'Access-Control-Allow-Origin': corsOrigin, 'Vary': 'Origin' };

  if (origin && origin !== ALLOWED_ORIGIN) {
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
      prompt = `You are an Arsenal FC match reporter writing for a fan site.

TASK: Write exactly 2 sentences summarizing this match result for Arsenal fans.

RULES:
- Do NOT mention specific goalscorers, assists, or match events — you do not have that data
- Only reference the final score, teams, competition, and result
- Focus on what the result MEANS: league position impact, qualification implications, momentum
- For Champions League: a draw can be a positive result if it secures qualification or progression
- For Premier League: relate to title race, top 4, or relegation battle as appropriate
- For FA Cup / Carabao Cup / other cups: focus on progression to next round
- Be passionate but strictly factual about the score

Match: ${data.home} ${data.homeScore} - ${data.awayScore} ${data.away}
Competition: ${data.competition}
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
