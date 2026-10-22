// Write boundary rules. Everything here is deterministic and model-independent:
// a model recommendation is never permission to exceed these limits.
import {HARD_CAPS, mired} from './policy.mjs';

// The pilot ceiling. Raise only after the scale gates in docs/VALIDATION.md pass.
export const MAX_JOB_PHOTOS = 20;

// Keys TonePilot may propose. WhiteBalance is never proposed: Lightroom switches it
// to Custom by itself when Temperature/Tint change, and restore puts the original back.
// RAW files use Kelvin Temperature/Tint; JPEG, HEIC and TIFF files use Lightroom's
// relative IncrementalTemperature/IncrementalTint (−100…+100, 0 = as shot).
export const ALLOW = Object.freeze({
  Temperature: 'wb', Tint: 'wb', IncrementalTemperature: 'wb', IncrementalTint: 'wb', Exposure2012: 'exposure',
  Highlights2012: 'tone', Shadows2012: 'tone', Whites2012: 'tone', Blacks2012: 'tone'
});
export const WB_KEYS = Object.freeze(['Temperature', 'Tint', 'IncrementalTemperature', 'IncrementalTint']);
// Lightroom SDK key -> field name in the bridge's get_photo_metadata developSettings.
export const FIELD = Object.freeze({
  WhiteBalance: 'whiteBalance', Temperature: 'temperature', Tint: 'tint',
  IncrementalTemperature: 'incrementalTemperature', IncrementalTint: 'incrementalTint',
  Exposure2012: 'exposure', Highlights2012: 'highlights', Shadows2012: 'shadows',
  Whites2012: 'whites', Blacks2012: 'blacks'
});
export const WB_MODES = Object.freeze(['As Shot', 'Auto', 'Daylight', 'Cloudy', 'Shade',
  'Tungsten', 'Fluorescent', 'Flash', 'Custom']);

const RANGE = {
  Temperature: [2000, 50000], Tint: [-150, 150], IncrementalTemperature: [-100, 100], IncrementalTint: [-100, 100], Exposure2012: [-5, 5],
  Highlights2012: [-100, 100], Shadows2012: [-100, 100], Whites2012: [-100, 100], Blacks2012: [-100, 100]
};
// Read-back tolerance: Lightroom stores some values as float32.
const TOLERANCE = {Temperature: 1.5, Tint: 0.6, IncrementalTemperature: 0.6, IncrementalTint: 0.6, Exposure2012: 0.006,
  Highlights2012: 0.6, Shadows2012: 0.6, Whites2012: 0.6, Blacks2012: 0.6};

export function validateIDs(ids, max = MAX_JOB_PHOTOS) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > max) throw new Error('A job needs 1–' + max + ' photos');
  const str = ids.map(String);
  if (str.some(x => !/^[0-9]+$/.test(x)) || new Set(str).size !== str.length) throw new Error('Invalid or duplicate photo ID');
  return str;
}

// Lightroom's own slider granularity; writing finer values only invites read-back mismatches.
export function roundSetting(key, value) {
  if (key === 'Exposure2012') return Math.round(value * 100) / 100;
  return Math.round(value);
}

function delta(key, from, to) {
  return key === 'Temperature' ? Math.abs(mired(to) - mired(from)) : Math.abs(to - from);
}
function capFor(key, caps) {
  if (key === 'Temperature') return caps.TemperatureMired;
  if (key === 'IncrementalTint') return caps.Tint;
  return caps[key];
}

// origin: the photo's values before ANY TonePilot session touched them (see lineage.mjs).
// baseline: the values at the start of this session. Both limits apply.
export function validateSettings({origin, baseline, proposed, enabled, caps}) {
  if (!baseline || typeof baseline !== 'object') throw new Error('Missing Develop baseline');
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) throw new Error('Invalid proposed settings');
  const keys = Object.keys(proposed);
  if (!keys.length) throw new Error('Empty adjustment');
  const updates = {};
  for (const key of keys) {
    if (!Object.hasOwn(ALLOW, key)) throw new Error('Setting is not allowlisted: ' + key);
    if (!enabled[ALLOW[key]]) throw new Error('Adjustment is disabled: ' + key);
    const old = baseline[key], from = origin?.[key] ?? old, next = proposed[key];
    if (typeof old !== 'number' || !Number.isFinite(old)) throw new Error('Baseline setting unavailable: ' + key);
    if (typeof from !== 'number' || !Number.isFinite(from)) throw new Error('Origin setting unavailable: ' + key);
    if (typeof next !== 'number' || !Number.isFinite(next)) throw new Error('Setting must be finite: ' + key);
    const [min, max] = RANGE[key];
    if (next < min || next > max) throw new Error('Out-of-range value: ' + key);
    const limit = Math.min(capFor(key, caps), capFor(key, HARD_CAPS)) + 1e-6;
    if (delta(key, old, next) > limit) throw new Error('Excessive change in one session: ' + key);
    if (delta(key, from, next) > limit) throw new Error('Cumulative TonePilot change limit exceeded: ' + key);
    if (valuesEqual(key, old, next)) throw new Error('No-op adjustment: ' + key);
    updates[key] = next;
  }
  return updates;
}

export function valuesEqual(key, a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= (TOLERANCE[key] ?? 1e-4);
  return a === b;
}

export function developmentView(metadata) {
  if (!metadata?.developSettings || typeof metadata.developSettings !== 'object')
    throw new Error('Lightroom did not provide Develop settings');
  const record = {};
  for (const [key, name] of Object.entries(FIELD)) {
    const x = metadata.developSettings[name];
    if ((typeof x === 'number' && Number.isFinite(x)) || typeof x === 'string') record[key] = x;
  }
  return record;
}

// Catalog identity of a photo. Local IDs are per catalog, so the source path and
// filename confirm the same catalog is open; virtual copies share a path but not an ID.
export function identityOf(id, metadata) {
  return {id: String(id), path: String(metadata.path || ''), filename: String(metadata.filename || ''),
    fileFormat: String(metadata.fileFormat || ''), captureTime: String(metadata.dateTimeOriginal || '')};
}
export function sameIdentity(a, b) {
  return a.id === b.id && a.path === b.path && a.filename === b.filename &&
    (!a.fileFormat || !b.fileFormat || a.fileFormat === b.fileFormat);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}
// Bridge-exposed Develop fields that differ. The bridge exposes ~25 fields; masks, crop,
// profile, lens and calibration are not visible to any check made through it.
export function diffSnapshot(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const a = before?.[key], b = after?.[key];
    if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 1e-4) changed.push(key); continue; }
    if (JSON.stringify(stable(a)) !== JSON.stringify(stable(b))) changed.push(key);
  }
  return changed.sort();
}

// Fields a write may legitimately change. Setting a white-balance number flips the WB
// mode to Custom; selecting a WB mode recomputes the white-balance numbers.
// settings: the values a write sets. Selecting a preset mode (As Shot, Auto, Daylight…)
// recomputes the white-balance numbers; Custom keeps them.
function touchedFields(settings) {
  const keys = Object.keys(settings);
  const fields = new Set(keys.map(k => FIELD[k]));
  if (keys.some(k => WB_KEYS.includes(k))) fields.add('whiteBalance');
  if ('WhiteBalance' in settings && settings.WhiteBalance !== 'Custom') for (const k of WB_KEYS) fields.add(FIELD[k]);
  return fields;
}

// Lightroom's SDK changes Temperature/Tint without updating the WB mode label (observed
// on real Lightroom: Tint changed, mode still "As Shot"). Any white-balance write therefore
// also selects Custom, in the same call, exactly as dragging the slider would.
export function withWhiteBalanceMode(intended, current) {
  const touchesWb = Object.keys(intended).some(k => WB_KEYS.includes(k));
  if (!touchesWb || current.WhiteBalance === undefined || current.WhiteBalance === 'Custom') return intended;
  return {WhiteBalance: 'Custom', ...intended};
}

// What a write actually did, judged only from values read back before and after it.
//   verified    intended values present, nothing else visible changed
//   not-applied nothing changed
//   mismatch    something changed, but not exactly as intended (needs review)
export function classifyWrite({preValues, preSnapshot, intended, afterValues, afterSnapshot}) {
  const keys = Object.keys(intended);
  const allowed = touchedFields(intended);
  const unexpected = diffSnapshot(preSnapshot, afterSnapshot).filter(f => !allowed.has(f));
  const mismatched = keys.filter(k => !valuesEqual(k, intended[k], afterValues[k]));
  const unchanged = keys.every(k => valuesEqual(k, preValues[k], afterValues[k])) &&
    diffSnapshot(preSnapshot, afterSnapshot).length === 0;
  let outcome = 'mismatch';
  if (!mismatched.length && !unexpected.length) outcome = 'verified';
  else if (unchanged) outcome = 'not-applied';
  return {outcome, mismatched, unexpected};
}

// Restore writes the original values TonePilot changed. When white balance was touched it
// writes the original WB mode together with the original numbers in one call (Lightroom's
// SDK neither flips nor reliably recomputes the mode on its own), then verifies all of them.
export function restorePlan(baseline, applied, afterValues) {
  const keys = Object.keys(applied);
  const expected = {}, target = {}, verify = {};
  for (const k of keys) {
    if (!(k in baseline)) throw new Error('Missing original value for ' + k);
    expected[k] = afterValues[k];
    target[k] = baseline[k];
    verify[k] = baseline[k];
  }
  const wbTouched = keys.some(k => WB_KEYS.includes(k));
  if (wbTouched && baseline.WhiteBalance !== undefined) {
    if (!WB_MODES.includes(baseline.WhiteBalance)) throw new Error('Unknown original white balance mode');
    expected.WhiteBalance = afterValues.WhiteBalance;
    target.WhiteBalance = verify.WhiteBalance = baseline.WhiteBalance;
    for (const k of WB_KEYS) if (typeof baseline[k] === 'number' && k in afterValues) { target[k] = baseline[k]; verify[k] = baseline[k]; }
  }
  return {target, expected, verify};
}

export function matches(expected, values) {
  return Object.keys(expected).filter(k => !valuesEqual(k, expected[k], values[k]));
}

export function classifyRestore({plan, preSnapshot, afterValues, afterSnapshot}) {
  const wrong = matches(plan.verify, afterValues);
  const allowed = touchedFields({...plan.verify, ...plan.target});
  const unexpected = diffSnapshot(preSnapshot, afterSnapshot).filter(f => !allowed.has(f));
  if (!wrong.length && !unexpected.length) return {outcome: 'restored', wrong, unexpected};
  if (!matches(plan.expected, afterValues).length && !diffSnapshot(preSnapshot, afterSnapshot).length)
    return {outcome: 'not-restored', wrong, unexpected};
  return {outcome: 'restore-mismatch', wrong, unexpected};
}

const NON_RAW_WB = 'White balance was left unchanged: for JPEG, HEIC and TIFF files Lightroom stores relative (Incremental) Temperature/Tint, which the installed Lightroom bridge cannot read or write.';
const NO_INCREMENTAL_WRITE = 'White balance was left unchanged: the Lightroom bridge reports relative (Incremental) Temperature/Tint for this file but does not accept writing them.';
// writable: Develop keys the bridge's write tool accepts (null when unknown, which is
// treated as "cannot write" for the relative white-balance keys).
export function capabilitiesOf(meta, values, writable = null) {
  const format = String(meta.fileFormat || '').toUpperCase();
  if (format === 'VIDEO') return {supported: false, reason: 'Video files are not edited by TonePilot.'};
  const exposure = typeof values.Exposure2012 === 'number';
  const tone = ['Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012'].every(k => typeof values[k] === 'number');
  if (!exposure && !tone) return {supported: false, reason: 'This photo uses a legacy Lightroom process version. Update it to the current process version in Lightroom first.'};
  const kelvin = typeof values.Temperature === 'number' && typeof values.Tint === 'number';
  const relative = typeof values.IncrementalTemperature === 'number' && typeof values.IncrementalTint === 'number';
  const relativeWritable = !!writable?.has('IncrementalTemperature') && !!writable?.has('IncrementalTint');
  const wbMode = kelvin ? 'kelvin' : relative && relativeWritable ? 'relative' : null;
  const wbNote = wbMode ? null : relative ? NO_INCREMENTAL_WRITE
    : format === 'RAW' || format === 'DNG' ? 'Lightroom did not report numeric white balance for this RAW file.' : NON_RAW_WB;
  return {supported: true, exposure, tone, wb: !!wbMode, wbMode, format, wbNote};
}
