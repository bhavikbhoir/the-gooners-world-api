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
| `?type=` | Returns |
|---|---|
| `matches` | Arsenal matches (scheduled + finished, limit 20) |
| `standings` | Premier League table |
| `scorers` | PL top scorers (limit 20) |
| `cl-matches` | Arsenal CL matches (limit 40) |
| `live` | In-play Arsenal match |
| `squad` | Arsenal squad |

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
| API Gateway | REST API with API key + rate limiting |
| AI/ML | AWS Bedrock — Amazon Nova Micro |
| Secrets | AWS SSM Parameter Store (SecureString) |
| CI/CD | GitHub Actions (auto-deploy on push to main) |

## Security

- **API Key** — every request requires `x-api-key` header
- **Rate Limiting** — 500 req/day, 5 req/sec, 10 burst
- **Origin Validation** — Lambda checks Origin header
- **SSM Secrets** — football-data.org and NewsData.io keys as SecureString
- **Bedrock via IAM** — no external key, uses Lambda execution role
- **Least Privilege** — Bedrock permission scoped to specific model ARN

## AI Prompt Engineering

- **Predictions** — weighs most recent results first, separates PL vs CL form, realistic after losses
- **Summaries** — no invented goalscorers, focuses on competition implications (title race, CL progression, cup rounds)
- Third-person voice, competition-aware context

## Local Development

```bash
npm install
npm run offline
```

## Deploy

```bash
npm run deploy:dev    # or push to main for auto-deploy
npm run deploy:prod   # manual via GitHub Actions
```

## Cost

| Service | Monthly |
|---|---|
| Lambda (~3K req/month) | $0 |
| API Gateway (~3K req/month) | $0 |
| Bedrock Nova Micro (~300 calls) | ~$0.01 |
| SSM (2 params) | $0 |
| **Total** | **~$0.01/month** |

## Structure

```
├── serverless.yml
├── functions/proxy/
│   ├── footballProxy.js
│   ├── newsProxy.js
│   └── aiProxy.js
├── .github/workflows/deploy.yml
├── .env                          # Local secrets (gitignored)
└── package.json
```

## Author

**Bhavik Bhoir** — Full Stack Developer
- GitHub: [@bhavikbhoir](https://github.com/bhavikbhoir)
- LinkedIn: [bhavikbhoir](https://www.linkedin.com/in/bhavikbhoir/)
