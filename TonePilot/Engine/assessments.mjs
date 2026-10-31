// Reuse only exact, successful inputs from existing private session journals. No second
// store of photo descriptions; discarding/deleting a session removes it from reuse.
import {createHash} from 'node:crypto';
import {listSessionDirs, loadSession} from './session.mjs';
import {ENGINE_VERSION} from './version.mjs';
import {ASSESSMENT_SCHEMA} from './ai.mjs';

const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
const input = p => ({identity: p.identity, baseline: p.baseline, snapshot: p.snapshot, capabilities: p.capabilities,
  exif: p.exif, previewHash: p.previewHash, metrics: p.metrics && {...p.metrics, ms: undefined}});

export function assessmentKey({photo, scene, photos, provider, prompt, previewHash, policy}) {
  return createHash('sha256').update(JSON.stringify(sorted({version: ENGINE_VERSION, schema: ASSESSMENT_SCHEMA,
    provider: provider.name, model: provider.model, policy, prompt, previewHash, photo: input(photo),
    scene: {...scene, photos: scene.photos.map(id => input(photos[id]))}}))).digest('hex');
}

export function reusableAssessments(runs, current) {
  const found = new Map();
  for (const dir of listSessionDirs(runs)) {
    try {
      const s = loadSession(dir);
      if (!s || s.id === current || s.corrupt || s.discarded || !s.planReadyAt) continue;
      for (const p of Object.values(s.photos)) if (p.aiKey && p.ai && !p.aiError && !found.has(p.aiKey))
        found.set(p.aiKey, {assessment: p.ai, stats: {...p.aiStats, inputTokens: 0, outputTokens: 0, ms: 0, reusedFrom: s.id}});
    } catch { /* an unreadable older session cannot prevent a fresh assessment */ }
  }
  return found;
}

export function reuseSceneReferences(runs, current, scenes, photos, policy) {
  const key = (sc, ps, policy) => createHash('sha256').update(JSON.stringify(sorted({policy,
    photos: sc.photos.map(id => input(ps[id]))}))).digest('hex');
  const previous = new Map();
  for (const dir of listSessionDirs(runs)) {
    try {
      const s = loadSession(dir);
      if (!s || s.id === current || s.corrupt || s.discarded || !s.planReadyAt || s.engine?.version !== ENGINE_VERSION) continue;
      for (const sc of s.scenes) {
        const k = key(sc, s.photos, s.policy);
        const at = Date.parse(sc.referenceAt);
        if (Number.isFinite(at) && (!previous.has(k) || at > previous.get(k).at))
          previous.set(k, {reference: sc.referenceApproved ? sc.reference : null, at, referenceAt: sc.referenceAt});
      }
    } catch { /* use the automatic reference when old evidence is unavailable */ }
  }
  return scenes.map(sc => {
    const choice = previous.get(key(sc, photos, policy));
    return choice?.reference && sc.photos.includes(choice.reference)
      ? {...sc, reference: choice.reference, referenceApproved: true, referenceAt: choice.referenceAt} : sc;
  });
}
