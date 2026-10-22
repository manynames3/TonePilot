#!/usr/bin/env node
// TonePilot guarded engine. AI only assesses; this process alone sends Lightroom writes,
// and only after a journal record makes the intent durable.
//
// Modes: doctor | inspect | analyze | apply | restore | reconcile | sessions | show | discard
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {LightroomMCP, readSelection, requireSameSelection, SelectionGuard, TESTED_BRIDGE_VERSION} from './lightroom.mjs';
import {Journal} from './journal.mjs';
import {loadSession, deriveStatus, listSessionDirs, sessionView, sessionSummary, writeViews} from './session.mjs';
import {acquireLock, readLock, updateLock} from './lock.mjs';
import {validateIDs, developmentView, identityOf, sameIdentity, diffSnapshot, classifyWrite, restorePlan,
  classifyRestore, matches, validateSettings, capabilitiesOf, MAX_JOB_PHOTOS} from './guard.mjs';
import {resolvePolicy} from './policy.mjs';
import {loadLineage, originFor} from './lineage.mjs';
import {groupScenes} from './scenes.mjs';
import {decide} from './harmonize.mjs';
import {buildPrompt, assessImage, pool} from './ai.mjs';
import {runDoctor} from './doctor.mjs';
import {ENGINE_VERSION} from './version.mjs';

const argv = process.argv.slice(2);
const opt = (n, f = '') => { const i = argv.indexOf('--' + n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : f; };
const flag = n => argv.includes('--' + n);
const mode = opt('mode', 'inspect');
const root = process.env.TONEPILOT_PROJECT_DIR || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const runs = path.resolve(process.env.TONEPILOT_RUNS_DIR || path.join(root, 'runs'));
const codexPath = process.env.TONEPILOT_CODEX || path.join(os.homedir(), '.local/bin/codex');
// A write whose request may still be queued inside Lightroom is not declared
// "not applied" until this long after it was sent.
const SETTLE_MS = Number(process.env.TONEPILOT_SETTLE_MS ?? 60000);
const AI_CONCURRENCY = Math.min(4, Math.max(1, Number(process.env.TONEPILOT_AI_CONCURRENCY) || 2));
const PRESENT = new Set(['applied', 'apply-mismatch']);

const emit = (type, fields = {}) => process.stdout.write(JSON.stringify({type, ...fields}) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

// ---- Stopping: never mid-write. A stop request lets the current photo finish its
// write and verification, then halts before the next one.
class Stop extends Error {}
let stopRequested = false;
const children = new Set();
function requestStop(reason) {
  if (!stopRequested) emit('progress', {phase: 'Stopping safely after the current photo…', reason});
  stopRequested = true;
  for (const c of children) c.kill('SIGTERM');   // model processes only; never the Lightroom bridge
}
process.on('SIGTERM', () => requestStop('stop requested'));
process.on('SIGINT', () => requestStop('stop requested'));
const parentPid = Number(process.env.TONEPILOT_PARENT_PID || 0);
if (parentPid) setInterval(() => { if (process.ppid !== parentPid) requestStop('TonePilot app closed'); }, 500).unref();
const checkStop = () => { if (stopRequested) throw new Stop('Stopped by request'); };

function safeDir(value) {
  if (!value) throw new Error('Missing --session');
  const dir = path.resolve(value.includes(path.sep) ? value : path.join(runs, value));
  if (path.dirname(dir) !== runs || !path.basename(dir).startsWith('session-')) throw new Error('Invalid session folder');
  if (!fs.existsSync(dir)) throw new Error('Session not found');
  return dir;
}
function reload(dir) {
  const s = loadSession(dir);
  if (!s) throw new Error('Session journal is empty');
  if (s.corrupt) throw new Error('Session journal is damaged (' + s.corrupt + '); manual review required');
  return s;
}
function requireConfirm(what) { if (!flag('confirm')) throw new Error(what + ' requires explicit confirmation'); }

// ---- Lightroom reads ----

async function getDevelop(client, id) {
  const m = await client.tool('get_photo_metadata', {photo_id: id});
  if (String(m.id) !== String(id)) throw new Error('Lightroom photo-ID mismatch');
  return {values: developmentView(m), snapshot: m.developSettings, identity: identityOf(id, m), meta: m};
}
function previewBytes(preview) {
  const raw = preview?.image?.data;
  if (typeof raw !== 'string' || raw.length < 100) throw new Error('Lightroom preview is missing');
  return Buffer.from(raw, 'base64');
}
const exifOf = m => ({cameraModel: m.cameraModel || null, cameraSerialNumber: m.cameraSerialNumber || null,
  lens: m.lens || null, isoSpeedRating: m.isoSpeedRating || null, aperture: m.aperture || null,
  shutterSpeed: m.shutterSpeed || null, flash: m.flash || null, focalLength: m.focalLength || null,
  exposureBias: m.exposureBias || null});

function runAnalyzer(file, original) {
  const program = process.env.TONEPILOT_ANALYZER;
  if (!program || !fs.existsSync(program)) return null;
  const args = [file];
  if (original && fs.existsSync(original)) args.push('--original', original);
  const p = spawnSync(program, args, {encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024});
  if (p.status !== 0) return null;
  try { return JSON.parse(p.stdout); } catch { return null; }
}

// ---- Analyze (read-only with respect to Lightroom) ----

async function doAnalyze(client) {
  const resume = opt('resume');
  if (resume) {
    const dir = safeDir(resume);
    const s = reload(dir);
    if (!deriveStatus(s).actions.resumeAnalysis) throw new Error('This session cannot be resumed');
    const journal = Journal.open(dir);
    journal.append('analysis-resumed');
    emit('session', {id: s.id, dir});
    return runAnalysis(client, journal, dir);
  }
  const ids = validateIDs(JSON.parse(opt('ids', '[]')));
  const look = opt('look', 'Natural'), strength = opt('strength', 'Balanced');
  const policy = resolvePolicy(look, strength);
  const enabled = {wb: opt('wb', 'true') === 'true', exposure: opt('exposure', 'true') === 'true', tone: opt('tone', 'true') === 'true'};
  if (!enabled.wb && !enabled.exposure && !enabled.tone) throw new Error('No enabled corrections');
  const selected = await requireSameSelection(client, ids);
  fs.mkdirSync(runs, {recursive: true, mode: 0o700});
  const id = 'session-' + new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
  const dir = path.join(runs, id);
  const journal = Journal.create(dir, 'session-created', {id, config: {look, strength, enabled, ids}, policy,
    engine: {version: ENGINE_VERSION, bridge: client.serverInfo?.version || null},
    photos: selected.map(p => ({id: p.id, filename: p.filename}))});
  updateLock(runs, {session: id});
  emit('session', {id, dir});
  return runAnalysis(client, journal, dir);
}

async function runAnalysis(client, journal, dir) {
  let s = reload(dir);
  const total = s.order.length;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tonepilot-previews-'));
  fs.chmodSync(tmp, 0o700);
  const previews = new Map();
  const fetchPreview = async id => {
    if (previews.has(id)) return fs.readFileSync(previews.get(id));
    const jpeg = previewBytes(await client.tool('get_photo_preview', {photo_id: id, size: 640}));
    const file = path.join(tmp, id + '.jpg');
    fs.writeFileSync(file, jpeg, {mode: 0o600});
    previews.set(id, file);
    return jpeg;
  };
  try {
    // 1. Baselines for every photo before anything else is read or judged.
    const lineage = loadLineage(runs, s.id);
    for (const [i, id] of s.order.entries()) {
      checkStop();
      const p = s.photos[id];
      if (p.state !== 'pending') continue;
      emit('progress', {step: 'baseline', phase: 'Saving original settings', index: i + 1, total, filename: p.filename});
      const cur = await getDevelop(client, id);
      if (cur.identity.filename !== p.filename || !cur.identity.path) {
        journal.append('photo-unsupported', {photo: id, reason: 'Catalog identity could not be confirmed (file renamed, moved or offline).'});
        continue;
      }
      const caps = capabilitiesOf(cur.meta, cur.values, client.writableKeys);
      if (!caps.supported) { journal.append('photo-unsupported', {photo: id, reason: caps.reason, identity: cur.identity}); continue; }
      const {origin, prior} = originFor(lineage, cur.identity, cur.values);
      journal.append('photo-baseline', {photo: id, identity: cur.identity, baseline: cur.values, snapshot: cur.snapshot,
        origin, prior, capabilities: caps, exif: exifOf(cur.meta)});
    }
    s = reload(dir);
    const supported = () => s.order.map(id => s.photos[id]).filter(p => p.state !== 'unsupported' && p.state !== 'pending');

    // 2. Local measurements on Lightroom-rendered previews (Lightroom does the rendering).
    for (const [i, p] of supported().entries()) {
      checkStop();
      if (p.previewHash) continue;
      emit('progress', {step: 'measure', phase: 'Measuring faces and highlights', index: i + 1, total, filename: p.filename});
      const jpeg = await fetchPreview(p.id);
      const metrics = runAnalyzer(previews.get(p.id), p.identity.path);
      journal.append('photo-measured', {photo: p.id, previewHash: hash(jpeg), metrics,
        note: metrics ? undefined : 'Local measurement unavailable'});
    }
    s = reload(dir);

    // 3. Lighting scenes.
    if (!s.scenes.length && supported().length) {
      journal.append('scenes', {scenes: groupScenes(supported())});
      s = reload(dir);
    }

    // 4. Model assessment, bounded parallelism, one private temp folder per call.
    // Photos whose earlier attempt failed are retried when an analysis is resumed.
    const todo = supported().filter(p => !p.ai);
    let done = supported().length - todo.length;
    await pool(todo, AI_CONCURRENCY, async p => {
      if (stopRequested) return;
      const scene = s.scenes.find(sc => sc.photos.includes(p.id)) || {id: 'S?', photos: [p.id], reference: p.id};
      try {
        const jpeg = await fetchPreview(p.id);
        const prompt = buildPrompt({photo: p, scene, policy: s.policy, enabled: s.config.enabled});
        const r = await assessImage({jpeg, prompt, codex: codexPath,
          onSpawn: c => { children.add(c); c.on('exit', () => children.delete(c)); }});
        journal.append('photo-assessed', {photo: p.id, ai: r.assessment, stats: r.stats});
      } catch (e) {
        if (stopRequested) return;
        journal.append('photo-assessed', {photo: p.id, error: String(e.message).slice(0, 200)});
      }
      emit('progress', {step: 'assess', phase: 'Assessing light, skin and exposure', index: ++done, total: supported().length, filename: p.filename});
    });
    checkStop();
    s = reload(dir);
    // A service-wide failure (signed out, offline) is not a plan: keep it resumable.
    const assessed = supported();
    if (assessed.length && assessed.every(p => !p.ai && p.aiError))
      throw new Error('The AI service failed for every photo (' + assessed[0].aiError + '). Fix the AI service, then resume this analysis.');

    // 5. Scene-consistent, policy-bounded decisions.
    emit('progress', {step: 'decide', phase: 'Building a consistent plan per scene'});
    const decisions = decide({photos: supported(), scenes: s.scenes, policy: s.policy, enabled: s.config.enabled});
    for (const id of s.order) if (decisions[id] && s.photos[id].state !== 'unsupported') journal.append('photo-proposed', {photo: id, decision: decisions[id]});
    journal.append('plan-ready');
    const view = writeViews(reload(dir));
    emit('complete', {state: 'planned', dir, ...brief(view)});
  } catch (e) {
    if (e instanceof Stop) {
      const view = writeViews(reload(dir));
      emit('complete', {state: 'stopped', dir, ...brief(view)});
      return;
    }
    journal.append('analysis-failed', {message: e.message});
    writeViews(reload(dir));
    throw e;
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
    journal.close();
  }
}

// ---- Apply ----

async function performWrite(client, id, cur, intended) {
  let error = null;
  try { await client.tool('set_develop_settings', {photo_id: id, settings: intended}); } catch (e) { error = e; }
  if (error?.kind === 'closed') return {unresolved: true, error};
  const deadline = Date.now() + (error?.kind === 'timeout' ? Math.min(SETTLE_MS, 20000) : 0);
  for (;;) {
    let after;
    try { after = await getDevelop(client, id); } catch (e) { return {unresolved: true, error: e}; }
    const c = classifyWrite({preValues: cur.values, preSnapshot: cur.snapshot, intended, afterValues: after.values, afterSnapshot: after.snapshot});
    if (c.outcome === 'not-applied' && error?.kind === 'timeout') {
      if (Date.now() < deadline) { await sleep(1000); continue; }
      return {unresolved: true, error};   // it may still land; reconcile decides later
    }
    const note = error ? error.message : c.outcome === 'not-applied' ? 'Lightroom reported success but the values did not change' : null;
    return {record: {outcome: c.outcome, mismatched: c.mismatched, unexpected: c.unexpected,
      afterValues: after.values, afterSnapshot: after.snapshot, error: note}};
  }
}

async function postCheck(client, journal, p, id) {
  const issues = [];
  let metrics = null, previewHash = null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tonepilot-check-'));
    try {
      const jpeg = previewBytes(await client.tool('get_photo_preview', {photo_id: id, size: 640}));
      previewHash = hash(jpeg);
      const file = path.join(dir, 'after.jpg');
      fs.writeFileSync(file, jpeg, {mode: 0o600});
      metrics = runAnalyzer(file, null);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
    if (previewHash === p.previewHash) issues.push('Lightroom\'s preview has not updated yet; check the photo visually.');
    const before = p.metrics, ev = (p.changes?.Exposure2012 ?? p.baseline.Exposure2012) - p.baseline.Exposure2012;
    if (before?.clip && metrics?.clip && metrics.clip.channel - before.clip.channel > 0.01)
      issues.push('Highlight clipping rose by ' + ((metrics.clip.channel - before.clip.channel) * 100).toFixed(1) + '% of the frame; check bright areas.');
    // Only exposure is predictable from the preview; tone sliders also move faces in shadow.
    const toneChanged = ['Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012'].some(k => k in (p.changes || {}));
    if (ev && !toneChanged && before?.subject?.method === 'face' && metrics?.subject?.method === 'face') {
      const achieved = Math.log2(metrics.subject.luma / before.subject.luma);
      if (Math.abs(achieved - ev) > 0.3) issues.push('Face brightness moved ' + achieved.toFixed(2) + ' EV (expected ' + ev.toFixed(2) + ' EV); review this frame.');
    }
  } catch (e) { issues.push('After-edit preview unavailable: ' + e.message); }
  journal.append('post-check', {photo: id, metrics, issues, previewHash});
}

async function doApply(client) {
  requireConfirm('Applying adjustments');
  const dir = safeDir(opt('session'));
  const journal = Journal.open(dir);
  try {
    let s = reload(dir);
    const pending = await reconcile(client, journal, s);
    if (pending.length) throw new Error('An earlier Lightroom write is still unconfirmed: ' + pending[0].reason + '.');
    s = reload(dir);
    const st = deriveStatus(s);
    if (!st.actions.apply) throw new Error('Nothing in this session can be applied (' + st.label + ')');
    const candidates = s.order.filter(id => s.photos[id].state === 'proposed' || s.photos[id].state === 'apply-failed');
    const only = opt('only') ? JSON.parse(opt('only')).map(String) : null;
    if (only && only.some(id => !candidates.includes(id))) throw new Error('An approved photo has no applicable edit');
    const approved = only ? candidates.filter(id => only.includes(id)) : candidates;
    if (!approved.length) throw new Error('No photos approved');
    const selection = new SelectionGuard(client, s.config.ids);
    await selection.full();
    journal.append('apply-started', {approved});
    let stoppedReason = null, failures = 0;
    try {
      for (const [i, id] of approved.entries()) {
        if (stopRequested) { stoppedReason = 'Stopped by request'; break; }
        const p = s.photos[id];
        emit('progress', {step: 'apply', phase: 'Writing approved edits', index: i + 1, total: approved.length, filename: p.filename});
        try { await selection.beforeWrite({last: i === approved.length - 1}); }
        catch (e) { if (e.kind === 'selection') { stoppedReason = e.message; break; } throw e; }
        const cur = await getDevelop(client, id);
        if (!sameIdentity(p.identity, cur.identity)) {
          journal.append('photo-stale', {photo: id, reason: 'The photo was moved or renamed, or a different catalog is open.'}); continue;
        }
        const changed = diffSnapshot(p.snapshot, cur.snapshot);
        if (changed.length) {
          journal.append('photo-stale', {photo: id, fields: changed,
            reason: 'Edited in Lightroom after analysis. TonePilot will not overwrite your changes; analyze again to include this photo.'});
          continue;
        }
        let intended;
        try { intended = validateSettings({origin: p.origin, baseline: cur.values, proposed: p.changes, enabled: s.config.enabled, caps: s.policy.caps}); }
        catch (e) { journal.append('photo-stale', {photo: id, reason: 'Blocked by safety limits: ' + e.message}); continue; }
        journal.append('write-intent', {photo: id, preValues: cur.values, preSnapshot: cur.snapshot, intended});
        const r = await performWrite(client, id, cur, intended);
        if (r.unresolved) {
          stoppedReason = 'Lightroom did not confirm the write for ' + p.filename + ' (' + r.error.message + '). TonePilot stopped; check the session before continuing.';
          break;
        }
        journal.append('write-result', {photo: id, ...r.record});
        if (r.record.outcome === 'not-applied') {
          if (++failures >= 2) { stoppedReason = 'Lightroom rejected two writes in a row: ' + r.record.error; break; }
        } else {
          failures = 0;
          await postCheck(client, journal, reload(dir).photos[id], id);
        }
      }
    } catch (e) {
      stoppedReason = e.message;
      journal.append('session-error', {phase: 'apply', message: e.message});
    } finally {
      journal.append('apply-finished', {stopped: !!stoppedReason, error: stoppedReason, selectionReads: selection.reads});
    }
    const view = writeViews(reload(dir));
    emit('complete', {state: view.status, dir, stopped: stoppedReason, ...brief(view)});
  } finally { journal.close(); }
}

// ---- Restore: only values TonePilot wrote, only while they are still untouched ----

async function performRestore(client, id, cur, plan) {
  let error = null;
  try { await client.tool('set_develop_settings', {photo_id: id, settings: plan.target}); } catch (e) { error = e; }
  if (error?.kind === 'closed') return {unresolved: true, error};
  const deadline = Date.now() + (error?.kind === 'timeout' ? Math.min(SETTLE_MS, 20000) : 0);
  for (;;) {
    let after;
    try { after = await getDevelop(client, id); } catch (e) { return {unresolved: true, error: e}; }
    const c = classifyRestore({plan, preSnapshot: cur.snapshot, afterValues: after.values, afterSnapshot: after.snapshot});
    if (c.outcome === 'not-restored' && error?.kind === 'timeout') {
      if (Date.now() < deadline) { await sleep(1000); continue; }
      return {unresolved: true, error};
    }
    return {record: {outcome: c.outcome, wrong: c.wrong, unexpected: c.unexpected, afterValues: after.values,
      error: error ? error.message : c.outcome === 'not-restored' ? 'Lightroom reported success but nothing changed' : null}};
  }
}

async function doRestore(client) {
  requireConfirm('Restoring');
  const dir = safeDir(opt('session'));
  const journal = Journal.open(dir);
  try {
    let s = reload(dir);
    const pending = await reconcile(client, journal, s);
    if (pending.length) throw new Error('An earlier Lightroom write is still unconfirmed: ' + pending[0].reason + '.');
    s = reload(dir);
    const st = deriveStatus(s);
    if (!st.actions.restore) throw new Error('Nothing to restore (' + st.label + ')');
    const only = opt('only') ? JSON.parse(opt('only')).map(String) : null;
    const targets = s.order.filter(id => PRESENT.has(s.photos[id].state) && (!only || only.includes(id)));
    // No selection requirement: authorization is this session's journal, and every
    // photo is checked by catalog identity and by its exact post-edit values.
    journal.append('restore-started');
    let stoppedReason = null;
    try {
      for (const [i, id] of targets.entries()) {
        if (stopRequested) { stoppedReason = 'Stopped by request'; break; }
        const p = s.photos[id];
        emit('progress', {step: 'restore', phase: 'Restoring original settings', index: i + 1, total: targets.length, filename: p.filename});
        const cur = await getDevelop(client, id);
        if (!sameIdentity(p.identity, cur.identity)) {
          journal.append('restore-conflict', {photo: id, reason: 'The photo was moved or renamed, or a different catalog is open.'}); continue;
        }
        const plan = restorePlan(p.baseline, p.applied, p.after.values);
        const drift = matches(plan.expected, cur.values);
        if (drift.length) {
          journal.append('restore-conflict', {photo: id, fields: drift,
            reason: 'Changed in Lightroom after TonePilot applied it. Your later edits are kept; adjust this photo by hand or with Lightroom History.'});
          continue;
        }
        journal.append('restore-intent', {photo: id, plan, preSnapshot: cur.snapshot});
        const r = await performRestore(client, id, cur, plan);
        if (r.unresolved) { stoppedReason = 'Lightroom did not confirm the restore for ' + p.filename + '. Check the session again shortly.'; break; }
        journal.append('restore-result', {photo: id, ...r.record});
      }
    } catch (e) {
      stoppedReason = e.message;
      journal.append('session-error', {phase: 'restore', message: e.message});
    } finally {
      journal.append('restore-finished', {stopped: !!stoppedReason, error: stoppedReason});
    }
    const view = writeViews(reload(dir));
    emit('complete', {state: view.status, dir, stopped: stoppedReason, ...brief(view)});
  } finally { journal.close(); }
}

// ---- Reconcile: settle writes whose outcome was never recorded (crash, kill, bridge loss) ----

async function reconcile(client, journal, s) {
  const pending = [];
  for (const id of s.order) {
    const p = s.photos[id];
    if (p.state !== 'writing' && p.state !== 'restoring') continue;
    let cur;
    try { cur = await getDevelop(client, id); }
    catch (e) { pending.push({id, reason: 'Lightroom could not be read (' + e.message + ')'}); continue; }
    if (!sameIdentity(p.identity, cur.identity)) { pending.push({id, reason: 'Open the catalog this session was made in'}); continue; }
    if (p.state === 'writing') {
      const c = classifyWrite({preValues: p.write.preValues, preSnapshot: p.write.preSnapshot, intended: p.write.intended,
        afterValues: cur.values, afterSnapshot: cur.snapshot});
      if (c.outcome === 'not-applied' && Date.now() - Date.parse(p.write.intentAt) < SETTLE_MS) {
        pending.push({id, reason: 'Waiting for Lightroom to settle before deciding the write did not happen'}); continue;
      }
      journal.append('write-result', {photo: id, outcome: c.outcome, mismatched: c.mismatched, unexpected: c.unexpected,
        afterValues: cur.values, afterSnapshot: cur.snapshot, reconciled: true,
        error: 'Outcome recovered after an interruption'});
    } else {
      const c = classifyRestore({plan: p.restore.plan, preSnapshot: p.restore.preSnapshot, afterValues: cur.values, afterSnapshot: cur.snapshot});
      if (c.outcome === 'not-restored' && Date.now() - Date.parse(p.restore.intentAt) < SETTLE_MS) {
        pending.push({id, reason: 'Waiting for Lightroom to settle before deciding the restore did not happen'}); continue;
      }
      journal.append('restore-result', {photo: id, outcome: c.outcome, wrong: c.wrong, unexpected: c.unexpected,
        afterValues: cur.values, reconciled: true, error: 'Outcome recovered after an interruption'});
    }
  }
  return pending;
}

async function doReconcile(client) {
  const dir = safeDir(opt('session'));
  const journal = Journal.open(dir);
  try {
    const pending = await reconcile(client, journal, reload(dir));
    const view = writeViews(reload(dir));
    emit('complete', {state: view.status, dir, waiting: pending, ...brief(view)});
  } finally { journal.close(); }
}

// ---- Read-only views ----

const brief = view => ({status: view.status, label: view.label, counts: view.counts, actions: view.actions, attention: view.attention});

function doSessions() {
  const holder = readLock(runs);
  const sessions = [];
  for (const dir of listSessionDirs(runs).slice(0, 200)) {
    try {
      const s = loadSession(dir);
      if (!s) { const legacy = legacySummary(dir); if (legacy) sessions.push(legacy); continue; }
      const summary = sessionSummary(s);
      if (holder?.session === s.id) summary.running = holder.mode;
      sessions.push(summary);
    } catch (e) { sessions.push({id: path.basename(dir), dir, status: 'damaged', label: 'Journal damaged', explanation: e.message, attention: true}); }
  }
  emit('complete', {state: 'read-only', sessions, running: holder ? {mode: holder.mode, session: holder.session || null} : null});
}

// v0.4 sessions have no journal. They are listed, never acted on: one that reached
// "applying" may hold Lightroom changes that only Lightroom's History can now confirm.
function legacySummary(dir) {
  let old;
  try { old = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch { return null; }
  if (old.version !== 1) return null;
  const wrote = ['applying', 'applied', 'partial'].includes(old.state) ||
    (old.photos || []).some(p => /write|verified|restore/.test(p.state || ''));
  return {id: path.basename(dir), dir, createdAt: null, updatedAt: old.completedAt || null, look: old.look, strength: old.strength,
    photoCount: (old.photos || []).length, status: 'legacy', label: 'TonePilot 0.4 session',
    explanation: wrote ? 'Made by TonePilot 0.4 and may contain Lightroom changes. Check these photos in Lightroom History.' : 'Made by TonePilot 0.4. No Lightroom changes were made.',
    attention: wrote, actions: {resumeAnalysis: false, apply: false, restore: false, reconcile: false, discard: false}};
}

function doShow() {
  const dir = safeDir(opt('session'));
  const s = loadSession(dir);
  if (!s) throw new Error('Session journal is empty');
  const view = sessionView(s);
  const holder = readLock(runs);
  if (holder?.session === s.id) view.running = holder.mode;
  emit('complete', {state: 'read-only', session: view});
}

function doDiscard() {
  requireConfirm('Discarding');
  const dir = safeDir(opt('session'));
  const s = reload(dir);
  if (!deriveStatus(s).actions.discard) throw new Error('Only sessions with no TonePilot changes in Lightroom can be discarded');
  const journal = Journal.open(dir);
  try { journal.append('discarded'); } finally { journal.close(); }
  const view = writeViews(reload(dir));
  emit('complete', {state: view.status, dir, ...brief(view)});
}

async function doInspect(client) {
  const sel = await readSelection(client, MAX_JOB_PHOTOS);
  emit('complete', {state: 'read-only', count: sel.count, limit: MAX_JOB_PHOTOS, truncated: sel.truncated,
    bridge: client.serverInfo?.version || null, testedBridge: TESTED_BRIDGE_VERSION,
    photos: sel.photos.map(p => ({id: p.id, filename: p.filename, captureTime: p.captureTime,
      format: (path.extname(p.filename).slice(1) || '').toUpperCase()}))});
}

// ---- Entry ----

const MUTATING = new Set(['analyze', 'apply', 'restore', 'reconcile', 'discard']);
async function main() {
  if (!['doctor', 'inspect', 'analyze', 'apply', 'restore', 'reconcile', 'sessions', 'show', 'discard'].includes(mode)) throw new Error('Unknown mode');
  if (mode === 'sessions') return doSessions();
  if (mode === 'show') return doShow();
  if (mode === 'doctor') return emit('complete', {state: 'read-only', ...(await runDoctor({live: flag('live')}))});
  if (MUTATING.has(mode)) {
    const session = opt('session') ? path.basename(opt('session')) : opt('resume') ? path.basename(opt('resume')) : null;
    acquireLock(runs, {mode, session});
  }
  if (mode === 'discard') return doDiscard();
  const client = await new LightroomMCP().connect();
  if (client.serverInfo?.version && client.serverInfo.version !== TESTED_BRIDGE_VERSION)
    emit('warning', {message: 'Lightroom bridge ' + client.serverInfo.version + ' has not been verified with TonePilot (tested ' + TESTED_BRIDGE_VERSION + ').'});
  try {
    if (mode === 'inspect') await doInspect(client);
    else if (mode === 'analyze') await doAnalyze(client);
    else if (mode === 'apply') await doApply(client);
    else if (mode === 'restore') await doRestore(client);
    else await doReconcile(client);
  } finally { await client.close(); }
}

main().catch(e => { emit('error', {message: e.message, kind: e.kind || null}); process.exitCode = 1; });
