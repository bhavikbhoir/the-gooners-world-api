#!/usr/bin/env node
/**
 * Generate a match review locally, without Remotion Lambda.
 *
 * Runs the real pipeline — Bedrock writes the script, Polly narrates it, the
 * audio goes to S3 — and writes the render props to a file plus the captions to
 * stdout. You then render with the frontend's own Remotion install.
 *
 * This exists so videos can be produced and posted by hand before the renderer
 * is provisioned. Same code path as the autopilot, so what you post now is what
 * the autopilot will post later.
 *
 *   node scripts/make-video-props.js <matchId>
 *   node scripts/make-video-props.js --last        # most recent finished match
 */

const fs = require('fs');
const path = require('path');
const { generateMatchVideo } = require('../functions/social/matchVideo');

const ARSENAL_ID = 57;
const API = 'https://api.football-data.org/v4';
const OUT = path.join(__dirname, '..', '.video-props.json');

async function fd(p) {
  const res = await fetch(`${API}${p}`, { headers: { 'X-Auth-Token': process.env.FOOTBALL_API_KEY } });
  if (!res.ok) throw new Error(`football-data ${res.status}: ${await res.text()}`);
  return res.json();
}

const isArsenal = (t) => t?.id === ARSENAL_ID || /^arsenal/i.test(t?.name || '');

async function lastFinishedMatch() {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const { matches } = await fd(`/teams/${ARSENAL_ID}/matches?dateFrom=${from}&dateTo=${to}`);
  const finished = matches.filter((m) => m.status === 'FINISHED');
  if (!finished.length) throw new Error('No finished Arsenal match in the last 60 days');
  return finished.sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))[0];
}

function formFrom(matches, excludeId) {
  return matches
    .filter((m) => m.status === 'FINISHED' && m.id !== excludeId)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 5)
    .map((m) => {
      const home = isArsenal(m.homeTeam);
      const gf = home ? m.score.fullTime.home : m.score.fullTime.away;
      const ga = home ? m.score.fullTime.away : m.score.fullTime.home;
      return gf > ga ? 'W' : gf === ga ? 'D' : 'L';
    })
    .join(' ');
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: node scripts/make-video-props.js <matchId|--last>');
    process.exit(1);
  }
  if (!process.env.FOOTBALL_API_KEY) {
    console.error('FOOTBALL_API_KEY is not set — add it to .env or export it');
    process.exit(1);
  }

  const base = arg === '--last' ? await lastFinishedMatch() : await fd(`/matches/${arg}`);
  const detail = await fd(`/matches/${base.id}`);

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const { matches } = await fd(`/teams/${ARSENAL_ID}/matches?dateFrom=${from}&dateTo=${to}`);

  const standings = await fd('/competitions/PL/standings').catch(() => null);
  const row = standings?.standings?.[0]?.table?.find((r) => isArsenal(r.team));

  const match = {
    matchId: base.id,
    home: base.homeTeam.name,
    away: base.awayTeam.name,
    homeScore: base.score?.fullTime?.home,
    awayScore: base.score?.fullTime?.away,
    competition: base.competition?.name,
    stage: base.stage,
    date: base.utcDate,
    recentForm: formFrom(matches, base.id),
    table: row ? { position: `${row.position}`, points: `${row.points}` } : {},
    goals: (detail.goals || []).map((g) => ({
      minute: g.minute, scorer: g.scorer?.name, team: g.team?.name, type: g.type,
    })),
  };

  console.log(`\n${match.home} ${match.homeScore}–${match.awayScore} ${match.away} · ${match.competition}`);
  console.log('Generating script and narration…\n');

  const { props, script, durationMs, voice } = await generateMatchVideo(match);
  fs.writeFileSync(OUT, JSON.stringify(props, null, 2));

  console.log(`✓ ${(durationMs / 1000).toFixed(1)}s · ${voice.voiceId}/${voice.engine}`);
  console.log(`✓ props written to ${OUT}\n`);
  console.log('─── YOUTUBE TITLE ───\n' + script.youtubeTitle);
  console.log('\n─── YOUTUBE DESCRIPTION ───\n' + script.youtubeDescription);
  console.log('\n─── INSTAGRAM REEL CAPTION ───\n' + script.instagramCaption);
  console.log('\n─── NEXT ───');
  console.log('cd ../the-gooners-world && npm run video:render -- --props=' + OUT);
})().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
