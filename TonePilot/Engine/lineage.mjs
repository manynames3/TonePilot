// Session lineage: what TonePilot has already done to a photo in earlier sessions.
//
// Limits are measured from a photo's ORIGIN: its values before any TonePilot session
// that is still in effect. If a key still holds the value an earlier TonePilot session
// wrote, that session's origin carries forward, so repeated runs cannot creep past the
// cumulative cap. If the photographer has since changed the key by hand, their value
// is the new authority and becomes the origin.
import {listSessionDirs, loadSession} from './session.mjs';
import {valuesEqual} from './guard.mjs';

const PRESENT = new Set(['applied', 'apply-mismatch', 'restore-mismatch']);
const keyOf = (id, path) => id + '\u0000' + path;

export function loadLineage(runs, excludeSession) {
  const lineage = new Map();
  for (const dir of listSessionDirs(runs)) {
    let s;
    try { s = loadSession(dir); } catch { continue; }
    if (!s || s.id === excludeSession) continue;
    for (const id of s.order) {
      const p = s.photos[id];
      if (!PRESENT.has(p.state) || !p.identity || !p.after?.values) continue;
      const k = keyOf(p.identity.id, p.identity.path);
      // After an incomplete restore the photo holds whatever the restore left behind.
      const after = p.state === 'restore-mismatch' && p.restoredValues ? p.restoredValues : p.after.values;
      const entry = {session: s.id, at: p.write?.at || s.lastAt, applied: p.applied || {},
        after, origin: p.origin || p.baseline || {}};
      const list = lineage.get(k) || [];
      list.push(entry);
      lineage.set(k, list);
    }
  }
  for (const list of lineage.values()) list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return lineage;
}

export function originFor(lineage, identity, current) {
  const history = lineage.get(keyOf(identity.id, identity.path)) || [];
  const latest = history.at(-1);
  const origin = {...current};
  const carried = [];
  if (latest) {
    for (const key of Object.keys(latest.applied)) {
      if (key in current && valuesEqual(key, latest.after[key], current[key]) && key in latest.origin) {
        origin[key] = latest.origin[key];
        carried.push(key);
      }
    }
  }
  const prior = latest && carried.length ? {session: latest.session, at: latest.at, keys: carried,
    sessions: history.length} : null;
  return {origin, prior};
}
