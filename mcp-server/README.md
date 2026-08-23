# The Gooners World — MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
live Arsenal FC data as tools to any MCP client — Claude Desktop, Claude Code, or
your own agent. Ask natural questions and Claude calls the right tool:

> "What's Arsenal's next match?" → `GetFixtures`
> "Where are Arsenal in the table?" → `GetStandings`
> "How many goals has Saka scored this season?" → `GetPlayerStats`

## Why this exists

The Gooners World backend already powers a Bedrock Agent with ten Arsenal tools.
Those tools live in a single shared layer — [`functions/agent/arsenalTools.js`](../functions/agent/arsenalTools.js) —
and this MCP server exposes **the exact same handlers** over stdio.

```
                    ┌──────────────────────────────┐
                    │  arsenalTools.js (10 tools)  │   ← single source of truth
                    └───────────────┬──────────────┘
              HTTP action groups    │    stdio (MCP)
        ┌───────────────────────────┴───────────────────────────┐
        ▼                                                        ▼
  Bedrock Agent Core                                     MCP clients
  (the chat widget on the site)                    (Claude Desktop, etc.)
```

One tool layer, two consumers — no duplicated logic.

## Tools

| Tool | What it returns |
|------|-----------------|
| `GetFixtures` | Upcoming / recent Arsenal matches (all competitions); first is `NEXT MATCH` |
| `GetStandings` | Premier League or Champions League table + Arsenal's position |
| `GetScorers` | Top scorers + Arsenal's top scorer |
| `GetLiveScore` | Current live match score, if one is in play |
| `GetSquad` | Full squad + head coach |
| `GetNews` | Latest Arsenal news headlines |
| `GetPrediction` | Next match + recent form (for prediction) |
| `GetMatchSummary` | Most recent result + league context (for summary) |
| `GetHeadToHead` | Arsenal's results vs a given opponent this season |
| `GetPlayerStats` | Profile + PL stats for a specific Arsenal player |

## Two ways to run it

| | Local (stdio) | Remote (hosted HTTP) |
|---|---|---|
| Code | `mcp-server/server.js` | `functions/mcp/mcpHttp.js` (Lambda) |
| Transport | stdio | Streamable HTTP (stateless) |
| Who it's for | developers on this machine | anyone, by URL — recruiters |
| Setup | clone + `npm install` + keys | none — just a URL + key |
| Secrets | in the client's env block | stay server-side in SSM |

Both expose the **same ten tools** from the same shared layer.

---

## Try it remotely (no install)

The server is hosted on AWS (API Gateway → Lambda) and exposes **two** routes:

| Route | Auth | Use it for |
|-------|------|-----------|
| `/dev/mcp-public` | none | the "paste a URL and connect" demo — reviewers |
| `/dev/mcp` | `x-api-key` header | real / keyed clients |

Either way, no repo, no install, no local keys — the football-data.org / NewsData
secrets never leave the server, and the Lambda caches responses to protect the
upstream. There is **no LLM cost on this path**: the reasoning runs in *your*
Claude; the server only returns raw Arsenal data.

### Option 1 — Custom connector in Claude (easiest)

Claude's connector UI authenticates by URL alone (no header field), so point it
at the public route and it connects instantly:

1. Claude → **Settings → Connectors → Add custom connector**
2. **URL:** `https://<api-id>.execute-api.us-east-1.amazonaws.com/dev/mcp-public`
3. **Connect** → the ten `gooners-world` tools appear.

Now ask *"What's Arsenal's next match?"* and Claude calls `GetFixtures`.

### Option 2 — MCP Inspector (30-second self-serve for engineers)

```bash
npx @modelcontextprotocol/inspector
```

In the browser UI that opens:
- **Transport:** `Streamable HTTP`
- **URL:** `https://<api-id>.execute-api.us-east-1.amazonaws.com/dev/mcp-public`
- **Connect → List Tools** (all 10) → run `GetStandings` → live Arsenal table.

### Option 3 — Keyed route via `mcp-remote` (Claude Desktop, header auth)

To use the authenticated `/mcp` route from Claude Desktop, bridge it with
`mcp-remote` (it injects the header the connector UI can't):

```json
{
  "mcpServers": {
    "gooners-world": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<api-id>.execute-api.us-east-1.amazonaws.com/dev/mcp",
        "--header", "x-api-key:${GOONERS_KEY}",
        "--transport", "http-only"
      ],
      "env": { "GOONERS_KEY": "<your-recruiter-key>" }
    }
  }
}
```

---

## Local setup (stdio)

```bash
cd mcp-server
npm install
```

You need two API keys (the same ones the backend uses):
- `FOOTBALL_API_KEY` — [football-data.org](https://www.football-data.org)
- `NEWS_API_KEY` — [newsdata.io](https://newsdata.io)

### Connect to Claude Desktop

Add this to your Claude Desktop config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gooners-world": {
      "command": "node",
      "args": ["/absolute/path/to/the-gooners-world-api/mcp-server/server.js"],
      "env": {
        "FOOTBALL_API_KEY": "your-football-data-key",
        "NEWS_API_KEY": "your-newsdata-key"
      }
    }
  }
}
```

Restart Claude Desktop. You'll see the `gooners-world` tools appear (the 🔨 icon),
and you can ask Arsenal questions in plain English.

### Run standalone (for testing)

```bash
FOOTBALL_API_KEY=... NEWS_API_KEY=... node server.js
```

The server speaks MCP over stdio — it waits for a client to connect. Use the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) to poke at it:

```bash
FOOTBALL_API_KEY=... NEWS_API_KEY=... npx @modelcontextprotocol/inspector node server.js
```

## Notes

- **Transport:** stdio (the standard for local MCP servers).
- **Runtime:** Node.js ≥ 18, ESM. Imports the CommonJS tool layer via `createRequire`.
- **No secrets in code** — keys come from the client's `env` block.
