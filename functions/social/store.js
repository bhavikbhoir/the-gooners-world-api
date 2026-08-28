/**
 * Social drafts data layer (DynamoDB single table).
 *
 * A "draft" is a generated post awaiting the 1-tap approval step. The generated
 * card image lives in S3 (too big for a Dynamo item); the draft holds its key.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: 'us-east-1' }),
  { marshallOptions: { removeUndefinedValues: true } }, // pre-match drafts have no score
);
const TABLE = process.env.SOCIAL_DRAFTS_TABLE;
const THIRTY_DAYS = 30 * 24 * 3600;

// Deterministic id so the orchestrator can't create duplicate drafts for the
// same match + post type (idempotency across scheduler runs).
function draftId(type, matchId) {
  return `${type}#${matchId}`;
}

async function createDraft(draft) {
  const id = draftId(draft.type, draft.matchId);
  const item = {
    draftId: id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + THIRTY_DAYS,
    ...draft,
  };
  // attribute_not_exists → never overwrite an existing draft (idempotent).
  await doc.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(draftId)',
  }));
  return item;
}

async function draftExists(type, matchId) {
  const res = await doc.send(new GetCommand({
    TableName: TABLE,
    Key: { draftId: draftId(type, matchId) },
    ProjectionExpression: 'draftId',
  }));
  return !!res.Item;
}

async function getDraft(id) {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { draftId: id } }));
  return res.Item || null;
}

async function listByStatus(status) {
  const res = await doc.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'statusIndex',
    KeyConditionExpression: '#s = :s',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':s': status },
    ScanIndexForward: false, // newest first
  }));
  return res.Items || [];
}

async function updateDraft(id, fields) {
  const names = {};
  const values = {};
  const sets = [];
  Object.entries(fields).forEach(([k, v], i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    sets.push(`#k${i} = :v${i}`);
  });
  const res = await doc.send(new UpdateCommand({
    TableName: TABLE,
    Key: { draftId: id },
    UpdateExpression: 'SET ' + sets.join(', '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));
  return res.Attributes;
}

module.exports = { createDraft, draftExists, getDraft, listByStatus, updateDraft, draftId };
