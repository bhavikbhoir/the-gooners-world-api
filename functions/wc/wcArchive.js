const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = 'tgw-wc-archive';
const TOURNAMENT = 'WC2026';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',');

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const corsOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];
  const corsHeaders = { 'Access-Control-Allow-Origin': corsOrigin, 'Vary': 'Origin' };

  if (origin && !isAllowed) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': TOURNAMENT, ':prefix': 'match#' },
    }));

    const matches = (result.Items || []).sort((a, b) => new Date(b.date) - new Date(a.date));

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({ matches }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
