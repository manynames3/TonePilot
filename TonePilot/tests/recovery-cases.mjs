// Failure injection: interrupted writes and restores, killed engines, a closed or slow
// Lightroom bridge, conflicting manual edits, and journal damage. Run once per bridge by
// recovery.test.mjs (MCP bridge) and recovery-plugin.test.mjs (TonePilot's plug-in), as
// separate files so the two run in parallel.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appendFileSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setup, rawPhoto, ENGINE} from './helpers.mjs';

const THREE = () => ({101: rawPhoto('A_0101.CR3'), 102: rawPhoto('A_0102.CR3'), 103: rawPhoto('A_0103.CR3')});
const UNDER = {skip: false, confidence: 0.95, scene: 'shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
  intent: 'none', skinCast: 'none', subjectExposure: 'under', changes: [{setting: 'Exposure2012', value: 0.4}], reason: 'under'};
// Waits for an observable condition instead of a fixed sleep, so slow CI machines don't flake.
async function waitFor(check, what, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 25));
  }
}
const planned = (x, ids) => { x.set(s => { s.aiDefault = UNDER; }); return x.analyze(ids); };
const apply = (x, dir, extra = []) => x.run(['--mode', 'apply', '--session', dir, '--confirm', ...extra]);
const restore = (x, dir) => x.run(['--mode', 'restore', '--session', dir, '--confirm']);

export function recoveryTests(bridge) {
  const it = (name, fn) => test(name + ' [' + bridge + ']', fn);

  it('engine killed right after a write lands: session is "interrupted" until reconciled, then fully recoverable', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {killAfterWrite: 2}; });
      const r = apply(x, dir);
      assert.equal(r.signal, 'SIGKILL');
      let v = x.show(dir);
      assert.equal(v.status, 'interrupted'); assert.equal(v.attention, true);
      assert.equal(v.photos[1].state, 'writing');
      assert.deepEqual(v.actions, {setReference: false, resumeAnalysis: false, apply: false, restore: false, reconcile: true, discard: false});
      x.set(s => { s.faults = {}; });
      const rec = x.run(['--mode', 'reconcile', '--session', dir]);
      assert.equal(rec.status, 0, JSON.stringify(rec.error));
      v = x.show(dir);
      assert.equal(v.photos[1].state, 'applied', 'the write that landed is recognised');
      assert.equal(v.photos[1].write.reconciled, true);
      assert.equal(v.status, 'partially-applied');
      assert.equal(apply(x, dir).status, 0, 'resume applies the remaining photo');
      assert.equal(x.show(dir).status, 'applied');
      assert.equal(restore(x, dir).status, 0);
      assert.equal(x.show(dir).status, 'restored');
      for (const p of Object.values(x.get().photos)) assert.equal(p.settings.exposure, 0);
    } finally { x.cleanup(); }
  });

  it('engine killed before the write reaches Lightroom: reconciled as not applied, then retried', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {killBeforeWrite: 1}; });
      assert.equal(apply(x, dir).signal, 'SIGKILL');
      x.set(s => { s.faults = {}; });
      // apply reconciles automatically before doing anything else
      const r = apply(x, dir);
      assert.equal(r.status, 0, JSON.stringify(r.error));
      const v = x.show(dir);
      assert.equal(v.status, 'applied');
      assert.ok(v.photos.every(p => p.state === 'applied'));
      assert.equal(x.get().writes.length, 3);
    } finally { x.cleanup(); }
  });

  it('an unconfirmed write is never assumed to have failed before Lightroom settles', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {killBeforeWrite: 1}; });
      apply(x, dir);
      x.set(s => { s.faults = {}; });
      const r = x.run(['--mode', 'apply', '--session', dir, '--confirm'], {TONEPILOT_SETTLE_MS: '600000'});
      assert.notEqual(r.status, 0);
      assert.match(r.error.message, /settle/);
      assert.equal(x.show(dir).status, 'interrupted');
    } finally { x.cleanup(); }
  });

  it('interrupted restore is never reported as restored', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      assert.equal(apply(x, dir).status, 0);
      x.set(s => { s.faults = {killAfterWrite: s.writeCount + 2}; });   // die during the 2nd restore write
      assert.equal(restore(x, dir).signal, 'SIGKILL');
      let v = x.show(dir);
      assert.equal(v.status, 'interrupted');
      assert.notEqual(v.status, 'restored');
      assert.deepEqual(v.photos.map(p => p.state), ['restored', 'restoring', 'applied']);
      x.set(s => { s.faults = {}; });
      assert.equal(restore(x, dir).status, 0, 'restore reconciles, then finishes the rest');
      v = x.show(dir);
      assert.equal(v.status, 'restored');
      assert.ok(v.photos.every(p => p.state === 'restored'));
    } finally { x.cleanup(); }
  });

  it('manual edits after TonePilot applied are kept; session stays "partly restored" until resolved', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      assert.equal(apply(x, dir).status, 0);
      const applied = x.get().photos[102].settings.exposure;
      x.set(s => { s.photos[102].settings.exposure = 1.0; });   // photographer refines it by hand
      assert.equal(restore(x, dir).status, 0);
      let v = x.show(dir);
      assert.equal(v.status, 'partially-restored');
      assert.equal(v.attention, true);
      assert.equal(v.photos[1].state, 'applied');
      assert.match(v.photos[1].restoreConflict.reason, /Changed in Lightroom/);
      assert.equal(x.get().photos[102].settings.exposure, 1.0, 'manual edit never overwritten');
      assert.equal(v.actions.restore, true);
      x.set(s => { s.photos[102].settings.exposure = applied; });   // photographer undoes their tweak
      assert.equal(restore(x, dir).status, 0);
      v = x.show(dir);
      assert.equal(v.status, 'restored');
      assert.equal(x.get().photos[102].settings.exposure, 0);
    } finally { x.cleanup(); }
  });

  it('Lightroom bridge dies right after a write: outcome recovered with a fresh bridge', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {exitAfterWrite: 1}; });
      const r = apply(x, dir);
      assert.equal(r.status, 0, 'engine stops cleanly, it does not crash');
      let v = x.show(dir);
      assert.equal(v.status, 'interrupted');
      x.set(s => { s.faults = {}; });
      assert.equal(x.run(['--mode', 'reconcile', '--session', dir]).status, 0);
      v = x.show(dir);
      assert.equal(v.photos[0].state, 'applied');
      assert.equal(v.status, 'partially-applied');
    } finally { x.cleanup(); }
  });

  it('a timed-out write that lands late is verified, not double-written', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {timeoutWrite: {n: 1, applyAfterMs: 300}}; });
      const r = apply(x, dir, []);
      assert.equal(r.status, 0, JSON.stringify(r.error));
      const v = x.show(dir);
      assert.equal(v.photos[0].state, 'applied');
      assert.equal(x.get().writes.filter(w => w.id === '101').length, 1);
    } finally { x.cleanup(); }
  });

  it('a timed-out write that never lands stops the run and stays unconfirmed', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {timeoutWrite: {n: 1, applyAfterMs: null}}; });
      const r = apply(x, dir);
      assert.equal(r.status, 0);
      assert.match(r.complete.stopped, /did not confirm/);
      assert.equal(x.show(dir).status, 'interrupted');
      assert.equal(x.get().writes.length, 0, 'no further photos written after an unconfirmed write');
      x.set(s => { s.faults = {}; });
      assert.equal(x.run(['--mode', 'reconcile', '--session', dir]).status, 0);
      assert.equal(x.show(dir).photos[0].state, 'apply-failed');
    } finally { x.cleanup(); }
  });

  it('a plug-in error leaves the photo untouched and retryable', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {errorOnWrite: 1}; });
      assert.equal(apply(x, dir).status, 0);
      const v = x.show(dir);
      assert.deepEqual(v.photos.map(p => p.state), ['apply-failed', 'applied', 'applied']);
      assert.equal(v.status, 'partially-applied');
      x.set(s => { s.faults = {}; });
      assert.equal(apply(x, dir).status, 0);
      assert.equal(x.show(dir).status, 'applied');
    } finally { x.cleanup(); }
  });

  it('rounded or side-effect writes are flagged for review, never called verified', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {roundExposure: true}; });
      assert.equal(apply(x, dir, ['--only', '["101"]']).status, 0);
      x.set(s => { s.faults = {sideEffectOnWrite: {field: 'clarity', value: 20}}; });
      assert.equal(apply(x, dir, ['--only', '["102"]']).status, 0);
      const v = x.show(dir);
      assert.equal(v.photos[0].state, 'apply-mismatch'); assert.deepEqual(v.photos[0].write.mismatched, ['Exposure2012']);
      assert.equal(v.photos[1].state, 'apply-mismatch'); assert.deepEqual(v.photos[1].write.unexpected, ['clarity']);
      assert.equal(v.attention, true);
      x.set(s => { s.faults = {}; });
      assert.equal(restore(x, dir).status, 0, 'differences can still be restored from recorded values');
      assert.equal(x.get().photos[101].settings.exposure, 0);
    } finally { x.cleanup(); }
  });

  it('selection change mid-apply stops safely; verified photos remain restorable without reselecting', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {changeSelectionAfterWrite: 1}; });
      const r = apply(x, dir);
      assert.equal(r.status, 0);
      assert.match(r.complete.stopped, /selection changed/);
      let v = x.show(dir);
      assert.equal(v.status, 'partially-applied');
      assert.equal(x.get().writes.length, 1);
      x.set(s => { s.faults = {}; });
      assert.equal(restore(x, dir).status, 0, 'restore authorised by the journal, not the live selection');
      v = x.show(dir);
      assert.equal(v.status, 'restored');
    } finally { x.cleanup(); }
  });

  it('closing the app stops the engine after the current photo, leaving a consistent journal', async () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {writeDelayMs: 500}; });
      // A stand-in "app" that launches the engine and quits as soon as the first write lands.
      const app = spawn(process.execPath, ['-e', `
        const {spawn} = require('node:child_process');
        const fs = require('node:fs');
        spawn(process.execPath, ${JSON.stringify([ENGINE, '--mode', 'apply', '--session', dir, '--confirm'])},
          {env: {...process.env, TONEPILOT_PARENT_PID: String(process.pid)}, stdio: 'ignore'});
        const started = Date.now();
        const t = setInterval(() => {
          const writes = JSON.parse(fs.readFileSync(process.env.TONEPILOT_MOCK_STATE, 'utf8')).writes.length;
          if (writes >= 1 || Date.now() - started > 20000) { clearInterval(t); process.exit(0); }
        }, 25);`], {env: x.env, stdio: 'ignore'});
      await new Promise(r => app.on('exit', r));
      for (let i = 0; i < 60; i++) {
        const s = x.run(['--mode', 'sessions']).complete;
        if (!s.running) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const v = x.show(dir);
      assert.equal(v.unresolved.length, 0, 'no write left unconfirmed');
      assert.equal(v.status, 'partially-applied');
      assert.ok(x.get().writes.length >= 1 && x.get().writes.length < 3);
    } finally { x.cleanup(); }
  });

  it('a second engine cannot run while one is still writing', async () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      x.set(s => { s.faults = {writeDelayMs: 700}; });
      const first = x.start(['--mode', 'apply', '--session', dir, '--confirm']);
      await waitFor(() => existsSync(join(x.runs, '.engine.lock')), 'the first engine to take the lock');
      const second = x.run(['--mode', 'restore', '--session', dir, '--confirm']);
      assert.notEqual(second.status, 0);
      assert.match(second.error.message, /still running/);
      await new Promise(r => first.on('exit', r));
      assert.equal(x.show(dir).status, 'applied');
    } finally { x.cleanup(); }
  });

  it('a torn final journal line is ignored; a damaged journal blocks all writes', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      const dir = planned(x, ['101', '102', '103']);
      const file = join(dir, 'journal.jsonl');
      appendFileSync(file, '{"v":2,"seq":999,"type":"write-int');   // crash mid-append
      assert.equal(x.show(dir).status, 'planned');
      assert.equal(apply(x, dir).status, 0, 'torn tail truncated on open');
      assert.equal(x.show(dir).status, 'applied');
      const lines = readFileSync(file, 'utf8').split('\n');
      lines[2] = '{garbage';
      writeFileSync(file, lines.join('\n'));
      const v = x.show(dir);
      assert.equal(v.status, 'damaged');
      assert.notEqual(restore(x, dir).status, 0);
    } finally { x.cleanup(); }
  });

  it('a stopped analysis can be resumed without repeating finished work', async () => {
    const x = setup({bridge, photos: THREE()});
    try {
      x.set(s => { s.aiDelayMs = 1500; });
      const p = x.start(['--mode', 'analyze', '--ids', '["101","102","103"]'], {TONEPILOT_AI_CONCURRENCY: '1'});
      let out = '';
      p.stdout.on('data', d => { out += d; });
      await waitFor(() => out.includes('"step":"assess"'), 'the first assessment');   // the second is now in flight
      p.kill('SIGTERM');
      await new Promise(r => p.on('exit', r));
      const dir = out.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(e => e.type === 'session').dir;
      let v = x.show(dir);
      assert.equal(v.status, 'analysis-incomplete');
      assert.equal(v.actions.resumeAnalysis, true);
      const assessedBefore = x.journal(dir).filter(r => r.type === 'photo-assessed').length;
      assert.ok(assessedBefore >= 1 && assessedBefore < 3);
      x.set(s => { s.aiDelayMs = 0; });
      const r = x.run(['--mode', 'analyze', '--resume', dir]);
      assert.equal(r.status, 0, JSON.stringify(r.error));
      v = x.show(dir);
      assert.equal(v.status, 'planned');
      assert.equal(x.journal(dir).filter(r => r.type === 'photo-assessed').length, 3, 'each photo assessed exactly once');
      assert.equal(x.get().writes.length, 0);
    } finally { x.cleanup(); }
  });

  it('an AI outage fails the analysis resumably instead of producing an empty plan', () => {
    const x = setup({bridge, photos: THREE()});
    try {
      x.set(s => { s.aiFail = ['101', '102', '103']; });
      const r = x.run(['--mode', 'analyze', '--ids', '["101","102","103"]']);
      assert.notEqual(r.status, 0);
      assert.match(r.error.message, /No photo could be assessed: .*nothing was changed in Lightroom/);
      const dir = r.events.find(e => e.type === 'session').dir;
      assert.equal(x.show(dir).status, 'analysis-failed');
      x.set(s => { s.aiFail = ['103']; });
      assert.equal(x.run(['--mode', 'analyze', '--resume', dir]).status, 0, 'resume retries the failed photos');
      const v = x.show(dir);
      assert.equal(v.status, 'planned');
      assert.equal(v.photos[2].state, 'flagged');
      assert.match(v.photos[2].reason, /AI assessment unavailable/);
      assert.equal(x.get().writes.length, 0);
    } finally { x.cleanup(); }
  });
}
