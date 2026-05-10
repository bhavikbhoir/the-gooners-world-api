# The Gooners World — Backend API

Serverless football data and AI backend powering two frontends: [The Gooners World](https://the-gooners-world.web.app) (Arsenal FC fan site) and [FootBBall App](https://the-footbball-app.web.app) (multi-league stats).

[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![AWS Lambda](https://img.shields.io/badge/AWS_Lambda-8_functions-FF9900?logo=awslambda&logoColor=white)](https://aws.amazon.com/lambda/)
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
                    └──┬──────┬────────┬──────┬──────┬────┘
                       │      │        │      │      │
              ┌────────┘  ┌───┘    ┌───┘  ┌───┘  ┌───┘
              ▼           ▼        ▼      ▼      ▼
    ┌──────────────┐ ┌─────────┐ ┌──────┐ ┌───────┐ ┌──────────────┐
    │footballProxy │ │newsProxy│ │aiPxy │ │agent  │ │  adminAuth + │
    │              │ │+ Claude │ │      │ │Chat   │ │  generate +  │
    │              │ │Haiku    │ │      │ │       │ │  publish     │
    └──────┬───────┘ └────┬────┘ └──┬───┘ └───┬───┘ └──────┬───────┘
           │              │         │          │             │
           ▼              ▼         ▼          ▼             ▼
    football-data.org  NewsData.io  Bedrock  Bedrock      Bedrock
    (v4 REST API)                   Sonnet   Agent Core   Sonnet
                                  (4.6)    (Claude)     (4.6)
                                                │          │
                                                ▼          ▼
                                       agentHandler     S3 + IG
                                       (9 tools)        + X API

IAM — Lambda execution role
  ├── bedrock:InvokeModel  on arn:aws:bedrock:*::foundation-model/*
  │                           arn:aws:bedrock:*:*:inference-profile/*
  ├── bedrock:InvokeAgent  on arn:aws:bedrock:us-east-1:*:agent/*
  │                           arn:aws:bedrock:us-east-1:*:agent-alias/*
  └── s3:PutObject + s3:GetObject  on tgw-social-images/*
```

---

## Lambda Functions

| Function | Endpoint | Method | Purpose |
|---|---|---|---|
| `footballProxy` | `/proxy/football` | GET | Proxies football-data.org v4 — fixtures, standings, scorers, live scores, squad, H2H |
| `newsProxy` | `/proxy/news` | GET | Proxies NewsData.io — Arsenal news with semantic dedup + Claude Haiku AI curation |
| `aiProxy` | `/proxy/ai` | GET | Bedrock Sonnet — match predictions and post-match summaries |
| `agentChat` | `/agent/chat` | POST | Bedrock Agent Core entry point — routes messages to Claude Sonnet |
| `agentHandler` | (no HTTP event) | — | Bedrock action group handler — invoked by Claude Sonnet when selecting tools |
| `adminAuth` | `/admin/auth` | POST | Password authentication — returns signed 8-hour Bearer token |
| `generateMatchPost` | `/admin/generate` | POST | Calls Claude Sonnet to write branded Instagram + X post copy from a match result |
| `publishPost` | `/admin/publish` | POST | Uploads image to private S3 (pre-signed URL), posts to Instagram Graph API and X |

### Football Proxy — `?type=` query parameter

| type | Returns | Cache |
|---|---|---|
| `matches` | Arsenal scheduled + finished matches (limit 20) | 15 min |
| `standings` | Full league table (`?league=PL` default) | 15 min |
| `cl-standings` | Champions League standings | 15 min |
| `cl-matches` | Arsenal CL matches (limit 40) | 15 min |
| `scorers` | Top 20 scorers for a competition | 30 min |
| `pl-results` | All finished PL matches (used to compute form for all 20 teams) | 15 min |
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

### News Curation — Claude Haiku (newsProxy)

Uses `us.anthropic.claude-haiku-4-5-20251001` to filter the 10 raw NewsData.io articles down to genuine Arsenal football content. The pipeline is:

1. **Semantic deduplication** — word-overlap fingerprinting (60% threshold) collapses the same story reported by multiple outlets before AI curation
2. **Claude Haiku classification** — sends article titles, receives JSON array of approved indices; excludes celebrity gossip, WAG content, influencer lifestyle, non-Arsenal match scores, cultural stories
3. **Fallback** — if Haiku call fails, all deduplicated articles pass through unfiltered

### Admin Social Post Generator — Claude Sonnet (generateMatchPost)

Uses `us.anthropic.claude-sonnet-4-6` with a structured prompt to generate two post formats from a finished match result:

- **Instagram** — branded template with score header, match metadata, 2-3 sentence match summary in fan voice, and hashtags
- **X** — ≤280 character punchy post with result line, key moment, and hashtags

Tone is calibrated per outcome: celebratory for wins, honest for draws, grounded for losses — never hyperbolic.

### Chat Assistant — Claude Sonnet via Bedrock Agent Core (agentChat + agentHandler)

Uses `us.anthropic.claude-sonnet-4-6` as the Bedrock Agent foundation model.

**Agent configuration:**

| Field | Value |
|---|---|
| Agent ID | `Q0U07RR09G` |
| Live alias | `2HVFYQGWR7` → Version 2 |
| Action group | `ArsenalTools` (9 tools) |
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
| `GetPlayerStats` | football-data.org | User asks about a specific player's stats |

Action handlers return raw structured data only. Claude Sonnet generates all natural language output and can chain multiple tool calls to answer complex questions.

**Response sanitization** strips Bedrock-specific artefacts: `<answer>` XML tags, `question="..."` prefixes, `answer:` prefixes.

---

## Admin Panel

A password-gated admin UI at `/admin` on the frontend lets you generate and publish branded match result posts directly to Instagram and X.

**Auth flow:**
1. Admin enters password in UI → POST `/admin/auth` with password in body
2. `adminAuth` Lambda compares against `ADMIN_PASSWORD` SSM param (never in client bundle)
3. On success, returns a signed HMAC-SHA256 Bearer token valid for 8 hours
4. All subsequent admin requests send `Authorization: Bearer {token}`
5. `generateMatchPost` and `publishPost` verify the token signature and expiry — no static shared key in the client

**Publish flow:**
1. Admin selects a finished match, uploads an image, clicks Generate
2. `generateMatchPost` calls Claude Sonnet and returns Instagram + X caption drafts
3. Admin edits if needed, clicks Publish
4. `publishPost` uploads image to **private** S3 with a match-based filename (e.g. `arsenal-vs-chelsea-2-1-20260510.jpg`)
5. Generates a **5-minute pre-signed URL** — Instagram fetches the image via this URL; it expires automatically
6. Creates Instagram media container → waits → publishes
7. Signs and posts to X via OAuth 1.0a HMAC-SHA1

The S3 bucket stays fully private. No public bucket policy needed.

---

## Architecture Decisions

### Why Bedrock Agent Core instead of a direct Claude API loop?

The agent uses `InvokeAgent` (Bedrock Agent Core) rather than a custom tool-calling loop with direct `InvokeModel` calls. The key reasons:

- **Managed session state** — Bedrock Agent Core maintains multi-turn conversation history server-side via `sessionId`. No custom database or cache layer needed for session memory.
- **Platform-level tool selection** — The agent autonomously decides which tool(s) to call and in what order based on the OpenAPI `description` fields in the action group schema. This keeps the orchestration logic in the model, not in application code.
- **IAM-native invocation** — Bedrock invokes `agentHandler` directly via IAM (not HTTP), so the action group handler has no public endpoint and no API key management.
- **Built-in retry and tracing** — Bedrock handles tool call retries and provides native CloudWatch traces per session.

The trade-off: Bedrock Agent Core adds latency (~3–8 seconds per turn for a simple single-tool call) compared to a direct `InvokeModel` call. For a chat interface this is acceptable; for latency-sensitive workloads a custom loop would be preferable.

### Why pre-signed S3 URLs for Instagram image hosting?

Instagram's Graph API requires a publicly accessible image URL at container creation time. Rather than making the S3 bucket public, the `publishPost` Lambda uploads to a private bucket and generates a **5-minute pre-signed GetObject URL**. Instagram fetches the image within seconds; the URL expires automatically after 5 minutes regardless. The bucket has no public policy and files are not enumerable.

### Why stateless HMAC tokens for admin auth?

The admin Bearer token is a `{timestamp}.{hmac}` string signed with `ADMIN_KEY` (stored in SSM). Verification is a pure HMAC recomputation — no database, no session store, no Redis. The token carries its own expiry (8 hours) in the timestamp. This works correctly across Lambda cold starts and scales to multiple warm containers with zero infrastructure overhead.

### Rate limiter trade-off (agentChat)

The in-Lambda rate limiter (60 req / 10 min per IP) uses in-process state — it resets per warm Lambda container, not globally. This means a high-concurrency deployment with multiple warm instances could allow a single IP to exceed the limit across containers. At current traffic volume (~200 chat sessions/month) this is sufficient and adds zero cost. For production scale, the counter would be backed by DynamoDB or ElastiCache for global consistency.

---

## Security and Reliability

### API Key Authentication

Every HTTP endpoint is `private: true` in API Gateway — all requests require a valid `x-api-key` header. Two separate keys are provisioned per stage (one per frontend), allowing individual key rotation without disrupting the other client.

| API Key | Frontend |
|---|---|
| `tgw-frontend-{stage}` | The Gooners World |
| `footbball-app-{stage}` | FootBBall App |

### Admin Authentication

Admin endpoints use a two-layer auth model:
1. **API Gateway** — requires `x-api-key` like all other endpoints
2. **Bearer token** — signed HMAC-SHA256 token issued by `adminAuth` Lambda; verified by `generateMatchPost` and `publishPost`. Token TTL: 8 hours.

The admin password never touches the client bundle — it lives in SSM and is only compared server-side in `adminAuth`.

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
| `FOOTBALL_API_KEY` | AWS SSM `/tgw/football-api-key` | Injected at deploy by Serverless Framework |
| `NEWS_API_KEY` | AWS SSM `/tgw/news-api-key` | Injected at deploy by Serverless Framework |
| `ADMIN_KEY` | AWS SSM `/tgw/admin-key` | HMAC signing secret for admin Bearer tokens |
| `ADMIN_PASSWORD` | AWS SSM `/tgw/admin-password` | Admin UI password — compared server-side only |
| `IG_ACCESS_TOKEN` | AWS SSM `/tgw/ig-access-token` | Instagram Graph API long-lived token |
| `IG_ACCOUNT_ID` | AWS SSM `/tgw/ig-account-id` | Instagram Business account ID |
| `X_APP_KEY` | AWS SSM `/tgw/x-app-key` | X API consumer key (OAuth 1.0a) |
| `X_APP_SECRET` | AWS SSM `/tgw/x-app-secret` | X API consumer secret (OAuth 1.0a) |
| `X_ACCESS_TOKEN` | AWS SSM `/tgw/x-access-token` | X OAuth access token (Read + Write) |
| `X_ACCESS_TOKEN_SECRET` | AWS SSM `/tgw/x-access-token-secret` | X OAuth access token secret |
| `BEDROCK_AGENT_ID` | GitHub Actions secret | Env var on agentChat Lambda |
| `BEDROCK_AGENT_ALIAS_ID` | GitHub Actions secret | Env var on agentChat Lambda |
| AWS credentials | GitHub Actions secrets | Used only during `serverless deploy` |

---

## CI/CD Pipeline

File: `.github/workflows/deploy.yml`

```
Push to main
    └─→ ubuntu-latest runner
          ├── actions/checkout@v4
          ├── actions/setup-node@v4  (Node 22)
          ├── npm install
          ├── npm test
          ├── aws-actions/configure-aws-credentials@v4
          └── npx serverless deploy --stage dev

Manual workflow_dispatch
    └─→ Same steps with selectable stage: dev | prod
```

Auto-deploys to `dev` on every push to `main`. Production deploys are triggered manually via the GitHub Actions UI.

> **Important:** All SSM parameters must exist in AWS before deploying. Serverless Framework resolves `${ssm:/tgw/...}` at deploy time — a missing parameter will fail the deploy.

---

## Cost Profile

At approximately 5,000 requests/month:

| Service | Estimated monthly cost |
|---|---|
| Lambda (8 functions, ~5K req) | $0 |
| API Gateway (~5K req) | $0 |
| Bedrock Claude Sonnet — predictions/summaries (~30 unique calls/month, cached) | ~$0.20 |
| Bedrock Claude Sonnet — chat sessions (~200 sessions/month) | ~$0.30 |
| Bedrock Claude Sonnet — admin post generation (~30 calls/month) | ~$0.05 |
| Bedrock Claude Haiku — news curation (~500 calls/month) | ~$0.02 |
| S3 — social images storage (~30 images/month, ~2MB each) | $0 |
| SSM Parameter Store (10 params) | $0 |
| **Total** | **~$0.57 / month** |

---

## Local Development

```bash
# Prerequisites: Node.js, AWS credentials configured locally

# Install
npm install

# Create .env in project root
FOOTBALL_API_KEY=your_key_here
NEWS_API_KEY=your_key_here
ADMIN_KEY=your_signing_secret
ADMIN_PASSWORD=your_admin_password
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
├── package.json                         # npm scripts + dependencies
├── functions/
│   ├── proxy/
│   │   ├── footballProxy.js             # football-data.org proxy — 11 query types
│   │   ├── newsProxy.js                 # NewsData.io proxy + semantic dedup + Claude Haiku curation
│   │   └── aiProxy.js                   # Bedrock Sonnet — predictions & summaries
│   ├── admin/
│   │   ├── adminAuth.js                 # POST /admin/auth — password check, issues HMAC Bearer token
│   │   ├── generateMatchPost.js         # POST /admin/generate — Claude Sonnet match post writer
│   │   └── publishPost.js               # POST /admin/publish — S3 upload, Instagram + X posting
│   └── agent/
│       ├── agentChat.js                 # POST /agent/chat — invokes Bedrock Agent Core (Claude Sonnet 4.6)
│       ├── agentHandler.js              # Action group handler — 9 tools for Claude Sonnet
│       ├── openapi-schema.json          # OpenAPI schema defining ArsenalTools action group
│       └── setup-agent.sh               # One-time provisioning script (IAM role, agent, action group, alias)
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
