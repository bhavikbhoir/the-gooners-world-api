const https = require('https');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
const REGION = process.env.AWS_REGION || 'us-east-1';

async function callBedrock(prompt) {
  // Use AWS SDK v3 built into Node 22 Lambda runtime
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({ region: REGION });

  const res = await client.send(new InvokeModelCommand({
    modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  }));

  const body = JSON.parse(new TextDecoder().decode(res.body));
  return body.content?.[0]?.text || '';
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
      prompt = `You are an Arsenal FC football analyst. Based on this data, give a brief match prediction (3-4 sentences max). Include a predicted score and win/draw/loss percentage. Be confident and opinionated.

Next match: ${data.home} vs ${data.away}
Competition: ${data.competition}
Date: ${data.date}
Recent Arsenal form (last 5): ${data.recentForm}

Respond in plain text only, no markdown.`;
      cache = 3600;
    } else if (type === 'summary') {
      prompt = `You are an Arsenal FC match reporter. Write a brief 2-3 sentence match summary for Arsenal fans. Be passionate but factual.

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
