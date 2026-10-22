#!/usr/bin/env node
// Engine scaling measurements on synthetic data (no Lightroom, no AI, no photos).
// Answers: does journaling, folding, scene grouping and planning stay cheap at
// gallery size? It does NOT measure Lightroom preview rendering or AI latency;
// those come from real read-only runs (see docs/EVIDENCE.md).
//
//   node TonePilot/Benchmarks/scale.mjs [20,100,500]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Journal} from '../Engine/journal.mjs';
import {loadSession, sessionView} from '../Engine/session.mjs';
import {groupScenes} from '../Engine/scenes.mjs';
import {decide} from '../Engine/harmonize.mjs';
import {resolvePolicy} from '../Engine/policy.mjs';

const sizes = (process.argv[2] || '20,100,500').split(',').map(Number);
const ms = t => Math.round(Number(process.hrtime.bigint() - t) / 1e4) / 100;

function syntheticPhoto(i) {
  const scene = Math.floor(i / 25);   // a new lighting scene every 25 frames
  const baseline = {WhiteBalance: 'As Shot', Temperature: 5000 + scene * 300 + (i % 5) * 60, Tint: 4, Exposure2012: 0,
    Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0};
  return {id: String(10000 + i), filename: 'IMG_' + (10000 + i) + '.CR3', state: 'baselined', baseline, origin: baseline,
    capabilities: {supported: true, wb: true, exposure: true, tone: true},
    identity: {id: String(10000 + i), path: '/x/' + i, filename: 'IMG_' + i, captureTime: new Date(Date.UTC(2026, 5, 14, 13) + i * 20000 + scene * 15 * 60000).toISOString().replace('T', ' ').slice(0, 19)},
    exif: {cameraModel: 'R5', flash: scene % 3 === 2 ? 'Did fire' : 'Did not fire', aperture: 'f / 2.8', shutterSpeed: '1/250 sec', isoSpeedRating: 'ISO ' + (400 + scene * 400)},
    snapshot: {exposure: 0, contrast: 0},
    metrics: {subject: {method: 'face', luma: 0.08 + (i % 7) * 0.01, area: 0.03}, clip: {channel: 0.002}, clipAtEV: Array(20).fill(0.002),
      faces: [{hue: 50 + (i % 4), area: 0.03}], grid: Array.from({length: 48}, (_, k) => 40 + scene * 3 + (k % 3))},
    ai: {skip: false, confidence: 0.9, scene: 's', illuminant: 'daylight', mixedLighting: false, backlit: false, intent: 'none',
      skinCast: 'none', subjectExposure: i % 3 ? 'ok' : 'under', proposed: i % 3 ? {} : {Exposure2012: 0.3}, reason: 'synthetic'}};
}

const results = [];
for (const n of sizes) {
  const photos = Array.from({length: n}, (_, i) => syntheticPhoto(i));
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tonepilot-scale-')), 'session-scale');
  const heap0 = process.memoryUsage().heapUsed;
  let t = process.hrtime.bigint();
  const j = Journal.create(dir, 'session-created', {id: 'session-scale', config: {look: 'Natural', strength: 'Balanced', enabled: {wb: true, exposure: true, tone: true}, ids: photos.map(p => p.id)},
    policy: resolvePolicy('Natural', 'Balanced'), engine: {version: 'scale'}, photos: photos.map(p => ({id: p.id, filename: p.filename}))});
  for (const p of photos) {
    j.append('photo-baseline', {photo: p.id, identity: p.identity, baseline: p.baseline, snapshot: p.snapshot, origin: p.origin, capabilities: p.capabilities, exif: p.exif});
    j.append('photo-measured', {photo: p.id, metrics: p.metrics, previewHash: 'x'});
    j.append('photo-assessed', {photo: p.id, ai: p.ai, stats: {ms: 0}});
  }
  const journalMs = ms(t);
  t = process.hrtime.bigint();
  const scenes = groupScenes(photos);
  const scenesMs = ms(t);
  t = process.hrtime.bigint();
  const decisions = decide({photos, scenes, policy: resolvePolicy('Natural', 'Balanced'), enabled: {wb: true, exposure: true, tone: true}});
  const decideMs = ms(t);
  for (const p of photos) j.append('photo-proposed', {photo: p.id, decision: decisions[p.id]});
  // Apply-phase journaling: intent and result per photo, each fsync'd.
  t = process.hrtime.bigint();
  for (const p of photos) {
    j.append('write-intent', {photo: p.id, preValues: p.baseline, preSnapshot: p.snapshot, intended: {Exposure2012: 0.2}});
    j.append('write-result', {photo: p.id, outcome: 'verified', afterValues: {...p.baseline, Exposure2012: 0.2}, afterSnapshot: p.snapshot});
  }
  const applyJournalMs = ms(t);
  j.append('plan-ready'); j.close();
  t = process.hrtime.bigint();
  const view = sessionView(loadSession(dir));
  const foldMs = ms(t);
  const bytes = fs.statSync(path.join(dir, 'journal.jsonl')).size;
  results.push({photos: n, scenes: scenes.length, proposed: Object.values(decisions).filter(d => d.status === 'proposed').length,
    journalRecords: n * 6 + 2, journalKB: Math.round(bytes / 1024),
    msPerRecordAppend: +(journalMs / (n * 3 + 1)).toFixed(3), applyJournalMsPerPhoto: +(applyJournalMs / n).toFixed(3),
    scenesMs, decideMs, foldMs, heapMB: Math.round((process.memoryUsage().heapUsed - heap0) / 1048576)});
  fs.rmSync(path.dirname(dir), {recursive: true, force: true});
}
// End to end through the real engine CLI and the mock bridge at the pilot limit:
// per-photo engine overhead with instant AI, i.e. everything except AI and rendering.
const {setup, rawPhoto} = await import('../tests/helpers.mjs');
const mockPhotos = Object.fromEntries(Array.from({length: 20}, (_, i) => [String(300 + i), rawPhoto('E2E_' + i + '.CR3', {metrics: {faceLuma: 0.06 + (i % 5) * 0.01, clip: 0.001}})]));
const x = setup({photos: mockPhotos});
let endToEnd;
try {
  const ids = Object.keys(mockPhotos);
  let t = process.hrtime.bigint();
  const dir = x.analyze(ids);
  const analyzeMs = ms(t);
  t = process.hrtime.bigint();
  x.run(['--mode', 'apply', '--session', dir, '--confirm']);
  const applyMs = ms(t);
  const applied = x.get().writes.length;
  t = process.hrtime.bigint();
  x.run(['--mode', 'restore', '--session', dir, '--confirm']);
  const restoreMs = ms(t);
  endToEnd = {photos: 20, writes: applied, analyzeMsPerPhoto: +(analyzeMs / 20).toFixed(1),
    applyMsPerWrite: applied ? +(applyMs / applied).toFixed(1) : null, restoreMsPerWrite: applied ? +(restoreMs / applied).toFixed(1) : null};
} finally { x.cleanup(); }
console.log(JSON.stringify({node: process.version, platform: os.platform() + ' ' + os.arch(), cpu: os.cpus()[0]?.model, results, endToEnd}, null, 2));
