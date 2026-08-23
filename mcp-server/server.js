#!/usr/bin/env node
/**
 * The Gooners World — MCP Server
 *
 * Exposes the same ten Arsenal FC tools that power the Bedrock Agent
 * (functions/agent/arsenalTools.js) to any MCP client over stdio.
 *
 * Connect it to Claude Desktop (or any MCP host) and ask things like:
 *   "What's Arsenal's next match?"  →  GetFixtures
 *   "Where are Arsenal in the table?"  →  GetStandings
 *   "How many goals has Saka scored?"  →  GetPlayerStats
 *
 * One tool layer, two consumers: the Bedrock Agent reaches the tools over HTTP
 * action groups; this server reaches the exact same handlers over stdio.
 *
 * Env required: FOOTBALL_API_KEY, NEWS_API_KEY
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';

// arsenalTools.js is CommonJS (shared with the Lambda); import it via require.
const require = createRequire(import.meta.url);
const { TOOLS, TOOLS_BY_NAME } = require('../functions/agent/arsenalTools.js');

if (!process.env.FOOTBALL_API_KEY || !process.env.NEWS_API_KEY) {
  console.error(
    '[gooners-world-mcp] Warning: FOOTBALL_API_KEY / NEWS_API_KEY not set. ' +
    'Tool calls that need them will fail. Set them in the MCP client config env block.'
  );
}

const server = new Server(
  { name: 'gooners-world', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Advertise the tool surface, derived directly from the shared registry.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

// Route a tool call to the shared handler and return its JSON as text content.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS_BY_NAME[name];

  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
  }

  try {
    const result = await tool.handler(args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error running ${name}: ${err.message}` }],
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[gooners-world-mcp] running on stdio — 10 Arsenal tools ready');
}

main().catch((err) => {
  console.error('[gooners-world-mcp] fatal:', err);
  process.exit(1);
});
