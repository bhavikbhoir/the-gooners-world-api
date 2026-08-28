/**
 * Runtime secret reads from SSM, with a short in-memory cache.
 *
 * The IG long-lived token is rotated by refreshIgToken, so consumers must read
 * it at RUNTIME (not from a deploy-time env var, which would go stale).
 */

const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');

const ssm = new SSMClient({ region: 'us-east-1' });
const cache = new Map();
const TTL = 5 * 60_000; // 5 min

async function getSecret(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.ts < TTL) return hit.value;
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter.Value;
  cache.set(name, { value, ts: Date.now() });
  return value;
}

async function putSecret(name, value) {
  await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: 'SecureString', Overwrite: true }));
  cache.set(name, { value, ts: Date.now() });
}

module.exports = { getSecret, putSecret };
