# The Gooners World — Backend API

Serverless football data and AI backend powering two frontends: [The Gooners World](https://the-gooners-world.web.app) (Arsenal FC fan site) and [FootBBall App](https://the-footbball-app.web.app) (multi-league stats).

[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![AWS Lambda](https://img.shields.io/badge/AWS_Lambda-5_functions-FF9900?logo=awslambda&logoColor=white)](https://aws.amazon.com/lambda/)
[![API Gateway](https://img.shields.io/badge/API_Gateway-REST-FF4F00?logo=amazonapigateway&logoColor=white)](https://aws.amazon.com/api-gateway/)
[![Amazon Bedrock](https://img.shields.io/badge/Amazon_Bedrock-Claude_Sonnet-7B2D8B?logo=amazonaws&logoColor=white)](https://aws.amazon.com/bedrock/)
[![Serverless Framework](https://img.shields.io/badge/Serverless_Framework-v3-FD5750?logo=serverless&logoColor=white)](https://www.serverless.com/)
[![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-CI%2FCD-2088FF?logo=githubactions&logoColor=white)](https://github.com/features/actions)

---

## AI Highlight — Bedrock Agent Core with Claude Sonnet

The standout feature of this backend is a **multi-turn AI chat assistant** built on Amazon Bedrock Agent Core, with Claude Sonnet 4.6 (`claude-sonnet-4-6`) as the orchestrating model.

Rather than a simple prompt-in/response-out pattern, the agent autonomously decides which real-time data tools to call, chains multiple calls when needed, and synthesises a coherent response — all within a single user turn. Sessions persist for 10 minutes via a `sessionId`.

**How a chat request flows:**

```
User: "How do Arsenal's CL chances look after last night's result?"

agentChat Lambda
  └─→ Bedrock Agent Core (Claude Sonnet)
        ├─ Selects: GetMatchSummary  ──→ agentHandler ──→ football-data.org
        ├─ Selects: GetStandings(CL) ──→ agentHandler ──→ football-data.org
        └─ Synthesises final response in passionate Arsenal fan voice
```

The `agentHandler` Lambda returns raw structured data. Claude Sonnet provides all natural language reasoning and response generation — keeping the tool handlers simple, testable, and data-only.

---

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │   Firebase Hosting (2 frontends)     │
                    │  the-gooners-world.web.app           │
                    │  the-footbball-app.web.app           │
                    └─────────────┬───────────────────────┘
                                  │  x-api-key header (per-frontend API keys)
                                  ▼
                    ┌─────────────────────────────────────┐
                    │         API Gateway (REST)           │
                    │  1,000 req/day  |  10 rps sustained  │
                    │  15 burst       |  x-api-key auth    │
                    └──┬──────┬────────┬──────────┬───────┘
                       │      │        │          │
              ┌────────┘  ┌───┘    ┌───┘      ┌───┘
              ▼           ▼        ▼          ▼
    ┌──────────────┐ ┌─────────┐ ┌────────┐ ┌──────────────┐
    │footballProxy │ │newsProxy│ │aiProxy │ │  agentChat   │
    │GET /proxy/   │ │GET /    │ │GET /   │ │POST /agent/  │
    │football      │ │proxy/   │ │proxy/  │ │chat          │
    │              │ │news     │ │ai      │ │              │
    │10 query types│ │         │ │        │ │60 req/10 min │
    └──────┬───────┘ └────┬────┘ └───┬────┘ └──────┬───────┘
           │              │          │              │
           ▼              ▼          ▼              ▼
    football-data.org  NewsData.io  Bedrock      Bedrock
    (v4 REST API)                   Sonnet       Agent Core
                                  (Sonnet 4.6) (Claude Sonnet)
                                                     │
                                                     ▼
                                           ┌──────────────────┐
                                           │  agentHandler    │
                                           │  (action group)  │
                                           │                  │
                                           │  GetFixtures     │──→ football-data.org
                                           │  GetStandings    │──→ football-data.org
                                           │  GetScorers      │──→ football-data.org
                                           │  GetLiveScore    │──→ football-data.org
                                           │  GetSquad        │──→ football-data.org
                                           │  GetNews         │──→ NewsData.io
                                           │  GetPrediction   │──→ football-data.org
                                           │  GetMatchSummary │──→ football-data.org
                                           └──────────────────┘

IAM — Lambda execution role
  ├── bedrock:InvokeModel  on arn:aws:bedrock:*::foundation-model/*
  │                           arn:aws:bedrock:*:*:inference-profile/*
  └── bedrock:InvokeAgent  on arn:aws:bedrock:us-east-1:*:agent/*
                               arn:aws:bedrock:us-east-1:*:agent-alias/*
```

---

## Lambda Functions

| Function | Endpoint | Method | Purpose |
|---|---|---|---|
| `footballProxy` | `/proxy/football` | GET | Proxies football-data.org v4 — fixtures, standings, scorers, live scores, squad, H2H |
| `newsProxy` | `/proxy/news` | GET | Proxies NewsData.io — latest Arsenal news articles |
| `aiProxy` | `/proxy/ai` | GET | Bedrock Sonnet — match predictions and post-match summaries |
| `agentChat` | `/agent/chat` | POST | Bedrock Agent Core entry point — routes messages to Claude Sonnet |
| `agentHandler` | (no HTTP event) | — | Bedrock action group handler — invoked by Claude Sonnet when selecting tools |

### Football Proxy — `?type=` query parameter

| type | Returns | Cache |
|---|---|---|
| `matches` | Arsenal scheduled + finished matches (limit 20) | 15 min |
| `standings` | Full league table (`?league=PL` default) | 15 min |
| `cl-standings` | Champions League standings | 15 min |
| `cl-matches` | Arsenal CL matches (limit 40) | 15 min |
| `scorers` | Top 20 scorers for a competition | 30 min |
| `competition-matches` | All matches in a competition for a matchday | 15 min |
| `live` | Current Arsenal live match score | 30 s |
| `squad` / `team` | Arsenal squad and team info | 24 hr |
| `h2h` | Head-to-head for a specific match (`?matchId=`) | 24 hr |
| `match` | Single match detail (`?matchId=`) | 15 min |
| `season-compare` | Historical PL standings (`?season=2024`) | 24 hr |

### AI Proxy — `?type=` query parameter

| type | Bedrock call | Cache |
|---|---|---|
| `prediction` | 3-4 sentence match prediction with score and win % | 1 hr |
| `summary` | 2-sentence post-match recap with live standings context | 24 hr |

---

## AI Details

### Predictions and Summaries — Claude Sonnet (aiProxy)

Uses `us.anthropic.claude-sonnet-4-6` via `InvokeModel`. Max 500 tokens. Same model as the chat agent — consistent quality and reliable instruction-following across both AI features.

**Prediction rules enforced in the system prompt:**
- Third-person voice; phrases like "Arsenal are expected to" / "The Gunners should"
- Most recent result is weighted first; realistic after poor form
- PL form used for PL matches, cup form for cup matches

**Summary rules enforced in the system prompt:**
- Never invents goalscorers or match events not in the data
- Fetches live PL standings before generating summary to add title race / points context; includes games remaining only when Arsenal are in the run-in and within striking distance
- For CL knockouts: describes what the result means at that stage — does not speculate about further legs

### Chat Assistant — Claude Sonnet via Bedrock Agent Core (agentChat + agentHandler)

Uses `us.anthropic.claude-sonnet-4-6` as the Bedrock Agent foundation model.

**Agent configuration:**

| Field | Value |
|---|---|
| Agent ID | `Q0U07RR09G` |
| Live alias | `2HVFYQGWR7` → Version 2 |
| Action group | `ArsenalTools` (8 tools) |
| Session TTL | 600 seconds |
| Guardrail | Enabled (content filtering) |
| OpenAPI schema | `functions/agent/openapi-schema.json` |

**ArsenalTools action group:**

| Tool | Data source | Agent uses it when... |
|---|---|---|
| `GetFixtures` | football-data.org | User asks about upcoming matches or recent results |
| `GetStandings` | football-data.org | User asks about league table or Arsenal's position |
| `GetScorers` | football-data.org | User asks about top scorers or golden boot |
| `GetLiveScore` | football-data.org | User asks about a live match score |
| `GetSquad` | football-data.org | User asks about players, squad, or the coach |
| `GetNews` | NewsData.io | User asks about transfers, rumours, or off-pitch news |
| `GetPrediction` | football-data.org | User asks for a match prediction |
| `GetMatchSummary` | football-data.org | User asks how a past match went |

Action handlers return raw structured data only. Claude Sonnet generates all natural language output and can chain multiple tool calls to answer complex questions.

**Response sanitization** strips Bedrock-specific artefacts: `<answer>` XML tags, `question="..."` prefixes, `answer:` prefixes.

---

## Security and Reliability

### API Key Authentication

Every HTTP endpoint is `private: true` in API Gateway — all requests require a valid `x-api-key` header. Two separate keys are provisioned per stage (one per frontend), allowing individual key rotation without disrupting the other client.

| API Key | Frontend |
|---|---|
| `tgw-frontend-{stage}` | The Gooners World |
| `footbball-app-{stage}` | FootBBall App |

### Rate Limiting

**API Gateway usage plan** (applied to all endpoints):

| Limit | Value |
|---|---|
| Daily quota | 1,000 requests / day |
| Sustained rate | 10 requests / second |
| Burst | 15 requests |

**In-Lambda per-IP rate limiting** (agentChat only):

| Limit | Value |
|---|---|
| Window | 10 minutes |
| Max requests per IP | 60 |
| Enforcement | Source IP from `requestContext.identity.sourceIp` |

### CORS Validation

CORS is enforced at the Lambda level — not just at API Gateway. Each handler validates the `Origin` header against the `ALLOWED_ORIGINS` env var (comma-separated list). Requests from unlisted origins receive `403 Forbidden`.

Allowed origins (both stages):
```
https://the-gooners-world.web.app
https://the-footbball-app.web.app
```

### Secrets Management

No upstream API keys are committed to source or stored in plaintext.

| Secret | Storage | Delivery |
|---|---|---|
| `FOOTBALL_API_KEY` | AWS SSM `/tgw/football-api-key` (SecureString) | Injected at deploy by Serverless Framework |
| `NEWS_API_KEY` | AWS SSM `/tgw/news-api-key` (SecureString) | Injected at deploy by Serverless Framework |
| `BEDROCK_AGENT_ID` | GitHub Actions secret | Env var on agentChat Lambda |
| `BEDROCK_AGENT_ALIAS_ID` | GitHub Actions secret | Env var on agentChat Lambda |
| AWS credentials | GitHub Actions secrets | Used only during `serverless deploy` |

### Bedrock IAM (no external keys)

Lambda calls Bedrock using the Lambda execution role — no Bedrock API key exists. IAM permissions are scoped to:
- `bedrock:InvokeModel` on foundation model and inference profile ARNs
- `bedrock:InvokeAgent` on agent and agent-alias ARNs in `us-east-1`

---

## CI/CD Pipeline

File: `.github/workflows/deploy.yml`

```
Push to main
    └─→ ubuntu-latest runner
          ├── actions/checkout@v4
          ├── actions/setup-node@v4  (Node 22)
          ├── npm install
          ├── aws-actions/configure-aws-credentials@v4
          └── npx serverless deploy --stage dev

Manual workflow_dispatch
    └─→ Same steps with selectable stage: dev | prod
```

Auto-deploys to `dev` on every push to `main`. Production deploys are triggered manually via the GitHub Actions UI.

---

## Cost Profile

At approximately 5,000 requests/month:

| Service | Estimated monthly cost |
|---|---|
| Lambda (5 functions, ~5K req) | $0 |
| API Gateway (~5K req) | $0 |
| Bedrock Claude Sonnet — predictions/summaries (~30 unique calls/month, cached) | ~$0.20 |
| Bedrock Claude Sonnet — chat sessions (~200 sessions/month) | ~$0.30 |
| SSM Parameter Store (2 params) | $0 |
| **Total** | **~$0.50 / month** |

---

## Local Development

```bash
# Prerequisites: Node.js, AWS credentials configured locally

# Install
npm install

# Create .env in project root
FOOTBALL_API_KEY=your_key_here
NEWS_API_KEY=your_key_here
ALLOWED_ORIGINS=http://localhost:5173
BEDROCK_AGENT_ID=Q0U07RR09G
BEDROCK_AGENT_ALIAS_ID=2HVFYQGWR7

# Run locally (serverless-offline on http://localhost:3000)
npm run offline
```

---

## Deploy

```bash
# Push to main triggers automatic deploy to dev via GitHub Actions

# Manual deploy
npm run deploy:dev   # → npx serverless deploy --stage dev
npm run deploy:prod  # → npx serverless deploy --stage prod
```

### Re-provisioning the Bedrock Agent from scratch

```bash
# 1. Deploy the stack so agentHandler Lambda exists
npx serverless deploy

# 2. Run the setup script (creates IAM role, agent, action group, alias)
./functions/agent/setup-agent.sh

# 3. Update BEDROCK_AGENT_ID and BEDROCK_AGENT_ALIAS_ID in GitHub Actions secrets

# 4. Redeploy so the agentChat Lambda picks up the new values
npx serverless deploy
```

---

## Repository Structure

```
├── serverless.yml                       # Infrastructure: Lambda, API Gateway, IAM, usage plans
├── package.json                         # npm scripts + Serverless Framework devDependencies
├── functions/
│   ├── proxy/
│   │   ├── footballProxy.js             # football-data.org proxy — 10 query types
│   │   ├── newsProxy.js                 # NewsData.io proxy
│   │   └── aiProxy.js                   # Bedrock Haiku — predictions & summaries
│   └── agent/
│       ├── agentChat.js                 # POST /agent/chat — invokes Bedrock Agent Core
│       ├── agentHandler.js              # Action group handler — 8 tools for Claude Sonnet
│       ├── openapi-schema.json          # OpenAPI schema defining ArsenalTools action group
│       └── setup-agent.sh               # One-time provisioning script
├── .github/workflows/deploy.yml         # GitHub Actions CI/CD pipeline
└── .env                                 # Local secrets (gitignored)
```

---

## Related Repositories

| Repo | Description |
|---|---|
| [the-gooners-world](https://github.com/bhavikbhoir/the-gooners-world) | Arsenal FC fan site — React, Firebase Hosting, consumes this API |
| [FootBBall-App](https://github.com/bhavikbhoir/FootBBall-App) | Multi-league football stats app — React, Firebase Hosting, consumes this API |

---

## Author

**Bhavik Bhoir** — Full Stack Developer

- GitHub: [@bhavikbhoir](https://github.com/bhavikbhoir)
- LinkedIn: [bhavikbhoir](https://www.linkedin.com/in/bhavikbhoir/)
