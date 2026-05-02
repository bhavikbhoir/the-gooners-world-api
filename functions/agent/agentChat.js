/**
 * Arsenal FC Chat — Bedrock Agent Core
 *
 * Routes user messages to a Bedrock Agent (Claude Sonnet) that autonomously
 * selects tools from the ArsenalTools action group and synthesizes responses.
 */

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');
const AGENT_ID = process.env.BEDROCK_AGENT_ID;
const AGENT_ALIAS_ID = process.env.BEDROCK_AGENT_ALIAS_ID;
const MAX_MSG_LENGTH = 500;

// ── Rate limiter ───────────────────────────────────────────────────
const ipCounts = {};
function checkRate(ip) {
  const now = Date.now();
  if (!ipCounts[ip] || now - ipCounts[ip].start > 600000) { ipCounts[ip] = { count: 1, start: now }; return true; }
  return ++ipCounts[ip].count <= 60;
}

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Headers': 'Content-Type,x-api-key', 'Access-Control-Allow-Methods': 'POST,OPTIONS', 'Vary': 'Origin' };
}

function sanitizeReply(text) {
  return text
    .replace(/<answer>\s*/gi, '')
    .replace(/\s*<\/answer>/gi, '')
    .replace(/^question="[^"]*"\s*/gi, '')
    .replace(/^answer:\s*/gi, '')
    .trim() || "I couldn't find that information right now. Please try again.";
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const headers = cors(origin);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const ip = event.requestContext?.identity?.sourceIp || 'unknown';
  if (!checkRate(ip)) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests.' }) };

  if (!AGENT_ID || !AGENT_ALIAS_ID || AGENT_ID === 'PLACEHOLDER') {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'Chat assistant is not yet configured.' }) };
  }

  try {
    const { message, sessionId: sid } = JSON.parse(event.body || '{}');
    if (!message) return { statusCode: 400, headers, body: JSON.stringify({ error: 'message required' }) };
    if (message.length > MAX_MSG_LENGTH) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Message too long.' }) };

    const sessionId = sid || `tgw-${Date.now()}`;

    const { BedrockAgentRuntimeClient, InvokeAgentCommand } = await import('@aws-sdk/client-bedrock-agent-runtime');
    const client = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

    const response = await client.send(new InvokeAgentCommand({
      agentId: AGENT_ID,
      agentAliasId: AGENT_ALIAS_ID,
      sessionId,
      inputText: message,
    }));

    let text = '';
    for await (const chunk of response.completion) {
      if (chunk.chunk?.bytes) {
        text += new TextDecoder().decode(chunk.chunk.bytes);
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
