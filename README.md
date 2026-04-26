# The Gooners World — Backend API

Serverless backend for [The Gooners World](https://the-gooners-world.web.app), an Arsenal FC fan site with live data and AI-powered features.

## Endpoints

3 Lambda proxy functions keeping API keys server-side:

| Endpoint | Purpose | Upstream | Cache |
|---|---|---|---|
| `GET /proxy/football` | Fixtures, standings, scorers, CL, squad, live | football-data.org | 30s–24hr |
| `GET /proxy/news` | Arsenal news feed | NewsData.io | 30min |
| `GET /proxy/ai` | Match predictions & summaries | AWS Bedrock | 1hr–24hr |

### Football Proxy Types

| `?type=` | Params | Returns |
|---|---|---|
| `matches` | `?league=PL` | Competition matches (default: Arsenal scheduled + finished) |
| `standings` | `?league=PL` | League standings table |
| `scorers` | `?league=PL` | Top 20 scorers for competition |
| `cl-matches` | — | Arsenal CL matches (limit 40) |
| `cl-standings` | — | Champions League standings |
| `live` | — | In-play Arsenal match |
| `squad` / `team` | — | Arsenal squad + team info |
| `h2h` | `?matchId=` | Head-to-head for a specific match (last 10) |
| `match` | `?matchId=` | Single match detail |
| `season-compare` | `?season=2024` | Historical season standings |

### AI Proxy Types

| `?type=` | Returns |
|---|---|
| `prediction` | Pre-match prediction with score, win %, form-weighted analysis |
| `summary` | Post-match 2-sentence recap, competition-aware, no hallucinated details |

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22 on AWS Lambda |
| Framework | Serverless Framework v3 |
| API Gateway | REST API with API key authentication |
| AI/ML | AWS Bedrock — Amazon Nova Micro |
| Secrets | AWS SSM Parameter Store (SecureString) |
| CI/CD | GitHub Actions (auto-deploy on push to main) |

## Security

- **API Key Authentication** — every request requires `x-api-key` header
- **Multiple API Keys** — separate keys per frontend app
- **Rate Limiting** — 1,000 requests/day, 10 req/sec sustained, 15 burst
- **Multi-Origin Validation** — Lambda checks Origin header against comma-separated allowlist
- **SSM Secrets** — football-data.org and NewsData.io keys stored as SecureString
- **Bedrock via IAM** — no external key, uses Lambda execution role
- **Least Privilege** — Bedrock permission scoped to `amazon.nova-micro-v1:0`

## AI Prompt Engineering

- **Predictions** — weighs most recent results first, separates PL vs CL form, realistic after losses
- **Summaries** — no invented goalscorers, focuses on competition implications (title race, CL progression, cup rounds)
- Third-person voice, competition-aware context for PL, CL, FA Cup, Carabao Cup

## Architecture

```
Frontend Apps (Firebase Hosting)
    ↓ x-api-key header
API Gateway
    ↓ validates key + rate limit
Lambda Functions
    ├── footballProxy → football-data.org (X-Auth-Token)
    ├── newsProxy → newsdata.io (apikey param)
    └── aiProxy → AWS Bedrock (IAM role)
```

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

## Cost

| Service | Monthly |
|---|---|
| Lambda (3 functions, ~5K req/month) | $0 |
| API Gateway (~5K req/month) | $0 |
| Bedrock Nova Micro (~500 calls) | ~$0.02 |
| SSM (2 params) | $0 |
| **Total** | **~$0.02/month** |

## Structure

```
├── serverless.yml                 # Infrastructure + IAM + API Gateway config
├── functions/proxy/
│   ├── footballProxy.js           # Fixtures, standings, scorers, CL, squad, live, h2h
│   ├── newsProxy.js               # Arsenal news feed
│   └── aiProxy.js                 # AI predictions & summaries (Bedrock Nova Micro)
├── .github/workflows/deploy.yml   # CI/CD pipeline
├── .env                           # Local dev secrets (gitignored)
└── package.json
```

## Author

**Bhavik Bhoir** — Full Stack Developer
- GitHub: [@bhavikbhoir](https://github.com/bhavikbhoir)
- LinkedIn: [bhavikbhoir](https://www.linkedin.com/in/bhavikbhoir/)
