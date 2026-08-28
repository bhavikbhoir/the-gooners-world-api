#!/usr/bin/env node
/**
 * Social credentials health-check (READ-ONLY — never posts).
 *
 * Verifies the Instagram + X credentials actually work and reports token
 * expiry, so we know precisely what "not live" means before changing anything.
 *
 * Reads the same env vars the Lambdas use. Populate them from SSM first:
 *
 *   export IG_ACCESS_TOKEN=$(aws ssm get-parameter --name /tgw/ig-access-token --with-decryption --query Parameter.Value --output text)
 *   export IG_ACCOUNT_ID=$(aws ssm get-parameter --name /tgw/ig-account-id --query Parameter.Value --output text)
 *   export X_APP_KEY=$(aws ssm get-parameter --name /tgw/x-app-key --with-decryption --query Parameter.Value --output text)
 *   export X_APP_SECRET=$(aws ssm get-parameter --name /tgw/x-app-secret --with-decryption --query Parameter.Value --output text)
 *   export X_ACCESS_TOKEN=$(aws ssm get-parameter --name /tgw/x-access-token --with-decryption --query Parameter.Value --output text)
 *   export X_ACCESS_TOKEN_SECRET=$(aws ssm get-parameter --name /tgw/x-access-token-secret --with-decryption --query Parameter.Value --output text)
 *   node scripts/social-healthcheck.js
 */

const crypto = require('crypto');

const GRAPH_VERSION = 'v21.0';
const ok = (s) => `\x1b[32m✓ ${s}\x1b[0m`;
const bad = (s) => `\x1b[31m✗ ${s}\x1b[0m`;
const warn = (s) => `\x1b[33m! ${s}\x1b[0m`;

async function checkInstagram() {
  console.log('\n── Instagram ───────────────────────────────');
  const token = process.env.IG_ACCESS_TOKEN;
  const accountId = process.env.IG_ACCOUNT_ID;

  if (!token) return console.log(bad('IG_ACCESS_TOKEN not set'));
  if (!accountId) console.log(warn('IG_ACCOUNT_ID not set (account check skipped)'));

  // 1. Token validity + expiry via debug_token.
  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const json = await res.json();
    const d = json.data || {};
    if (d.is_valid) {
      console.log(ok('Token is valid'));
      if (d.expires_at && d.expires_at > 0) {
        const days = Math.round((d.expires_at * 1000 - Date.now()) / 86400000);
        const line = `Expires ${new Date(d.expires_at * 1000).toISOString().slice(0, 10)} (${days} days)`;
        console.log(days < 10 ? warn(line + ' — refresh soon') : ok(line));
      } else {
        console.log(ok('Token does not expire (or is a page token)'));
      }
      if (d.scopes) console.log('  scopes: ' + d.scopes.join(', '));
    } else {
      console.log(bad('Token INVALID — this is almost certainly why IG is "not live"'));
      if (json.data?.error) console.log('  ' + json.data.error.message);
    }
  } catch (e) {
    console.log(bad('debug_token request failed: ' + e.message));
  }

  // 2. Confirm the IG business account resolves.
  if (accountId) {
    try {
      const url = `https://graph.facebook.com/${GRAPH_VERSION}/${accountId}?fields=username,name&access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.username) console.log(ok(`Account: @${json.username} (${json.name || ''})`));
      else console.log(bad('Account lookup failed: ' + (json.error?.message || JSON.stringify(json))));
    } catch (e) {
      console.log(bad('Account request failed: ' + e.message));
    }
  }
}

function xAuthHeader(method, url) {
  const { X_APP_KEY, X_APP_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET } = process.env;
  const p = {
    oauth_consumer_key: X_APP_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const paramStr = Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const baseStr = [method.toUpperCase(), encodeURIComponent(url), encodeURIComponent(paramStr)].join('&');
  const signingKey = `${encodeURIComponent(X_APP_SECRET)}&${encodeURIComponent(X_ACCESS_TOKEN_SECRET)}`;
  p.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');
  return 'OAuth ' + Object.entries(p).map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`).join(', ');
}

async function checkX() {
  console.log('\n── X (Twitter) ─────────────────────────────');
  const keys = ['X_APP_KEY', 'X_APP_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET'];
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) return console.log(bad('Missing: ' + missing.join(', ')));

  try {
    const url = 'https://api.twitter.com/2/users/me';
    const res = await fetch(url, { headers: { Authorization: xAuthHeader('GET', url) } });
    const json = await res.json();
    if (res.status === 200 && json.data) {
      console.log(ok(`Authenticated as @${json.data.username} (${json.data.name})`));
      console.log(warn('Note: this confirms READ. Posting also needs Read+Write on the access token & Elevated/Basic project access.'));
    } else if (res.status === 403) {
      console.log(bad('403 — token valid but app lacks write/project access, or wrong access level'));
      console.log('  ' + JSON.stringify(json).slice(0, 200));
    } else {
      console.log(bad(`Auth failed (HTTP ${res.status})`));
      console.log('  ' + JSON.stringify(json).slice(0, 200));
    }
  } catch (e) {
    console.log(bad('Request failed: ' + e.message));
  }
}

(async () => {
  console.log('Social credentials health-check (read-only, no posts)');
  await checkInstagram();
  await checkX();
  console.log('\nDone. Nothing was posted.\n');
})();
