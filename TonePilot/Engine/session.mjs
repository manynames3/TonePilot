// Session state is a pure fold over journal records. Status is DERIVED from photo
// states every time, never stored, so a session cannot claim "restored" while any
// TonePilot change is still present, and an interrupted write cannot be forgotten.
import fs from 'node:fs';
import path from 'node:path';
import {readJournal, atomicWrite} from './journal.mjs';

export const PHOTO_LABELS = Object.freeze({
  'pending': 'Waiting', 'baselined': 'Original settings saved', 'unsupported': 'Not supported',
  'proposed': 'Edit proposed', 'skipped': 'Left unchanged', 'flagged': 'Needs your review',
  'stale': 'Changed in Lightroom since analysis', 'writing': 'Write unconfirmed',
  'applied': 'Applied · settings verified', 'apply-mismatch': 'Applied with differences',
  'apply-failed': 'Not applied', 'restoring': 'Restore unconfirmed',
  'restored': 'Restored', 'restore-mismatch': 'Restore incomplete'
});

export const STATUS = Object.freeze({
  'analysis-incomplete': ['Analysis interrupted', 'No Lightroom changes were made. Resume or discard the analysis.'],
  'analysis-failed': ['Analysis failed', 'No Lightroom changes were made.'],
  'planned': ['Ready to review', 'Nothing has been written to Lightroom yet.'],
  'not-applied': ['Not applied', 'Applying was attempted, but no photo was changed.'],
  'partially-applied': ['Partly applied', 'Some approved edits are in Lightroom; the rest were not written.'],
  'applied': ['Applied', 'Every approved edit was written and verified.'],
  'partially-restored': ['Partly restored', 'Some TonePilot changes remain in Lightroom.'],
  'restored': ['Restored', 'Every TonePilot change from this session has been undone.'],
  'interrupted': ['Interrupted — check needed', 'A Lightroom write was in flight when TonePilot stopped. Check the session before doing anything else.'],
  'damaged': ['Journal damaged', 'This session record could not be read completely. Review the photos in Lightroom History.'],
  'discarded': ['Discarded', 'This plan was discarded without changing Lightroom.']
});

const UNRESOLVED = new Set(['writing', 'restoring']);
const PRESENT = new Set(['applied', 'apply-mismatch']);   // a TonePilot change is believed to be in Lightroom

export function foldSession(records, {corrupt = null} = {}) {
  const s = {id: null, createdAt: null, config: null, policy: null, engine: null, order: [], photos: {},
    scenes: [], planReadyAt: null, analysisError: null, applyRuns: [], restoreRuns: [], errors: [],
    discarded: false, corrupt, lastAt: null};
  const photo = id => s.photos[id] || (() => { throw new Error('Journal references unknown photo ' + id); })();
  for (const r of records) {
    s.lastAt = r.at;
    switch (r.type) {
      case 'session-created':
        s.id = r.id; s.createdAt = r.at; s.config = r.config; s.policy = r.policy; s.engine = r.engine;
        for (const p of r.photos) { s.order.push(p.id); s.photos[p.id] = {id: p.id, filename: p.filename, state: 'pending'}; }
        break;
      case 'photo-baseline': {
        const p = photo(r.photo);
        Object.assign(p, {identity: r.identity, baseline: r.baseline, snapshot: r.snapshot, origin: r.origin,
          prior: r.prior || null, capabilities: r.capabilities, exif: r.exif || {}, state: 'baselined'});
        break;
      }
      case 'photo-unsupported': Object.assign(photo(r.photo), {state: 'unsupported', reason: r.reason}); break;
      case 'photo-measured': Object.assign(photo(r.photo), {metrics: r.metrics || null, previewHash: r.previewHash, measureNote: r.note}); break;
      case 'scenes':
        s.scenes = r.scenes;
        for (const sc of r.scenes) for (const id of sc.photos) if (s.photos[id]) s.photos[id].scene = sc.id;
        break;
      case 'plan-revision-started': s.planReadyAt = null; break;
      case 'scene-reference': {
        const sc = s.scenes.find(sc => sc.id === r.scene);
        if (sc) { sc.reference = r.reference; sc.referenceApproved = r.approved; sc.referenceAt = r.at; }
        break;
      }
      case 'photo-assessed': Object.assign(photo(r.photo), {ai: r.ai || null, aiError: r.error || null, aiStats: r.stats || null, aiKey: r.key || null}); break;
      case 'photo-proposed': {
        const p = photo(r.photo);
        p.decision = r.decision; p.changes = r.decision.changes || {}; p.state = r.decision.status;
        break;
      }
      case 'plan-ready': s.planReadyAt = r.at; break;
      case 'analysis-failed': s.analysisError = r.message; break;
      case 'analysis-resumed': s.analysisError = null; break;
      case 'apply-started':
        s.applyRuns.push({at: r.at, approved: r.approved, finishedAt: null});
        for (const id of r.approved) if (s.photos[id]) s.photos[id].approved = true;
        break;
      case 'photo-snapshot': photo(r.photo).lrSnapshot = {name: r.name, supported: r.supported, created: r.created, error: r.error || null}; break;
      case 'photo-stale': Object.assign(photo(r.photo), {state: 'stale', staleReason: r.reason, staleFields: r.fields || []}); break;
      case 'write-intent': {
        const p = photo(r.photo);
        p.state = 'writing';
        p.write = {intentAt: r.at, preValues: r.preValues, preSnapshot: r.preSnapshot, intended: r.intended};
        break;
      }
      case 'write-result': {
        const p = photo(r.photo);
        Object.assign(p.write, {outcome: r.outcome, at: r.at, error: r.error || null, mismatched: r.mismatched || [],
          unexpected: r.unexpected || [], reconciled: !!r.reconciled});
        p.after = {values: r.afterValues, snapshot: r.afterSnapshot};
        if (r.outcome === 'verified') { p.state = 'applied'; p.applied = p.write.intended; }
        else if (r.outcome === 'mismatch') { p.state = 'apply-mismatch'; p.applied = p.write.intended; }
        else p.state = 'apply-failed';
        break;
      }
      case 'post-check': photo(r.photo).post = {metrics: r.metrics || null, issues: r.issues || [], previewHash: r.previewHash}; break;
      case 'apply-finished': if (s.applyRuns.length) Object.assign(s.applyRuns.at(-1), {finishedAt: r.at, stopped: !!r.stopped, error: r.error || null}); break;
      case 'restore-started': s.restoreRuns.push({at: r.at, finishedAt: null}); break;
      case 'restore-conflict': photo(r.photo).restoreConflict = {at: r.at, reason: r.reason, fields: r.fields || []}; break;
      case 'restore-intent': {
        const p = photo(r.photo);
        p.restore = {intentAt: r.at, plan: r.plan, preSnapshot: r.preSnapshot, fromState: p.state};
        p.state = 'restoring';
        break;
      }
      case 'restore-result': {
        const p = photo(r.photo);
        Object.assign(p.restore, {outcome: r.outcome, at: r.at, error: r.error || null, wrong: r.wrong || [],
          unexpected: r.unexpected || [], reconciled: !!r.reconciled});
        if (r.outcome === 'restored') { p.state = 'restored'; delete p.restoreConflict; }
        else if (r.outcome === 'not-restored') p.state = p.restore.fromState;
        else p.state = 'restore-mismatch';
        p.restoredValues = r.afterValues;
        break;
      }
      case 'restore-finished': if (s.restoreRuns.length) Object.assign(s.restoreRuns.at(-1), {finishedAt: r.at, stopped: !!r.stopped, error: r.error || null}); break;
      case 'session-error': s.errors.push({at: r.at, phase: r.phase, message: r.message}); break;
      case 'discarded': s.discarded = true; break;
      default: break;   // forward compatible: ignore record types this version does not know
    }
  }
  return s;
}

export function deriveStatus(s) {
  const list = s.order.map(id => s.photos[id]);
  const by = st => list.filter(p => p.state === st);
  const unresolved = list.filter(p => UNRESOLVED.has(p.state));
  const present = list.filter(p => PRESENT.has(p.state));
  const restored = by('restored');
  const candidates = list.filter(p => p.state === 'proposed' || p.state === 'apply-failed');
  const remainingApproved = candidates.filter(p => p.approved);
  const review = list.filter(p => p.state === 'apply-mismatch' || p.state === 'restore-mismatch');
  const restoreMismatch = by('restore-mismatch');
  let status;
  if (s.corrupt) status = 'damaged';
  else if (unresolved.length) status = 'interrupted';
  else if (s.discarded) status = 'discarded';
  else if (!s.planReadyAt) status = s.analysisError ? 'analysis-failed' : 'analysis-incomplete';
  else if (!present.length && !restored.length && !restoreMismatch.length) status = s.applyRuns.length ? 'not-applied' : 'planned';
  else if (!present.length && !restoreMismatch.length) status = 'restored';
  else if (restored.length || restoreMismatch.length) status = 'partially-restored';
  else status = remainingApproved.length ? 'partially-applied' : 'applied';
  const counts = {total: list.length};
  for (const p of list) counts[p.state] = (counts[p.state] || 0) + 1;
  const actions = {
    setReference: !s.corrupt && !s.discarded && !!s.planReadyAt && !s.applyRuns.length,
    resumeAnalysis: !s.corrupt && !s.discarded && !s.planReadyAt && !s.applyRuns.length,
    apply: !s.corrupt && !s.discarded && !!s.planReadyAt && !unresolved.length && candidates.length > 0,
    restore: !s.corrupt && !unresolved.length && present.length > 0,
    reconcile: !s.corrupt && unresolved.length > 0,
    discard: !present.length && !unresolved.length && !s.discarded && !by('restore-mismatch').length
  };
  const attention = !!s.corrupt || unresolved.length > 0 || review.length > 0 ||
    list.some(p => (p.restoreConflict || p.post?.issues?.length) && PRESENT.has(p.state));
  return {status, label: STATUS[status][0], explanation: STATUS[status][1], counts, actions, attention,
    present: present.length, restored: restored.length, unresolved: unresolved.map(p => p.id),
    candidates: candidates.length};
}

export function loadSession(dir) {
  const {records, corrupt} = readJournal(dir);
  if (!records.length) return null;
  const session = foldSession(records, {corrupt});
  session.dir = dir;
  return session;
}

export function listSessionDirs(runs) {
  let entries = [];
  try { entries = fs.readdirSync(runs, {withFileTypes: true}); } catch { return []; }
  return entries.filter(e => e.isDirectory() && e.name.startsWith('session-'))
    .map(e => path.join(runs, e.name)).sort().reverse();
}

// ---- Views for the Mac app and the plain-text report ----

const KEY_LABEL = {Temperature: 'Temperature', Tint: 'Tint', IncrementalTemperature: 'Temperature', IncrementalTint: 'Tint',
  Exposure2012: 'Exposure', Highlights2012: 'Highlights',
  Shadows2012: 'Shadows', Whites2012: 'Whites', Blacks2012: 'Blacks', WhiteBalance: 'White balance'};

function changeRows(p) {
  // The WB mode label is not a slider value; it's shown through the white-balance rows.
  const keys = new Set([...Object.keys(p.changes || {}), ...Object.keys(p.applied || {})].filter(k => k !== 'WhiteBalance'));
  return [...keys].map(key => ({
    key, label: KEY_LABEL[key] || key,
    original: p.baseline?.[key] ?? null,
    origin: p.origin?.[key] ?? null,
    proposed: p.changes?.[key] ?? null,
    applied: p.after?.values?.[key] ?? null,
    restored: p.restoredValues?.[key] ?? null
  }));
}

export function photoView(p) {
  const d = p.decision || {};
  return {
    id: p.id, filename: p.filename, state: p.state, stateLabel: PHOTO_LABELS[p.state] || p.state,
    reviewRecommended: p.state !== 'restored' && (!!d.reviewRecommended || (PRESENT.has(p.state) && !!p.post?.issues?.length)),
    format: p.identity?.fileFormat || '', scene: p.scene || null, approved: !!p.approved,
    changes: changeRows(p),
    reason: d.reason || p.reason || p.staleReason || '',
    rationale: d.rationale || [], warnings: [...(d.warnings || []), ...(p.post?.issues || [])],
    confidence: d.confidence ?? null, confidenceNote: 'Model self-reported; not calibrated',
    ai: p.ai ? {scene: p.ai.scene, illuminant: p.ai.illuminant, mixedLighting: p.ai.mixedLighting,
      backlit: p.ai.backlit, intent: p.ai.intent, skinCast: p.ai.skinCast, subjectExposure: p.ai.subjectExposure,
      skinTone: p.ai.skinTone || null} : null,
    wbMode: p.capabilities?.wbMode || null,
    aiError: p.aiError || null,
    measurement: p.metrics ? {subject: p.metrics.subject?.method || 'none', faces: p.metrics.faces?.length || 0,
      subjectLuma: p.metrics.subject?.luma ?? null, highlightClip: p.metrics.clip?.channel ?? null,
      shadowClip: p.metrics.clip?.deepShadow ?? null} : null,
    after: p.post?.metrics ? {subjectLuma: p.post.metrics.subject?.luma ?? null, highlightClip: p.post.metrics.clip?.channel ?? null} : null,
    capabilities: p.capabilities || null, prior: p.prior,
    staleFields: p.staleFields || [], restoreConflict: p.restoreConflict || null,
    lightroomSnapshot: p.lrSnapshot?.created ? p.lrSnapshot.name : null,
    write: p.write ? {outcome: p.write.outcome || null, error: p.write.error, mismatched: p.write.mismatched,
      unexpected: p.write.unexpected, reconciled: p.write.reconciled} : null,
    restore: p.restore ? {outcome: p.restore.outcome || null, error: p.restore.error, wrong: p.restore.wrong,
      unexpected: p.restore.unexpected} : null
  };
}

export function sessionView(s) {
  const st = deriveStatus(s);
  return {
    id: s.id, dir: s.dir, createdAt: s.createdAt, updatedAt: s.lastAt,
    look: s.config?.look, strength: s.config?.strength, enabled: s.config?.enabled,
    policy: s.policy, engine: s.engine, ...st,
    scenes: s.scenes, errors: s.errors, analysisError: s.analysisError,
    photos: s.order.map(id => photoView(s.photos[id]))
  };
}

export function sessionSummary(s) {
  const st = deriveStatus(s);
  return {id: s.id, dir: s.dir, createdAt: s.createdAt, updatedAt: s.lastAt, look: s.config?.look,
    strength: s.config?.strength, photoCount: s.order.length, ...st};
}

const fmt = v => v === null || v === undefined ? '—' : typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v);

export function renderReport(view) {
  const lines = ['TonePilot session ' + view.id, '', 'Status: ' + view.label + ' — ' + view.explanation,
    'Direction: ' + view.look + ' · ' + view.strength, ''];
  for (const p of view.photos) {
    lines.push(p.filename + ' — ' + p.stateLabel + (p.scene ? ' (scene ' + p.scene + ')' : ''));
    for (const c of p.changes) {
      lines.push('  ' + c.label + ': ' + fmt(c.original) + ' → ' + fmt(c.proposed) +
        (c.applied !== null ? ' (read back ' + fmt(c.applied) + ')' : '') +
        (c.restored !== null ? ' (restored ' + fmt(c.restored) + ')' : ''));
    }
    if (p.reason) lines.push('  Why: ' + p.reason);
    for (const w of p.warnings) lines.push('  Warning: ' + w);
    if (p.restoreConflict) lines.push('  Restore refused: ' + p.restoreConflict.reason);
    lines.push('');
  }
  lines.push('Read-back checks confirm values, not photographic quality. Review every photo in Lightroom.');
  return lines.join('\n');
}

export function writeViews(s) {
  const view = sessionView(s);
  atomicWrite(path.join(s.dir, 'session.json'), JSON.stringify(view, null, 2));
  atomicWrite(path.join(s.dir, 'report.txt'), renderReport(view));
  return view;
}
