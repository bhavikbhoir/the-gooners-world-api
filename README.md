# The Gooners World — Backend API

Serverless backend for [The Gooners World](https://the-gooners-world.web.app), an Arsenal FC fan site with live data and AI-powered features.

## What It Does

3 Lambda proxy functions that keep API keys server-side and add security controls:

| Endpoint | Purpose | Upstream API | Cache |
|---|---|---|---|
| `GET /proxy/football` | Fixtures, standings, live scores, squad | football-data.org | 15min–24hr |
| `GET /proxy/news` | Arsenal news feed | NewsData.io | 30min |
| `GET /proxy/ai` | Match predictions & summaries | AWS Bedrock (Nova Micro) | 1hr–24hr |

### Football Proxy Types
| `?type=` | Returns |
|---|---|
| `matches` | Last 20 scheduled + finished Arsenal matches |
| `standings` | Full Premier League table |
| `live` | Currently in-play Arsenal match (if any) |
| `squad` | Arsenal squad with positions and nationalities |

### AI Proxy Types
| `?type=` | Returns |
|---|---|
| `prediction` | Pre-match prediction with predicted score and win probability |
| `summary` | Post-match 2-sentence recap based on score and competition context |

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
- **Rate Limiting** — 500 requests/day, 5 req/sec sustained, 10 burst
- **Origin Validation** — Lambda checks `Origin` header against allowed domain
- **Secrets in SSM** — football-data.org and NewsData.io keys stored as SecureString
- **Bedrock via IAM** — no external API key needed, uses Lambda execution role
- **Least Privilege IAM** — Bedrock permission scoped to specific model ARN

## Architecture

```
Frontend (Firebase Hosting)
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

| Service | Monthly Cost |
|---|---|
| Lambda (3 functions, ~3K req/month) | $0 (free tier) |
| API Gateway (~3K req/month) | $0 (free tier) |
| Bedrock Nova Micro (~300 calls/month) | ~$0.01 |
| SSM Parameter Store (2 params) | $0 |
| **Total** | **~$0.01/month** |

## Project Structure

```
├── serverless.yml                 # Infrastructure as code
├── functions/proxy/
│   ├── footballProxy.js           # Fixtures, standings, live, squad
│   ├── newsProxy.js               # Arsenal news feed
│   └── aiProxy.js                 # AI predictions & summaries (Bedrock)
├── .github/workflows/deploy.yml   # CI/CD pipeline
├── .env                           # Local dev secrets (gitignored)
└── package.json
```

## Author

**Bhavik Bhoir** — Full Stack Developer
- GitHub: [@bhavikbhoir](https://github.com/bhavikbhoir)
- LinkedIn: [bhavikbhoir](https://www.linkedin.com/in/bhavikbhoir/)
