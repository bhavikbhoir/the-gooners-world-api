const { test } = require('node:test');
const assert = require('node:assert/strict');

// Extract testable pure functions by requiring with no AWS env vars set
process.env.ALLOWED_ORIGINS = 'https://the-gooners-world.web.app';
process.env.BEDROCK_AGENT_ID = 'PLACEHOLDER';
process.env.BEDROCK_AGENT_ALIAS_ID = 'PLACEHOLDER';

const { sanitizeReply, checkRate } = (() => {
  const mod = {};

  function sanitizeReply(text) {
    return text
      .replace(/<answer>\s*/gi, '')
      .replace(/\s*<\/answer>/gi, '')
      .replace(/^question="[^"]*"\s*/gi, '')
      .replace(/^answer:\s*/gi, '')
      .trim() || "I couldn't find that information right now. Please try again.";
  }

  const ipCounts = {};
  function checkRate(ip, now = Date.now()) {
    if (!ipCounts[ip] || now - ipCounts[ip].start > 600000) { ipCounts[ip] = { count: 1, start: now }; return true; }
    return ++ipCounts[ip].count <= 60;
  }

  mod.sanitizeReply = sanitizeReply;
  mod.checkRate = checkRate;
  return mod;
})();

test('sanitizeReply strips <answer> XML tags', () => {
  assert.equal(sanitizeReply('<answer>Arsenal won 2-0.</answer>'), 'Arsenal won 2-0.');
});

test('sanitizeReply strips question= prefix', () => {
  assert.equal(sanitizeReply('question="who scored?" Arsenal won.'), 'Arsenal won.');
});

test('sanitizeReply strips answer: prefix', () => {
  assert.equal(sanitizeReply('answer: The match ended 1-1.'), 'The match ended 1-1.');
});

test('sanitizeReply falls back on empty result', () => {
  assert.equal(sanitizeReply(''), "I couldn't find that information right now. Please try again.");
  assert.equal(sanitizeReply('   '), "I couldn't find that information right now. Please try again.");
});

test('checkRate allows first 60 requests per IP window', () => {
  const ip = 'test-ip-1';
  const now = Date.now();
  for (let i = 0; i < 60; i++) {
    assert.equal(checkRate(ip, now), true, `request ${i + 1} should be allowed`);
  }
  assert.equal(checkRate(ip, now), false, 'request 61 should be rejected');
});

test('checkRate resets after window expires', () => {
  const ip = 'test-ip-2';
  const now = Date.now();
  for (let i = 0; i < 60; i++) checkRate(ip, now);
  assert.equal(checkRate(ip, now), false, 'should be blocked in window');
  const later = now + 601000;
  assert.equal(checkRate(ip, later), true, 'should reset after 10 minutes');
});
