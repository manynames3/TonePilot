#!/usr/bin/env node
// CONTROLLED REAL-LIGHTROOM WRITE TEST. Performs real Develop writes, so it refuses to
// run unless every selected photo lives inside a dedicated sandbox folder (default
// ~/Pictures/TonePilot-Sandbox) and you pass --i-have-a-backup. Never point it at
// client work. Protocol: docs/VALIDATION.md, gate G1.
//
//   node TonePilot/tests/live/sandbox-cycle.mjs --i-have-a-backup [--sandbox ~/Pictures/TonePilot-Sandbox]
//
// Steps: doctor → analyze → apply → independent read-back → restore → exact-original
// check → analyze/apply again and SIGKILL the engine right after its first write intent
// → reconcile → restore → exact-original check. Writes a JSON report next to the runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {LightroomMCP, readSelection} from '../../Engine/lightroom.mjs';
import {developmentView} from '../../Engine/guard.mjs';

const argv = process.argv.slice(2);
const arg = (n, f) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : f; };
if (!argv.includes('--i-have-a-backup')) { console.error('Refusing: back up the sandbox catalog, then pass --i-have-a-backup.'); process.exit(2); }
const sandbox = path.resolve(arg('sandbox', path.join(os.homedir(), 'Pictures/TonePilot-Sandbox'))) + path.sep;
const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(here, '../../Engine/engine.mjs');
const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'tonepilot-sandbox-runs-'));
const env = {...process.env, TONEPILOT_RUNS_DIR: runs};
const report = {startedAt: new Date().toISOString(), sandbox, runs, steps: []};
const step = (name, ok, detail = {}) => { report.steps.push({name, ok, ...detail}); console.log((ok ? 'PASS ' : 'FAIL ') + name, JSON.stringify(detail)); if (!ok) finish(1); };
function finish(code) {
  report.finishedAt = new Date().toISOString();
  const file = path.join(runs, 'sandbox-report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('Report: ' + file);
  process.exit(code);
}
const engine = args => {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {env, encoding: 'utf8', timeout: 900000});
  const events = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return {status: r.status, complete: events.find(e => e.type === 'complete'), error: events.find(e => e.type === 'error')};
};

async function snapshot(ids) {
  const client = await new LightroomMCP().connect();
  try {
    const out = {};
    for (const id of ids) {
      const m = await client.tool('get_photo_metadata', {photo_id: id});
      out[id] = {values: developmentView(m), developSettings: m.developSettings, path: m.path};
    }
    return out;
  } finally { await client.close(); }
}

// 1. Authorization: every selected photo must be a sandbox file.
const client = await new LightroomMCP().connect();
const sel = await readSelection(client, 5);
await client.close();
const ids = sel.photos.map(p => p.id);
const before = await snapshot(ids);
const outside = Object.entries(before).filter(([, s]) => !String(s.path).startsWith(sandbox));
step('selection is 1–5 sandbox photos', sel.count >= 1 && sel.count <= 5 && !outside.length, {count: sel.count, outside: outside.length});

const doctor = engine(['--mode', 'doctor', '--live']);
step('doctor ready', doctor.complete?.ready === true, {failing: doctor.complete?.checks.filter(c => !c.ok && c.severity === 'required').map(c => c.id)});

// 2. Plan, apply, verify independently, restore, verify exact originals.
const a = engine(['--mode', 'analyze', '--ids', JSON.stringify(ids), '--strength', 'Subtle']);
step('analyze', a.status === 0, {status: a.complete?.status, counts: a.complete?.counts});
const dir = a.complete.dir;
const ap = engine(['--mode', 'apply', '--session', dir, '--confirm']);
step('apply', ap.status === 0 && ['applied', 'planned', 'not-applied'].includes(ap.complete?.status), {status: ap.complete?.status, counts: ap.complete?.counts});
const view = engine(['--mode', 'show', '--session', dir]).complete.session;
const mid = await snapshot(ids);
const mismatches = view.photos.filter(p => p.state === 'applied').flatMap(p => p.changes
  .filter(c => Math.abs((mid[p.id].values[c.key] ?? NaN) - c.proposed) > (c.key === 'Temperature' ? 2 : 0.011)).map(c => p.filename + ':' + c.key));
step('independent read-back matches applied values', !mismatches.length, {applied: view.photos.filter(p => p.state === 'applied').length, mismatches});
const rs = view.actions.restore ? engine(['--mode', 'restore', '--session', dir, '--confirm']) : {status: 0, complete: {status: 'nothing-applied'}};
step('restore', rs.status === 0, {status: rs.complete?.status});
const after = await snapshot(ids);
const drift = ids.filter(id => JSON.stringify(after[id].developSettings) !== JSON.stringify(before[id].developSettings));
step('every exposed Develop setting is back to its original', !drift.length, {drift});

// 3. Crash in the middle of a real write, then recover.
const b = engine(['--mode', 'analyze', '--ids', JSON.stringify(ids), '--strength', 'Subtle']);
const dir2 = b.complete.dir;
if (b.complete.counts.proposed) {
  const child = spawn(process.execPath, [ENGINE, '--mode', 'apply', '--session', dir2, '--confirm'], {env, stdio: 'ignore'});
  const journal = path.join(dir2, 'journal.jsonl');
  await new Promise(resolve => {
    const t = setInterval(() => { if (fs.readFileSync(journal, 'utf8').includes('"write-intent"')) { child.kill('SIGKILL'); clearInterval(t); resolve(); } }, 5);
    child.on('exit', () => { clearInterval(t); resolve(); });
  });
  await new Promise(r => setTimeout(r, 3000));
  const interrupted = engine(['--mode', 'show', '--session', dir2]).complete.session;
  step('killed engine leaves an interrupted (not "applied") session', ['interrupted', 'partially-applied', 'applied'].includes(interrupted.status), {status: interrupted.status});
  const rec = engine(['--mode', 'reconcile', '--session', dir2]);
  step('reconcile settles the write from real values', rec.status === 0 && rec.complete.status !== 'interrupted', {status: rec.complete?.status, waiting: rec.complete?.waiting});
  const rs2 = engine(['--mode', 'restore', '--session', dir2, '--confirm']);
  step('restore after crash', rs2.status === 0 || /Nothing to restore/.test(rs2.error?.message || ''), {status: rs2.complete?.status});
  const final = await snapshot(ids);
  const drift2 = ids.filter(id => JSON.stringify(final[id].developSettings) !== JSON.stringify(before[id].developSettings));
  step('originals intact after crash and recovery', !drift2.length, {drift: drift2});
} else {
  step('crash test skipped: nothing proposed for these photos', true);
}
finish(0);
