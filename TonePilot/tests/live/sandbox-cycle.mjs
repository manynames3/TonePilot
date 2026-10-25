#!/usr/bin/env node
// CONTROLLED REAL-LIGHTROOM WRITE TEST. Performs real Develop writes, so it refuses to
// run unless every selected photo lives inside a dedicated sandbox folder (default
// ~/Pictures/TonePilot-Sandbox) and you pass --i-have-a-backup. Never point it at
// client work. Protocol: docs/VALIDATION.md, gate G1.
//
//   node TonePilot/tests/live/sandbox-cycle.mjs --i-have-a-backup [--sandbox ~/Pictures/TonePilot-Sandbox]
//
// Cycle 1: doctor → analyze → apply → independent read-back (≥1 real exposure write, ≥1
// real Temperature/Tint write when a photo is RAW, WB mode "Custom") → simulated
// photographer edit on one photo → restore (that photo must be refused and left alone,
// the others restored) → the photographer puts TonePilot's value back → restore → every
// exposed Develop field byte-identical to the original, original WB mode included.
// Cycle 2: analyze → apply, SIGKILL the engine right after its first write intent →
// reconcile → restore → originals again. Any FAIL stops the run. A JSON report is written.
// tests/sandbox-cycle.test.mjs runs this script against the mock Lightroom.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {connectLightroom, readSelection, TESTED_BRIDGE_VERSION} from '../../Engine/lightroom.mjs';
import {developmentView} from '../../Engine/guard.mjs';

const argv = process.argv.slice(2);
const arg = (n, f) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : f; };
if (!argv.includes('--i-have-a-backup')) { console.error('Refusing: back up the sandbox catalog, then pass --i-have-a-backup.'); process.exit(2); }
// Symlinks are resolved where the path exists, and the folder must be the dedicated one: an
// over-broad --sandbox (~ or /Users) would otherwise admit every photo below it.
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const sandboxDir = real(arg('sandbox', path.join(os.homedir(), 'Pictures/TonePilot-Sandbox')));
if (path.basename(sandboxDir) !== 'TonePilot-Sandbox') { console.error('Refusing: the sandbox folder must be named TonePilot-Sandbox.'); process.exit(2); }
const sandbox = sandboxDir + path.sep;
const inSandbox = p => typeof p === 'string' && path.isAbsolute(p) && real(p).startsWith(sandbox);
const here = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(here, '../../Engine/engine.mjs');
const runs = process.env.TONEPILOT_RUNS_DIR ? path.resolve(process.env.TONEPILOT_RUNS_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'tonepilot-sandbox-runs-'));
fs.mkdirSync(runs, {recursive: true, mode: 0o700});
const env = {...process.env, TONEPILOT_RUNS_DIR: runs};
const report = {startedAt: new Date().toISOString(), sandbox, runs, bridge: null, lightroom: null, developFields: [], steps: [], pass: false};
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, e => step('no unexpected error', false, {message: String(e?.message || e)}));

let pendingEdit = null;   // the simulated photographer edit, until it is put back
function finish(code) {
  report.finishedAt = new Date().toISOString();
  if (pendingEdit && code !== 0) {
    report.recovery = 'Photo ' + pendingEdit.id + ': the simulated edit set Exposure to ' + pendingEdit.to + '. Set it back to ' +
      pendingEdit.from + ' in Lightroom (or restore the catalog backup), then restore the session.';
    console.log('RECOVERY ' + report.recovery);
  }
  report.pass = code === 0 && report.steps.length > 0 && report.steps.every(s => s.ok);
  const file = path.join(runs, 'sandbox-report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log((report.pass ? 'OVERALL PASS' : 'OVERALL FAIL') + '\nReport: ' + file);
  process.exit(report.pass ? 0 : 1);
}
const step = (name, ok, detail = {}) => {
  report.steps.push({name, ok: !!ok, ...detail});
  console.log((ok ? 'PASS ' : 'FAIL ') + name, JSON.stringify(detail));
  if (!ok) finish(1);
};
const engine = args => {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {env, encoding: 'utf8', timeout: 900000});
  const events = (r.stdout || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
  return {status: r.status, complete: events.find(e => e.type === 'complete'), error: events.find(e => e.type === 'error')};
};
const show = dir => engine(['--mode', 'show', '--session', dir]).complete.session;

async function withBridge(fn) {
  const client = await connectLightroom();
  try { return await fn(client); } finally { await client.close(); }
}
const snapshot = ids => withBridge(async client => {
  const out = {};
  for (const id of ids) {
    const m = await client.tool('get_photo_metadata', {photo_id: id});
    out[id] = {values: developmentView(m), developSettings: m.developSettings, path: m.path, format: String(m.fileFormat || '').toUpperCase()};
  }
  return out;
});
// Exposed Develop fields whose serialized value differs at all (byte-identical check).
const drift = (a, b) => [...new Set([...Object.keys(a.developSettings), ...Object.keys(b.developSettings)])]
  .filter(k => JSON.stringify(a.developSettings[k]) !== JSON.stringify(b.developSettings[k]));
const driftOf = (ids, a, b) => Object.fromEntries(ids.map(id => [id, drift(a[id], b[id])]).filter(([, f]) => f.length));
const WB = ['WhiteBalance', 'Temperature', 'Tint'];
const wbBack = (ids, now) => ids.filter(id => WB.some(k => now[id].values[k] !== before[id].values[k]));

// 1. Authorization: every selected photo must be a sandbox file.
const sel = await withBridge(async client => {
  report.bridge = {kind: client.kind, name: client.serverInfo?.name || null, version: client.serverInfo?.version || null, tested: TESTED_BRIDGE_VERSION};
  report.lightroom = client.serverInfo?.lightroom || null;
  return readSelection(client, 5);
});
const ids = sel.photos.map(p => p.id);
const before = await snapshot(ids);
const outside = ids.filter(id => !inSandbox(sel.photos.find(p => p.id === id).path) || !inSandbox(before[id].path));
report.developFields = [...new Set(Object.values(before).flatMap(s => Object.keys(s.developSettings)))].sort();
step('bridge is the tested version', report.bridge.kind !== 'mcp' || report.bridge.version === TESTED_BRIDGE_VERSION, report.bridge);
step('selection is 1–5 sandbox photos', sel.count >= 1 && sel.count <= 5 && !sel.truncated && !outside.length, {count: sel.count, outside: outside.length});
const rawIds = ids.filter(id => ['RAW', 'DNG'].includes(before[id].format));

// Lightroom installed/running and the bridge plug-in are already proven by the live reads above.
const PROVEN = ['lightroom-installed', 'lightroom-running', 'plugin', 'plugin-server'];
const doctor = engine(['--mode', 'doctor', '--live']);
const failing = doctor.complete ? doctor.complete.checks.filter(c => !c.ok && c.severity === 'required').map(c => c.id) : ['doctor did not run'];
step('doctor ready', failing.every(id => PROVEN.includes(id)), {failing, provenByLiveReads: failing.filter(id => PROVEN.includes(id))});

// 2. Plan, apply, verify independently.
const a = engine(['--mode', 'analyze', '--ids', JSON.stringify(ids), '--strength', 'Subtle']);
step('analyze', a.status === 0 && !!a.complete?.dir, {status: a.complete?.status, counts: a.complete?.counts, error: a.error?.message});
const dir = a.complete.dir;
const ap = engine(['--mode', 'apply', '--session', dir, '--confirm']);
step('apply: every approved edit written and verified', ap.status === 0 && ap.complete?.status === 'applied', {status: ap.complete?.status, counts: ap.complete?.counts, stopped: ap.complete?.stopped, error: ap.error?.message});
const view = show(dir);
const applied = view.photos.filter(p => p.state === 'applied');
const mid = await snapshot(ids);
const mismatches = applied.flatMap(p => p.changes
  .filter(c => Math.abs((mid[p.id].values[c.key] ?? NaN) - c.proposed) > (c.key === 'Temperature' ? 2 : 0.011)).map(c => p.filename + ':' + c.key));
step('independent read-back matches applied values', applied.length > 0 && !mismatches.length, {applied: applied.length, mismatches});
const moved = (p, key) => p.changes.some(c => c.key === key) && Math.abs(mid[p.id].values[key] - before[p.id].values[key]) > (key === 'Temperature' ? 2 : 0.005);
const exposed = applied.filter(p => moved(p, 'Exposure2012'));
const wbIds = applied.filter(p => rawIds.includes(p.id) && (moved(p, 'Temperature') || moved(p, 'Tint'))).map(p => p.id);
step('real writes happened: ≥1 exposure, and ≥1 Temperature/Tint when a photo is RAW', exposed.length >= 1 && (!rawIds.length || wbIds.length >= 1),
  {exposureWrites: exposed.length, wbWrites: wbIds.length, rawPhotos: rawIds.length});
step('RAW white-balance writes show WhiteBalance "Custom"', wbIds.every(id => mid[id].values.WhiteBalance === 'Custom'),
  {modes: Object.fromEntries(wbIds.map(id => [id, mid[id].values.WhiteBalance]))});

// 3. Manual-edit refusal. The photographer's edit is simulated with one direct bridge write
// to a sandbox photo; restore must refuse that photo, leave the edit alone and restore the rest.
const edited = exposed[0].id, tpValue = mid[edited].values.Exposure2012;
const manual = Math.round((tpValue + (tpValue > 4 ? -0.4 : 0.4)) * 100) / 100;
const setExposure = (id, value) => withBridge(c => c.tool('set_develop_settings', {photo_id: id, settings: {Exposure2012: value}}));
pendingEdit = {id: edited, from: tpValue, to: manual};
await setExposure(edited, manual);
const handEdited = (await snapshot([edited]))[edited];
step('simulated photographer edit (sandbox only): Exposure2012 set through the bridge', Math.abs(handEdited.values.Exposure2012 - manual) < 0.006, {photo: edited, from: tpValue, to: manual});
const others = applied.map(p => p.id).filter(id => id !== edited);
const r1 = engine(['--mode', 'restore', '--session', dir, '--confirm']);
const v1 = show(dir), s1 = await snapshot(ids);
const ed = v1.photos.find(p => p.id === edited);
step('restore refuses the edited photo and leaves the edit untouched', r1.status === 0 && !!ed.restoreConflict && ed.state === 'applied' && !drift(handEdited, s1[edited]).length,
  {state: ed.state, conflict: ed.restoreConflict?.fields, changed: drift(handEdited, s1[edited])});
function checkRestored(label, which, view, now) {
  const wb = wbIds.filter(id => which.includes(id));
  step(label + ': RAW white balance back to its original mode and Temperature/Tint', !wbBack(wb, now).length,
    {checked: wb.length, modes: Object.fromEntries(wb.map(id => [id, [before[id].values.WhiteBalance, now[id].values.WhiteBalance]]))});
  const d = driftOf(which, before, now);
  step(label + ': every exposed Develop field byte-identical to the original', !Object.keys(d).length, {photos: which.length, drift: d});
  const states = view.photos.filter(p => which.includes(p.id) && p.state !== 'restored').map(p => p.id + ':' + p.state);
  step(label + ': session reports them restored', !states.length, {notRestored: states});
}
checkRestored('other photos', others, v1, s1);
await setExposure(edited, tpValue);
pendingEdit = null;
step('photographer puts TonePilot\'s value back (sandbox only)', (await snapshot([edited]))[edited].values.Exposure2012 === tpValue, {photo: edited, value: tpValue});
const r2 = engine(['--mode', 'restore', '--session', dir, '--confirm']);
const v2 = show(dir);
step('restore', r2.status === 0 && v2.status === 'restored', {status: v2.status, error: r2.error?.message});
const s2 = await snapshot(ids);
checkRestored('all photos', applied.map(p => p.id), v2, s2);
step('cycle 1 leaves every photo exactly as it was', !Object.keys(driftOf(ids, before, s2)).length, {drift: driftOf(ids, before, s2)});

// 4. Crash in the middle of a real write, then recover.
const b = engine(['--mode', 'analyze', '--ids', JSON.stringify(ids), '--strength', 'Subtle']);
step('analyze for the crash test', b.status === 0 && b.complete?.counts?.proposed > 0, {counts: b.complete?.counts, error: b.error?.message});
const dir2 = b.complete.dir;
const child = spawn(process.execPath, [ENGINE, '--mode', 'apply', '--session', dir2, '--confirm'], {env, stdio: 'ignore'});
const journal = path.join(dir2, 'journal.jsonl');
const killed = await new Promise(resolve => {
  const t = setInterval(() => {
    let text = '';
    try { text = fs.readFileSync(journal, 'utf8'); } catch { /* not yet */ }
    if (text.includes('"write-intent"')) { clearInterval(t); child.kill('SIGKILL'); }
  }, 5);
  child.on('exit', (code, signal) => { clearInterval(t); resolve(signal === 'SIGKILL'); });
});
await sleep(1000);
const interrupted = show(dir2);
step('engine killed right after its first write intent leaves an interrupted session', killed && interrupted.status === 'interrupted', {killed, status: interrupted.status});
let rec;
for (let i = 0; i < 24; i++) {   // Lightroom may still be settling the write; reconcile waits for it
  rec = engine(['--mode', 'reconcile', '--session', dir2]);
  if (rec.status !== 0 || !rec.complete?.waiting?.length) break;
  await sleep(5000);
}
step('reconcile settles the write from real values', rec.status === 0 && rec.complete.status !== 'interrupted', {status: rec.complete?.status, waiting: rec.complete?.waiting});
const rs2 = engine(['--mode', 'restore', '--session', dir2, '--confirm']);
step('restore after crash', rs2.status === 0 || /Nothing to restore/.test(rs2.error?.message || ''), {status: rs2.complete?.status, error: rs2.error?.message});
const v3 = show(dir2);
const unsettled = v3.photos.filter(p => ['writing', 'restoring', 'applied', 'apply-mismatch', 'restore-mismatch'].includes(p.state)).map(p => p.id + ':' + p.state);
step('no photo left unconfirmed or changed after the crash', !unsettled.length && ['restored', 'not-applied'].includes(v3.status), {status: v3.status, unsettled});
const final = await snapshot(ids);
step('originals intact after crash and recovery', !Object.keys(driftOf(ids, before, final)).length, {drift: driftOf(ids, before, final)});
finish(0);
