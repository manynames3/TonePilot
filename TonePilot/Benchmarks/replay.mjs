#!/usr/bin/env node
// Re-plan stored sessions with the current engine, offline: the journals already hold each
// photo's measurements and AI assessment, so no Lightroom and no model call is needed.
// Reports, per scene, how consistent skin brightness is before and as planned. Read-only.
//
//   node replay.mjs [runs-dir] [--strength Stronger] [--per-photo]
import os from 'node:os';
import path from 'node:path';
import {listSessionDirs, loadSession} from '../Engine/session.mjs';
import {decide} from '../Engine/harmonize.mjs';
import {resolvePolicy} from '../Engine/policy.mjs';
import {sceneConsistency} from '../Engine/consistency.mjs';

export function replay(session, {look, strength} = {}) {
  const policy = resolvePolicy(look || session.config?.look || 'Natural', strength || session.config?.strength || 'Balanced');
  const enabled = {wb: true, exposure: true, tone: false};
  const photos = session.order.map(id => session.photos[id]).filter(p => p.baseline && p.state !== 'unsupported')
    .map(p => ({...p, state: 'baselined', changes: {}, post: null}));
  const out = decide({photos, scenes: session.scenes, policy, enabled});
  return session.scenes.map(sc => {
    const members = sc.photos.map(id => photos.find(p => p.id === id)).filter(Boolean).map(p => ({...p, changes: out[p.id]?.changes || {}, status: out[p.id]?.status}));
    return {scene: sc.id, photos: members, consistency: sceneConsistency(members)};
  });
}

if (import.meta.url === 'file://' + path.resolve(process.argv[1] || '')) {
  const args = process.argv.slice(2), opt = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
  const runs = args[0] && !args[0].startsWith('--') ? args[0] : path.join(os.homedir(), 'Library/Application Support/TonePilot/runs');
  const seen = new Set(), wb = {n: 0, mb: 0, mp: 0, tb: 0, tp: 0}; let scenes = 0, better = 0, worse = 0, before = 0, planned = 0;
  for (const dir of listSessionDirs(runs)) {
    let s; try { s = loadSession(dir); } catch { continue; }
    if (!s?.scenes?.length) continue;
    for (const r of replay(s, {strength: opt('strength')})) {
      const key = r.photos.map(p => p.identity?.filename + ':' + p.previewHash).join('|');
      if (!r.consistency || seen.has(key)) continue;   // the same photos analyzed again count once
      seen.add(key); scenes++;
      const c = r.consistency;
      before += c.before.brightnessEV; planned += c.planned.brightnessEV;
      if (c.before.whiteBalanceMired != null) { wb.n++; wb.mb += c.before.whiteBalanceMired; wb.mp += c.planned.whiteBalanceMired; wb.tb += c.before.whiteBalanceTint; wb.tp += c.planned.whiteBalanceTint; }
      if (c.planned.brightnessEV < c.before.brightnessEV - 0.05) better++; else if (c.planned.brightnessEV > c.before.brightnessEV + 0.05) worse++;
      console.log('scene of ' + c.before.frames + ' faces: brightness range ' + c.before.brightnessEV + ' → ' + c.planned.brightnessEV + ' EV planned' +
        ' | WB settings range ' + c.before.whiteBalanceMired + ' → ' + c.planned.whiteBalanceMired + ' mired, tint ' + c.before.whiteBalanceTint + ' → ' + c.planned.whiteBalanceTint + ' | ' +
        Object.entries(r.photos.reduce((o, p) => (o[p.status] = (o[p.status] || 0) + 1, o), {})).map(([k, v]) => v + ' ' + k).join(', '));
      if (args.includes('--per-photo')) for (const p of r.photos) console.log('   face ' + (p.metrics?.subject?.method === 'face' ? Math.log2(p.metrics.subject.luma).toFixed(2) + ' EV' : '—') +
        '  ai ' + (p.ai?.subjectExposure || '—') + ' ' + (p.ai?.confidence ?? '') + '  ' + p.status + '  ' + JSON.stringify(p.changes));
    }
  }
  console.log(scenes + ' scenes: brightness range ' + (before / scenes).toFixed(2) + ' → ' + (planned / scenes).toFixed(2) + ' EV on average; ' +
    better + ' more consistent, ' + worse + ' less, ' + (scenes - better - worse) + ' unchanged');
  if (wb.n) console.log(wb.n + ' RAW scenes: white-balance settings range ' + (wb.mb / wb.n).toFixed(1) + ' → ' + (wb.mp / wb.n).toFixed(1) + ' mired, tint ' +
    (wb.tb / wb.n).toFixed(1) + ' → ' + (wb.tp / wb.n).toFixed(1) + ' on average');
}
