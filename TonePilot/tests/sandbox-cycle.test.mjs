// The G1 sandbox script itself, end to end against the mock Lightroom. HOME points into the
// test's temp folder, so the default sandbox path and the photos' paths are temp strings;
// the bridge is the mock (TONEPILOT_MCP_ARGS) and nothing reaches a real catalog.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {join, resolve, dirname} from 'node:path';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setup, rawPhoto} from './helpers.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'live/sandbox-cycle.mjs');
const AI = {skip: false, confidence: 0.95, scene: 'open shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
  intent: 'none', skinCast: 'too-cool', subjectExposure: 'under',
  changes: [{setting: 'Exposure2012', value: 0.3}, {setting: 'Temperature', value: 5600}], reason: 'Test fixture: cool and dark'};

function cycle({photos = ['101', '102'], faults = {}, outside = null} = {}) {
  const x = setup({photos: Object.fromEntries(photos.map(id => [id, rawPhoto('S_' + id + '.CR3')])), faults: {writeDelayMs: 150, ...faults}, extra: {aiDefault: AI}});
  const home = join(x.temp, 'home');
  x.set(s => { for (const [id, p] of Object.entries(s.photos)) p.path = id === outside ? '/Volumes/Client/' + p.filename : join(home, 'Pictures/TonePilot-Sandbox', p.filename); });
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--i-have-a-backup'], {env: {...x.env, HOME: home}, encoding: 'utf8', timeout: 120000});
    let report = null;
    try { report = JSON.parse(readFileSync(join(x.runs, 'sandbox-report.json'), 'utf8')); } catch { /* none written */ }
    return {status: r.status, out: r.stdout + r.stderr, report, failed: report?.steps.find(s => !s.ok)?.name, writes: x.get().writes};
  } finally { x.cleanup(); }
}

test('a healthy mock Lightroom passes every G1 step', () => {
  const r = cycle();
  assert.equal(r.status, 0, r.out);
  assert.equal(r.report.pass, true);
  assert.deepEqual([r.report.bridge.kind, r.report.bridge.version], ['mcp', '0.24.1']);
  assert.ok(r.report.developFields.includes('whiteBalance'));
  const counts = r.report.steps.find(s => s.name.startsWith('real writes happened'));
  assert.equal(counts.exposureWrites, 2); assert.equal(counts.wbWrites, 2);
  for (const name of ['restore refuses the edited photo', 'RAW white balance back', 'killed right after', 'originals intact'])
    assert.ok(r.report.steps.some(s => s.ok && s.name.includes(name)), name);
});

test('writes Lightroom reports as done but never makes fail the cycle', () => {
  const r = cycle({faults: {ignoreWrites: true}});
  assert.equal(r.status, 1);
  assert.equal(r.report.pass, false);
  assert.match(r.failed, /^apply/);
});

test('a restore that leaves the WB mode on Custom fails the cycle', () => {
  const r = cycle({faults: {stickyCustomWB: true}});
  assert.equal(r.status, 1);
  assert.match(r.failed, /white balance back to its original mode/);
});

test('a restore that overwrites the photographer\'s edit fails the cycle', () => {
  // Writes 1–2 apply, 3 is the simulated edit on 101, 4 restores 102 and Auto Sync copies it onto 101.
  const r = cycle({faults: {syncWritesFrom: 4}});
  assert.equal(r.status, 1);
  assert.match(r.failed, /restore refuses the edited photo/);
});

test('refuses before any write when a selected photo is outside the sandbox folder', () => {
  const r = cycle({outside: '102'});
  assert.equal(r.status, 1);
  assert.equal(r.failed, 'selection is 1–5 sandbox photos');
  assert.equal(r.writes.length, 0);
  assert.equal(spawnSync(process.execPath, [SCRIPT], {encoding: 'utf8'}).status, 2, 'and without --i-have-a-backup');
});
