const https = require('https');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = 'tgw-wc-archive';
const TOURNAMENT = 'WC2026';
const API_KEY = process.env.FOOTBALL_API_KEY;
const BASE = 'https://api.football-data.org/v4';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'X-Auth-Token': API_KEY } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Upstream timeout')); });
  });
}

exports.handler = async () => {
  // Fetch current Arsenal squad to get nationalities
  const squadRes = await get(`${BASE}/teams/57`);
  if (squadRes.status !== 200) {
    console.error('Failed to fetch Arsenal squad', squadRes.status);
    return { saved: 0, error: 'squad fetch failed' };
  }

  const squadByNationality = {};
  for (const p of (squadRes.json.squad || [])) {
    if (!p.nationality) continue;
    if (!squadByNationality[p.nationality]) squadByNationality[p.nationality] = [];
    squadByNationality[p.nationality].push({ id: p.id, name: p.name, position: p.position || null });
  }

  // Fetch all finished WC matches
  const matchesRes = await get(`${BASE}/competitions/WC/matches?status=FINISHED`);
  if (matchesRes.status !== 200) {
    console.error('Failed to fetch WC matches', matchesRes.status);
    return { saved: 0, error: 'WC matches fetch failed' };
  }

  const matches = matchesRes.json.matches || [];
  let saved = 0;

  for (const m of matches) {
    const homeCountry = m.homeTeam.name;
    const awayCountry = m.awayTeam.name;
    const homeGunners = (squadByNationality[homeCountry] || []).map(p => ({ ...p, side: 'home', country: homeCountry }));
    const awayGunners = (squadByNationality[awayCountry] || []).map(p => ({ ...p, side: 'away', country: awayCountry }));
    const gunnerPlayers = [...homeGunners, ...awayGunners];

    if (gunnerPlayers.length === 0) continue;

    const sk = `match#${m.id}`;

    // Skip if already archived
    const existing = await docClient.send(new GetCommand({ TableName: TABLE, Key: { pk: TOURNAMENT, sk } }));
    if (existing.Item) continue;

    // Fetch match goals
    let goals = [];
    let gunnerGoals = [];
    try {
      const detailRes = await get(`${BASE}/matches/${m.id}`);
      if (detailRes.status === 200) {
        goals = (detailRes.json.goals || []).map(g => ({
          scorer: g.scorer?.name || 'Unknown',
          team: g.team?.name || '',
          minute: g.minute,
          type: g.type,
        }));
        const gunnerNames = new Set(gunnerPlayers.map(p => p.name));
        gunnerGoals = goals.filter(g => gunnerNames.has(g.scorer));
      }
    } catch { /* goals unavailable — save match without them */ }

    await docClient.send(new PutCommand({
      TableName: TABLE,
      Item: {
        pk: TOURNAMENT,
        sk,
        matchId: m.id,
        homeTeam: homeCountry,
        homeShort: m.homeTeam.shortName || homeCountry,
        homeCrest: m.homeTeam.crest || '',
        awayTeam: awayCountry,
        awayShort: m.awayTeam.shortName || awayCountry,
        awayCrest: m.awayTeam.crest || '',
        homeScore: m.score?.fullTime?.home ?? null,
        awayScore: m.score?.fullTime?.away ?? null,
        date: m.utcDate,
        stage: m.stage || '',
        group: m.group || null,
        status: 'FINISHED',
        gunnerPlayers,
        gunnerGoals,
        goals,
        archivedAt: Date.now(),
      },
    }));
    saved++;
    console.log(`Archived WC match ${m.id}: ${homeCountry} vs ${awayCountry}`);
  }

  console.log(`WC Cron complete: ${saved} new matches archived`);
  return { saved };
};
