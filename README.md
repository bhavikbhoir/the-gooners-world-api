# The Gooners World - Backend API

Serverless proxy API for [The Gooners World](https://the-gooners-world.web.app) Arsenal fan site.

## Tech Stack
- Node.js 22.x
- AWS Lambda
- API Gateway (with API key + rate limiting)
- AWS SSM Parameter Store (secrets)
- Serverless Framework v3

## Architecture
2 Lambda proxy functions that keep third-party API keys server-side:
- `GET /proxy/football` → football-data.org (standings, matches)
- `GET /proxy/news` → newsdata.io (Arsenal news)

## Local Development
```bash
npm install
npm run offline
```
Reads keys from `.env` file (gitignored).

## Deploy
```bash
npm run deploy:dev
npm run deploy:prod
```

## CI/CD
Push to `main` → GitHub Actions auto-deploys to `dev`.
Manual workflow dispatch for `prod`.
