# Setup Guide

## Prerequisites
- AWS account with SSM parameters stored (`/tgw/football-api-key`, `/tgw/news-api-key`)
- GitHub Secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`

## Local Development
```bash
npm install
npm run offline
```

## Deploy
```bash
npm run deploy:dev
```

## What Gets Created
- 2 Lambda functions (proxy)
- API Gateway with API key + usage plan
- IAM roles
