/**
 * Agent Chat Endpoint — Bedrock Agent Core
 *
 * Frontend calls POST /agent/chat with { message, sessionId }
 * This invokes the Bedrock Agent which autonomously picks tools and responds.
 */

const https = require('https');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');
const AGENT_ID = process.env.BEDROCK_AGENT_ID;
const AGENT_ALIAS_ID = process.env.BEDROCK_AGENT_ALIAS_ID;
const MAX_MSG_LENGTH = 500;

// Rate limiter
const ipCounts = {};
const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQ = 60;

function checkRate(ip) {
  const now = Date.now();
  if (!ipCounts[ip] || now - ipCounts[ip].start > WINDOW_MS) {
    ipCounts[ip] = { count: 1, start: now };
    return true;
  }
  return ++ipCounts[ip].count <= MAX_REQ;
}

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Headers': 'Content-Type,x-api-key', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Vary': 'Origin' };
}

// Strip Bedrock knowledge-base retrieval artifacts that can leak into
// the agent's final response text (e.g. question="...", answer: ...)
function sanitizeReply(text) {
  const cleaned = text
    .replace(/^question="[^"]*"\s*/gi, '')
    .replace(/^answer:\s*/gi, '')
    .trim();
  return cleaned || "I couldn't find that information right now. Please try again.";
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const headers = cors(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const ip = event.requestContext?.identity?.sourceIp || 'unknown';
  if (!checkRate(ip)) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }) };

  if (!AGENT_ID || !AGENT_ALIAS_ID || AGENT_ID === 'PLACEHOLDER') {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Agent not configured.' }) };
  }

  try {
    const { message, sessionId: incomingSessionId } = JSON.parse(event.body || '{}');

    if (!message) return { statusCode: 400, headers, body: JSON.stringify({ error: 'message required' }) };
    if (message.length > MAX_MSG_LENGTH) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message too long.' }) };

    const sessionId = incomingSessionId || `tgw-${Date.now()}`;

    const { BedrockAgentRuntimeClient, InvokeAgentCommand } = await import('@aws-sdk/client-bedrock-agent-runtime');
    const client = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

    const response = await client.send(new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId,
      inputText: message,
    }));

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
      headers: { ...headers, 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ reply: sanitizeReply(text), sessionId }),
    };
  } catch (err) {
    console.error('Agent chat error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Something went wrong. Please try again.' }) };
  }
};
