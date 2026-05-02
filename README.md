# The Gooners World — Backend API

Serverless backend for [The Gooners World](https://the-gooners-world.web.app), an Arsenal FC fan site with live data, AI-powered features, and an AI chat assistant.

## Endpoints

| Endpoint | Method | Purpose | Upstream |
|---|---|---|---|
| `GET /proxy/football` | GET | Fixtures, standings, scorers, CL, squad, live | football-data.org |
| `GET /proxy/news` | GET | Arsenal news feed | NewsData.io |
| `GET /proxy/ai` | GET | Match predictions & summaries | AWS Bedrock (Nova Micro) |
| `POST /agent/chat` | POST | Arsenal FC AI chat assistant | Bedrock Agent Core (Claude Sonnet) |

### Football Proxy Types (`?type=`)

| `type` | Params | Returns |
|---|---|---|
| `matches` | `?league=PL` | Competition matches (Arsenal scheduled + finished) |
| `standings` | `?league=PL` | League standings table |
| `scorers` | `?league=PL` | Top 20 scorers for competition |
| `cl-matches` | — | Arsenal CL matches (limit 40) |
| `cl-standings` | — | Champions League standings |
| `live` | — | In-play Arsenal match |
| `squad` / `team` | — | Arsenal squad + team info |
| `h2h` | `?matchId=` | Head-to-head for a specific match (last 10) |
| `match` | `?matchId=` | Single match detail |
| `season-compare` | `?season=2024` | Historical season standings |

### AI Proxy Types (`?type=`)

| `type` | Returns |
|---|---|
| `prediction` | Pre-match prediction with score, win %, form-weighted analysis |
| `summary` | Post-match 2-sentence recap, competition-aware, no hallucinated details |

### Agent Chat

`POST /agent/chat` — `{ message: string, sessionId?: string }`

Powered by **Bedrock Agent Core with Claude Sonnet** as the orchestrator. Sonnet autonomously selects which tools to call from the `ArsenalTools` action group, reasons across multiple data sources if needed, and synthesises the final response. Sessions persist for 10 minutes via the `sessionId`.

| Tool | Data source | Used for |
|---|---|---|
| `GetFixtures` | football-data.org | Upcoming and recent matches, all competitions |
| `GetStandings` | football-data.org | PL or CL table |
| `GetScorers` | football-data.org | Top scorers in a competition |
| `GetLiveScore` | football-data.org | Current live match score |
| `GetSquad` | football-data.org | Arsenal squad and coach |
| `GetNews` | NewsData.io | Latest Arsenal headlines |
| `GetPrediction` | football-data.org | Returns upcoming match + recent form; Sonnet writes the prediction |
| `GetMatchSummary` | football-data.org | Returns result + standings context; Sonnet writes the summary |

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 20 on AWS Lambda |
| Framework | Serverless Framework v3 |
| API Gateway | REST API with API key authentication + rate limiting |
| AI — Predictions/Summaries | AWS Bedrock — Amazon Nova Micro |
| AI — Chat orchestrator | AWS Bedrock Agent Core — Claude Sonnet (`claude-sonnet-4-5`) |
| Secrets | AWS SSM Parameter Store (SecureString) + GitHub Actions Secrets |
| CI/CD | GitHub Actions (auto-deploy on push to main) |

## Architecture

```
Frontend Apps (Firebase Hosting)
    ↓  x-api-key header (API Gateway auth)
API Gateway  —  1,000 req/day quota, 10 rps sustained, 15 burst
    ↓
Lambda Functions
    ├── footballProxy ──────────────────────→ football-data.org
    ├── newsProxy ──────────────────────────→ NewsData.io
    ├── aiProxy ────────────────────────────→ AWS Bedrock (Nova Micro)
    │                                          predictions & summaries
    ├── agentChat ──────────────────────────→ Bedrock Agent Core
    │                                          Claude Sonnet orchestrates tool calls
    │                                          multi-step reasoning across data sources
    └── agentHandler (action group handler)
            ├── GetFixtures  ───────────────→ football-data.org
            ├── GetStandings ───────────────→ football-data.org
            ├── GetScorers   ───────────────→ football-data.org
            ├── GetLiveScore ───────────────→ football-data.org
            ├── GetSquad     ───────────────→ football-data.org
            ├── GetNews      ───────────────→ NewsData.io
            ├── GetPrediction ──────────────→ football-data.org (raw data → Sonnet predicts)
            └── GetMatchSummary ────────────→ football-data.org (raw data → Sonnet summarises)

IAM — Lambda execution role
    ├── bedrock:InvokeModel  on arn:aws:bedrock:*::foundation-model/*
    └── bedrock:InvokeAgent  on arn:aws:bedrock:us-east-1:*:agent/*
```

## Secrets & Configuration Reference

All secrets and config values — where they live and how they reach the Lambda.

### AWS SSM Parameter Store

Fetched at deploy time by Serverless Framework and injected as Lambda env vars. Stored as `SecureString`.

| SSM Path | Used by | Description |
|---|---|---|
| `/tgw/football-api-key` | footballProxy, aiProxy, agentHandler | football-data.org API key |
| `/tgw/news-api-key` | newsProxy, agentHandler | NewsData.io API key |

### GitHub Actions Secrets

Used during `serverless deploy` in CI/CD. Go to **GitHub repo → Settings → Secrets and variables → Actions**.

| Secret | Used by | Description |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | Serverless deploy | AWS credentials for deployment |
| `AWS_SECRET_ACCESS_KEY` | Serverless deploy | AWS credentials for deployment |
| `BEDROCK_AGENT_ID` | agentChat Lambda | Bedrock Agent ID (`Q0U07RR09G`) |
| `BEDROCK_AGENT_ALIAS_ID` | agentChat Lambda | Bedrock Agent alias pointing to Sonnet version (`2HVFYQGWR7`) |

### Bedrock Agent (AWS Console)

The agent is managed in **AWS Console → Amazon Bedrock → Agents → arsenal-fc-assistant**.

| Field | Value |
|---|---|
| Agent ID | `Q0U07RR09G` |
| Foundation model | `us.anthropic.claude-sonnet-4-5-20251001-v1:0` |
| Live alias | `live` → `2HVFYQGWR7` → Version 2 (Sonnet) |
| Test alias | `AgentTestAlias` → `TSTALIASID` → DRAFT |
| Action group | `ArsenalTools` → `agentHandler` Lambda |
| Session TTL | 600 seconds |
| Guardrail | Enabled |

> **Note:** If you run `serverless deploy` and the agent chat stops working, check that `BEDROCK_AGENT_ID` and `BEDROCK_AGENT_ALIAS_ID` are set in GitHub Actions secrets — the deploy will overwrite Lambda env vars and fall back to `PLACEHOLDER` if they're missing.

### API Gateway Keys

Managed by Serverless Framework. Two keys are provisioned per stage:

| Key name | Used by |
|---|---|
| `tgw-frontend-dev` | The Gooners World frontend |
| `footbball-app-dev` | FootBBall App (partner) |

Retrieve from **AWS Console → API Gateway → API Keys** or via `aws apigateway get-api-keys --include-values`.

### Local Development

Add a `.env` file in the project root (gitignored):

```
FOOTBALL_API_KEY=...
NEWS_API_KEY=...
ALLOWED_ORIGINS=http://localhost:5173
BEDROCK_AGENT_ID=Q0U07RR09G
BEDROCK_AGENT_ALIAS_ID=2HVFYQGWR7
```

## Security

- **API Key Authentication** — every request requires `x-api-key` header
- **Multiple API Keys** — separate keys per frontend app
- **Rate Limiting** — 1,000 requests/day, 10 req/sec sustained, 15 burst
- **Multi-Origin Validation** — Lambda checks `Origin` header against comma-separated allowlist
- **SSM Secrets** — upstream API keys stored as SecureString, never committed to source
- **Bedrock via IAM** — no external Bedrock key; uses Lambda execution role
- **Chat rate limiting** — in-Lambda per-IP: 60 requests per 10-minute window
- **Bedrock Guardrail** — applied to agent to filter harmful content

## AI Details

### Proxy AI (Nova Micro)
- **Predictions** — weighs most recent results first, separates PL vs CL form, realistic after losses
- **Summaries** — no invented goalscorers, focuses on competition implications (title race, CL progression)
- Third-person voice, competition-aware context for PL, CL, FA Cup, Carabao Cup

### Chat AI (Bedrock Agent Core — Claude Sonnet)
- Sonnet orchestrates tool selection and multi-step reasoning autonomously
- Action group handlers return raw structured data — Sonnet synthesises the final response
- Responses sanitized to strip `<answer>` XML tags and Bedrock knowledge-base artefacts
- Passionate Arsenal fan tone; refer to Arsenal as "we" / "the Gunners"
- Session memory within a 10-minute TTL window via `sessionId`

## Local Development

```bash
npm install
npm run offline
# Reads from .env file (gitignored)
# Runs on http://localhost:3000
```

## Deploy

```bash
# Auto: push to main triggers GitHub Actions
# Manual:
npm run deploy:dev
npm run deploy:prod
```

### Re-provisioning the Bedrock Agent

If the agent needs to be recreated from scratch (e.g. new AWS account):

```bash
# 1. Deploy the stack first so agentHandler Lambda exists
npx serverless deploy

# 2. Run the setup script — creates IAM role, agent, action group, alias
./functions/agent/setup-agent.sh

# 3. Update BEDROCK_AGENT_ID and BEDROCK_AGENT_ALIAS_ID in GitHub Actions secrets
# 4. Redeploy
npx serverless deploy
```

## Cost

| Service | Monthly |
|---|---|
| Lambda (5 functions, ~5K req/month) | $0 |
| API Gateway (~5K req/month) | $0 |
| Bedrock Nova Micro (~500 calls) | ~$0.02 |
| Bedrock Claude Sonnet (~200 chat sessions) | ~$0.30 |
| SSM (2 params) | $0 |
| **Total** | **~$0.32/month** |

## Structure

```
├── serverless.yml                 # Infrastructure, IAM, API Gateway config
├── functions/
│   ├── proxy/
│   │   ├── footballProxy.js       # Fixtures, standings, scorers, CL, squad, live, h2h
│   │   ├── newsProxy.js           # Arsenal news feed
│   │   └── aiProxy.js             # AI predictions & summaries (Bedrock Nova Micro)
│   └── agent/
│       ├── agentChat.js           # Chat endpoint — invokes Bedrock Agent Core (Claude Sonnet)
│       ├── agentHandler.js        # Action group handler — fetches data for agent tools
│       ├── openapi-schema.json    # OpenAPI schema defining the ArsenalTools action group
│       └── setup-agent.sh         # One-time script to provision the Bedrock Agent on AWS
├── .github/workflows/deploy.yml   # CI/CD pipeline
├── .env                           # Local dev secrets (gitignored)
└── package.json
```

## Author

**Bhavik Bhoir** — Full Stack Developer
- GitHub: [@bhavikbhoir](https://github.com/bhavikbhoir)
- LinkedIn: [bhavikbhoir](https://www.linkedin.com/in/bhavikbhoir/)
