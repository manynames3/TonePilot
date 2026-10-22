#!/usr/bin/env node
// Test–retest repeatability: analyze the same photos two or more times and measure how
// often TonePilot reaches the same decision. Needs no photographer and no writes, so it
// is the cheapest honest signal about model noise. Agreement is NOT quality: a system
// can be consistently wrong. Use it alongside the blind evaluation (evaluate.mjs).
//
//   node repeatability.mjs <session-dir> <session-dir> [...]
import path from 'node:path';
import {loadSession} from '../Engine/session.mjs';

const STEP = {Exposure2012: 0.1, Temperature: 100, Tint: 3, Highlights2012: 5, Shadows2012: 5, Whites2012: 5, Blacks2012: 5};

export function repeatability(sessions) {
  const ids = sessions[0].order.filter(id => sessions.every(s => s.photos[id]));
  const rows = [];
  for (const id of ids) {
    const runs = sessions.map(s => s.photos[id]);
    const statuses = runs.map(p => p.state);
    const keys = new Set(runs.flatMap(p => Object.keys(p.changes || {})));
    const spread = {};
    for (const k of keys) {
      const vals = runs.map(p => (p.changes?.[k] ?? p.baseline?.[k]) - (p.baseline?.[k] ?? 0));
      spread[k] = Math.max(...vals) - Math.min(...vals);
    }
    const sameDecision = statuses.every(s => s === statuses[0]);
    const closeValues = Object.entries(spread).every(([k, d]) => d <= (STEP[k] ?? 0));
    const ai = runs.map(p => p.ai?.subjectExposure || null);
    rows.push({id, filename: runs[0].filename, statuses, sameDecision, sameSettings: sameDecision && closeValues, spread,
      sameJudgment: ai.every(a => a === ai[0]), confidence: runs.map(p => p.ai?.confidence ?? null)});
  }
  const n = rows.length || 1;
  return {photos: rows.length, runs: sessions.length,
    decisionAgreement: rows.filter(r => r.sameDecision).length / n,
    settingAgreement: rows.filter(r => r.sameSettings).length / n,
    judgmentAgreement: rows.filter(r => r.sameJudgment).length / n,
    tolerance: STEP, rows};
}

if (import.meta.url === 'file://' + path.resolve(process.argv[1] || '')) {
  const dirs = process.argv.slice(2);
  if (dirs.length < 2) { console.error('Usage: node repeatability.mjs <session-dir> <session-dir> [...]'); process.exit(2); }
  const sessions = dirs.map(d => { const s = loadSession(path.resolve(d)); if (!s) throw new Error('Empty session ' + d); return s; });
  console.log(JSON.stringify(repeatability(sessions), null, 2));
}
