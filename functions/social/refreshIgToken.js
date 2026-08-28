/**
 * IG long-lived token auto-refresh (scheduled, weekly).
 *
 * A Facebook long-lived user token lasts ~60 days and can be re-exchanged any
 * time after it's 24h old, resetting the clock. Running weekly means the token
 * never expires — which is the usual cause of Instagram going "not live".
 *
 * Needs the app credentials in SSM:
 *   /tgw/fb-app-id       (String)
 *   /tgw/fb-app-secret   (SecureString)
 */

const { getSecret, putSecret } = require('./secrets');

const GRAPH_VERSION = 'v21.0';

exports.handler = async () => {
  const [current, appId, appSecret] = await Promise.all([
    getSecret('/tgw/ig-access-token'),
    getSecret('/tgw/fb-app-id'),
    getSecret('/tgw/fb-app-secret'),
  ]);

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
    + `?grant_type=fb_exchange_token`
    + `&client_id=${encodeURIComponent(appId)}`
    + `&client_secret=${encodeURIComponent(appSecret)}`
    + `&fb_exchange_token=${encodeURIComponent(current)}`;

  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`IG token refresh failed: ${JSON.stringify(json)}`);
  }

  await putSecret('/tgw/ig-access-token', json.access_token);
  const days = json.expires_in ? Math.round(json.expires_in / 86400) : 'unknown';
  console.log(`[refreshIgToken] refreshed — valid ~${days} more days`);
  return { refreshed: true, expiresInDays: days };
};
