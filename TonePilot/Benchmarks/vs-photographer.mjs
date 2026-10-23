#!/usr/bin/env node
// How close does TonePilot get to the photographer's own edits? Read-only, two steps,
// because Lightroom has one catalog open at a time:
//
//   1. Main catalog, the photographer's FINISHED photos selected:
//        node vs-photographer.mjs capture --out reference.json
//      records each photo's final white balance and exposure (no Develop setting is changed).
//   2. Test catalog holding fresh, unedited copies of the same files, selected:
//        TonePilot analyze (any AI service), then
//        node vs-photographer.mjs compare reference.json <session-dir> [...]
//      matches photos by filename and capture time and compares, per setting, how far the
//      unedited photo and TonePilot's plan are from the photographer's final value.
//
// Only the settings TonePilot writes are compared. The photographer's edit may also use
// profiles, curves or masks that change how a value looks, so this measures direction and
// distance, not taste. reference.json holds filenames: keep it private.
import fs from 'node:fs';
import path from 'node:path';
import {loadSession} from '../Engine/session.mjs';
import {mired} from '../Engine/policy.mjs';

const KEYS = {Temperature: v => mired(v), Tint: v => v, IncrementalTemperature: v => v, IncrementalTint: v => v, Exposure2012: v => v};
const UNIT = {Temperature: 'mired', Tint: 'tint', IncrementalTemperature: 'steps', IncrementalTint: 'steps', Exposure2012: 'EV'};
const keyOf = (filename, captureTime) => filename + '|' + captureTime;

async function capture(out) {
  const {connectLightroom, readSelection} = await import('../Engine/lightroom.mjs');
  const {developmentView} = await import('../Engine/guard.mjs');
  const client = await connectLightroom();
  try {
    const {photos} = await readSelection(client, 500);
    const records = [];
    for (const p of photos) {
      const m = await client.tool('get_photo_metadata', {photo_id: p.id});
      records.push({filename: m.filename, captureTime: String(m.dateTimeOriginal || ''), final: developmentView(m)});
    }
    fs.writeFileSync(out, JSON.stringify({captured: new Date().toISOString(), photos: records}, null, 1), {mode: 0o600});
    return records.length;
  } finally { await client.close(); }
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const round = x => (x == null ? null : Math.round(x * 100) / 100);

export function compare(reference, sessions) {
  const finals = new Map(reference.photos.map(r => [keyOf(r.filename, r.captureTime), r.final]));
  const rows = [], states = {};
  for (const s of sessions) for (const id of s.order) {
    const p = s.photos[id];
    const final = finals.get(keyOf(p.identity?.filename, p.identity?.captureTime));
    if (!final || !p.baseline) continue;
    states[p.state] = (states[p.state] || 0) + 1;
    for (const [key, scale] of Object.entries(KEYS)) {
      const start = p.baseline[key], target = final[key];
      if (typeof start !== 'number' || typeof target !== 'number') continue;
      const planned = p.changes?.[key] ?? start;
      const before = Math.abs(scale(start) - scale(target)), after = Math.abs(scale(planned) - scale(target));
      const wanted = Math.sign(scale(target) - scale(start)), moved = Math.sign(scale(planned) - scale(start));
      rows.push({photo: p.filename, key, before, after, moved: moved !== 0, wrongWay: moved !== 0 && wanted !== 0 && moved !== wanted});
    }
  }
  const byKey = Object.keys(KEYS).map(key => {
    const r = rows.filter(x => x.key === key);
    if (!r.length) return null;
    const edited = r.filter(x => x.before > 1e-6);   // settings the photographer actually changed
    return {setting: key, unit: UNIT[key], photos: r.length, photographerChanged: edited.length,
      medianDistanceUnedited: round(median(edited.map(x => x.before))), medianDistanceTonePilot: round(median(edited.map(x => x.after))),
      closer: edited.filter(x => x.after < x.before - 1e-6).length, further: edited.filter(x => x.after > x.before + 1e-6).length,
      wrongDirection: r.filter(x => x.wrongWay).length, changedWhenPhotographerDidNot: r.filter(x => x.before <= 1e-6 && x.moved).length};
  }).filter(Boolean);
  return {matchedPhotos: Object.values(states).reduce((a, b) => a + b, 0), states, bySetting: byKey};
}

if (import.meta.url === 'file://' + path.resolve(process.argv[1] || '')) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'capture' && rest[0] === '--out' && rest[1]) {
    console.log('Recorded ' + await capture(path.resolve(rest[1])) + ' photos (read-only) to ' + rest[1]);
  } else if (cmd === 'compare' && rest.length >= 2) {
    const reference = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
    const sessions = rest.slice(1).map(d => loadSession(path.resolve(d))).filter(Boolean);
    console.log(JSON.stringify(compare(reference, sessions), null, 2));
  } else {
    console.error('Usage: vs-photographer.mjs capture --out reference.json | compare reference.json <session-dir> [...]');
    process.exit(2);
  }
}
