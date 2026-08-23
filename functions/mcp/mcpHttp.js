/**
 * The Gooners World — Remote MCP Server (Streamable HTTP, stateless)
 *
 * Exposes the shared Arsenal tool layer (functions/agent/arsenalTools.js) over
 * HTTP so a remote MCP client — Claude's custom connectors, Claude Code, the MCP
 * Inspector — can reach it by URL, no local install.
 *
 * Transport: MCP Streamable HTTP in STATELESS mode. Each POST carries a JSON-RPC
 * message (or batch); we answer inline. No sessions, no SSE — every tool call is
 * independent, which fits Lambda perfectly.
 *
 * Auth: routed with `private: true` in serverless.yml, so API Gateway enforces the
 * `x-api-key` header and applies the usage plan (quota + throttle) for free.
 *
 * The LLM reasoning happens in the *client's* Claude — this server only returns
 * raw football data, so there is no Bedrock cost on this path.
 */

const { TOOLS, TOOLS_BY_NAME } = require('../agent/arsenalTools');

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'gooners-world', version: '1.0.0' };

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');

// ── short-lived server-side cache ──────────────────────────────────
// Shields football-data.org (which rate-limits) when several clients call the
// same tool. Lives in the warm Lambda container; TTL per tool below.
const CACHE_TTL = {
  GetStandings: 15 * 60_000,
  GetScorers: 30 * 60_000,
  GetSquad: 30 * 60_000,
  GetFixtures: 15 * 60_000,
  GetLiveScore: 30_000,
  GetNews: 30 * 60_000,
  GetPrediction: 15 * 60_000,
  GetMatchSummary: 15 * 60_000,
  GetHeadToHead: 15 * 60_000,
  GetPlayerStats: 15 * 60_000,
};
const cache = new Map();

async function runTool(name, args) {
  const tool = TOOLS_BY_NAME[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  const key = `${name}:${JSON.stringify(args || {})}`;
  const ttl = CACHE_TTL[name] ?? 0;
  const hit = cache.get(key);
  if (hit && ttl && Date.now() - hit.ts < ttl) return hit.data;

  const data = await tool.handler(args || {});
  if (ttl) cache.set(key, { data, ts: Date.now() });
  return data;
}

// ── JSON-RPC helpers ───────────────────────────────────────────────
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        };

      // Notifications — acknowledged with no response body.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case 'tools/call': {
        if (!params?.name || !TOOLS_BY_NAME[params.name]) {
          return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
        }
        const data = await runTool(params.name, params.arguments);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] },
        };
      }

      default:
        return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return isNotification ? null : rpcError(id, -32603, err.message);
  }
}

// ── Lambda handler ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] || '*');
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, mcp-session-id, mcp-protocol-version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 200, headers, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) };
  }

  // JSON-RPC allows a single message or a batch (array).
  if (Array.isArray(payload)) {
    const responses = (await Promise.all(payload.map(handleRpc))).filter(Boolean);
    // A batch of only notifications yields no responses → 202 Accepted.
    if (responses.length === 0) return { statusCode: 202, headers, body: '' };
    return { statusCode: 200, headers, body: JSON.stringify(responses) };
  }

  const response = await handleRpc(payload);
  if (response === null) return { statusCode: 202, headers, body: '' };
  return { statusCode: 200, headers, body: JSON.stringify(response) };
};
