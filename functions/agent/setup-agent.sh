#!/bin/bash
# ── Create Bedrock Agent for The Gooners World ──────────────────────
# Run this after deploying the serverless stack (so the Lambda ARN exists).
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - serverless deploy completed (arsenal-api stack)
#
# Usage: ./setup-agent.sh

set -e

REGION="us-east-1"
AGENT_NAME="arsenal-fc-assistant"
FOUNDATION_MODEL="us.anthropic.claude-sonnet-4-5-20251001-v1:0"

echo "🔴 Setting up Arsenal FC AI Assistant (Bedrock Agent Core — Claude Sonnet)"

# Get the Lambda ARN for the action group handler
STACK_NAME="arsenal-api-dev"
AGENT_LAMBDA_ARN=$(aws cloudformation describe-stack-resource \
  --stack-name "$STACK_NAME" \
  --logical-resource-id "AgentHandlerLambdaFunction" \
  --query "StackResourceDetail.PhysicalResourceId" \
  --output text \
  --region "$REGION" 2>/dev/null)

if [ -z "$AGENT_LAMBDA_ARN" ]; then
  echo "⚠️  Could not find agentHandler Lambda. Deploy the stack first:"
  echo "   cd the-gooners-world-api && npx serverless deploy"
  echo ""
  echo "Then get the Lambda ARN manually:"
  echo "   aws lambda get-function --function-name arsenal-api-dev-agentHandler --query Configuration.FunctionArn --output text --region $REGION"
  echo ""
  echo "And set AGENT_LAMBDA_ARN manually below, then re-run."
  exit 1
fi

echo "Lambda ARN: $AGENT_LAMBDA_ARN"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --region "$REGION")
echo "Account: $ACCOUNT_ID"

# 1. Create the agent trust policy
cat > /tmp/agent-trust-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "bedrock.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "$ACCOUNT_ID" }
      }
    }
  ]
}
EOF

# 2. Create IAM role for the agent
echo "Creating IAM role..."
ROLE_ARN=$(aws iam create-role \
  --role-name "AmazonBedrockExecutionRole_ArsenalAssistant" \
  --assume-role-policy-document file:///tmp/agent-trust-policy.json \
  --query "Role.Arn" --output text 2>/dev/null || \
  aws iam get-role --role-name "AmazonBedrockExecutionRole_ArsenalAssistant" \
  --query "Role.Arn" --output text)

echo "Role ARN: $ROLE_ARN"

# 3. Attach Bedrock model invocation policy (Sonnet + inference profiles)
cat > /tmp/agent-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:$REGION::foundation-model/anthropic.claude-sonnet-4-5-v1:0",
        "arn:aws:bedrock:$REGION::foundation-model/us.anthropic.claude-sonnet-4-5-20251001-v1:0",
        "arn:aws:bedrock:*:*:inference-profile/*"
      ]
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name "AmazonBedrockExecutionRole_ArsenalAssistant" \
  --policy-name "BedrockModelAccess" \
  --policy-document file:///tmp/agent-policy.json

echo "Waiting for IAM propagation..."
sleep 10

# 4. Create the Bedrock Agent
echo "Creating Bedrock Agent..."
AGENT_ID=$(aws bedrock-agent create-agent \
  --agent-name "$AGENT_NAME" \
  --agent-resource-role-arn "$ROLE_ARN" \
  --foundation-model "$FOUNDATION_MODEL" \
  --instruction "You are the Arsenal FC AI Assistant on The Gooners World fan site. You are knowledgeable, passionate about Arsenal, and always helpful to fellow Gooners.

You have access to real-time tools. Always use them before answering factual questions — never guess scores, positions, or fixtures from memory.

How to use your tools:
- For fixture/schedule questions: call GetFixtures (use type=upcoming for next matches, type=recent for past results, add competition=PL or competition=CL to filter)
- For table/position questions: call GetStandings
- For scorer questions: call GetScorers
- For live match questions: call GetLiveScore
- For squad/player questions: call GetSquad
- For news/transfer questions: call GetNews
- For match predictions: call GetPrediction — it returns the upcoming match and recent form; use that data to write a detailed, thoughtful prediction with a scoreline and percentage probabilities
- For match result summaries: call GetMatchSummary — it returns the result and league context; use that to write a passionate, specific 2-3 sentence summary explaining what the result means for Arsenal

Multi-step reasoning: if a question requires combining data (e.g. 'how many points behind are we with 5 games left?'), call multiple tools and reason across the results before answering.

Tone: passionate Arsenal fan — refer to Arsenal as 'we' or 'the Gunners'. Be concise (3-5 sentences max unless detail is needed). If something is not about Arsenal or football, politely redirect." \
  --idle-session-ttl-in-seconds 600 \
  --region "$REGION" \
  --query "agent.agentId" --output text)

echo "Agent ID: $AGENT_ID"

# 5. Add Lambda permission for Bedrock to invoke the action group handler
aws lambda add-permission \
  --function-name "arsenal-api-dev-agentHandler" \
  --statement-id "AllowBedrockAgent" \
  --action "lambda:InvokeFunction" \
  --principal "bedrock.amazonaws.com" \
  --source-arn "arn:aws:bedrock:$REGION:$ACCOUNT_ID:agent/$AGENT_ID" \
  --region "$REGION" 2>/dev/null || echo "Permission already exists"

# 6. Create action group with OpenAPI schema
echo "Creating action group..."
SCHEMA_B64=$(base64 -i functions/agent/openapi-schema.json)
aws bedrock-agent create-agent-action-group \
  --agent-id "$AGENT_ID" \
  --agent-version "DRAFT" \
  --action-group-name "ArsenalTools" \
  --action-group-executor '{"lambda": "'"$AGENT_LAMBDA_ARN"'"}' \
  --api-schema '{"payload": "'"$SCHEMA_B64"'"}' \
  --description "Arsenal FC data tools — fixtures, standings, scorers, live scores, squad, news, predictions, match summaries" \
  --region "$REGION"

# 7. Prepare the agent
echo "Preparing agent..."
aws bedrock-agent prepare-agent \
  --agent-id "$AGENT_ID" \
  --region "$REGION"

echo "Waiting for agent to be ready..."
sleep 20

# 8. Create alias
echo "Creating agent alias..."
ALIAS_ID=$(aws bedrock-agent create-agent-alias \
  --agent-id "$AGENT_ID" \
  --agent-alias-name "live" \
  --region "$REGION" \
  --query "agentAlias.agentAliasId" --output text)

echo ""
echo "✅ Arsenal FC AI Assistant ready!"
echo ""
echo "Agent ID:    $AGENT_ID"
echo "Alias ID:    $ALIAS_ID"
echo ""
echo "Add to your serverless environment (or .env for local dev):"
echo "  BEDROCK_AGENT_ID=$AGENT_ID"
echo "  BEDROCK_AGENT_ALIAS_ID=$ALIAS_ID"
echo ""
echo "Then redeploy: npx serverless deploy"

rm -f /tmp/agent-trust-policy.json /tmp/agent-policy.json
