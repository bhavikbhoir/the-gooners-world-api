const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ALLOWED_ORIGINS = 'https://the-gooners-world.web.app';
const { decodeAudio, handler } = require('./transcribe');

const pcm = (seconds) => Buffer.alloc(Math.round(16000 * 2 * seconds)).toString('base64');

test('decodeAudio accepts a normal recording', () => {
  const { pcm: buf, error } = decodeAudio(pcm(3));
  assert.equal(error, undefined);
  assert.equal(buf.length, 96000);
});

test('decodeAudio rejects missing, too short and too long audio', () => {
  assert.equal(decodeAudio(undefined).error, 'audio required');
  assert.equal(decodeAudio('').error, 'audio required');
  assert.equal(decodeAudio(pcm(0.1)).error, 'Recording too short.');
  assert.equal(decodeAudio(pcm(21)).error, 'Recording too long.');
});

test('decodeAudio accepts exactly the maximum length', () => {
  assert.equal(decodeAudio(pcm(20)).error, undefined);
});

test('handler returns 400 for missing audio without calling AWS', async () => {
  const res = await handler({ httpMethod: 'POST', headers: {}, body: '{}', requestContext: { identity: { sourceIp: 't1' } } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), { error: 'audio required' });
});
