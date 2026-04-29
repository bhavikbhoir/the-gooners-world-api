/**
 * Agent Chat Endpoint
 *
 * Frontend calls POST /agent/chat with { message, sessionId }
 * This invokes the Bedrock Agent and streams back the response.
 */

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');
const AGENT_ID = process.env.BEDROCK_AGENT_ID;
const AGENT_ALIAS_ID = process.env.BEDROCK_AGENT_ALIAS_ID;
const MAX_MSG_LENGTH = 500;
const MAX_REQUESTS_PER_IP = 60; // per 10 minutes

// Simple in-memory rate limiter (resets on cold start — good enough for Lambda)
const ipCounts = {};
const WINDOW_MS = 10 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipCounts[ip] || now - ipCounts[ip].start > WINDOW_MS) {
    ipCounts[ip] = { count: 1, start: now };
    return true;
  }
  ipCounts[ip].count++;
  return ipCounts[ip].count <= MAX_REQUESTS_PER_IP;
}

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Vary': 'Origin',
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const cors = getCorsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (!AGENT_ID || !AGENT_ALIAS_ID) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Agent not configured. Set BEDROCK_AGENT_ID and BEDROCK_AGENT_ALIAS_ID.' }),
    };
  }

  try {
    const ip = event.requestContext?.identity?.sourceIp || 'unknown';

    if (!checkRateLimit(ip)) {
      return { statusCode: 429, headers: cors, body: JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }) };
    }

    const { message, sessionId: incomingSessionId } = JSON.parse(event.body || '{}');

    if (!message) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'message is required' }) };
    }

    if (message.length > MAX_MSG_LENGTH) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: `Message too long. Max ${MAX_MSG_LENGTH} characters.` }) };
    }

    const sessionId = incomingSessionId || `tgw-${Date.now()}`;

    const { BedrockAgentRuntimeClient, InvokeAgentCommand } = await import('@aws-sdk/client-bedrock-agent-runtime');
    const client = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

    const command = new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId,
      inputText: message,
    });

    const response = await client.send(command);

    // Collect streamed response chunks
    let text = '';
    if (response.completion) {
      for await (const chunk of response.completion) {
        if (chunk.chunk?.bytes) {
          text += new TextDecoder().decode(chunk.chunk.bytes);
        }
      }
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ reply: text, sessionId }),
    };
  } catch (err) {
    console.error('Agent chat error:', err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
