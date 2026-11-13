// Randomized stress test of the planner (decide): thousands of synthetic scenes, checked
// against properties that must hold for every input. Seeded, so a failure is reproducible
// (the failing seed is printed). It proves the rules are self-consistent, not that edits look good.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decide} from '../Engine/harmonize.mjs';
import {resolvePolicy, mired, HARD_CAPS} from '../Engine/policy.mjs';
import {SKIN_VERDICTS, SUBJECT_EXPOSURE, INTENTS, ILLUMINANTS} from '../Engine/ai.mjs';

function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const WB = ['Temperature', 'Tint', 'IncrementalTemperature', 'IncrementalTint'];
const TONE = ['Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012'];

function scenario(seed) {
  const r = rng(seed), pick = xs => xs[Math.floor(r() * xs.length)], maybe = p => r() < p, between = (lo, hi) => lo + r() * (hi - lo);
  const look = pick(['Natural', 'Soft & airy', 'True to scene']), strength = pick(['Subtle', 'Balanced', 'Stronger']);
  const enabled = {wb: maybe(0.9), exposure: maybe(0.9), tone: maybe(0.3)};
  if (!enabled.wb && !enabled.exposure && !enabled.tone) enabled.exposure = true;
  const flash = maybe(0.15), sceneTemp = pick([2800, 3200, 4300, 5200, 6500, 9000]);
  const photos = Array.from({length: 1 + Math.floor(r() * 6)}, (_, i) => {
    const relative = maybe(0.2), wbOk = maybe(0.95);
    const base = relative
      ? {WhiteBalance: 'As Shot', IncrementalTemperature: Math.round(between(-20, 20)), IncrementalTint: Math.round(between(-20, 20))}
      : {WhiteBalance: pick(['As Shot', 'Custom', 'Auto']), Temperature: Math.round(sceneTemp + between(-400, 400)), Tint: Math.round(between(-30, 40))};
    Object.assign(base, {Exposure2012: maybe(0.3) ? Math.round(between(-1.5, 1.5) * 100) / 100 : 0,
      Highlights2012: 0, Shadows2012: 0, Whites2012: 0, Blacks2012: 0});
    // Origin: the photo before any earlier TonePilot pass (sometimes already moved, within one pass's reach).
    const origin = {...base};
    if (maybe(0.25)) origin.Exposure2012 = Math.round((base.Exposure2012 + between(-0.3, 0.3)) * 100) / 100;
    const face = maybe(0.8) ? between(0.01, 0.6) : null;
    const curve = Array.from({length: 20}, (_, k) => 0.001 + k * between(0, 0.004)).sort((a, b) => a - b);
    const metrics = maybe(0.93) ? {width: pick([416, 640, 1024]), height: 640,
      subject: face ? {method: 'face', luma: face, area: between(0.001, 0.2)} : {method: maybe(0.5) ? 'person' : 'none', luma: between(0.05, 0.5)},
      faces: face ? [{luma: face, hue: between(20, 80), area: 0.05}] : [],
      clip: {channel: 0.001}, clipAtEV: curve, grid: Array(48).fill(50),
      whites: maybe(0.7) ? {a: between(-5, 5), b: between(-5, 5), fraction: between(0, 0.5)} : undefined,
      neutral: maybe(0.7) ? {a: between(-4, 4), b: between(-4, 4), fraction: between(0, 0.6)} : undefined} : null;
    const verdict = pick(SKIN_VERDICTS);
    const proposed = {};
    if (maybe(0.5)) proposed.Exposure2012 = Math.round((base.Exposure2012 + between(-1.2, 1.2)) * 100) / 100;
    if (maybe(0.3)) proposed[pick(TONE)] = Math.round(between(-40, 40));
    const ai = maybe(0.95) ? {skip: maybe(0.05), confidence: maybe(0.03) ? undefined : Math.round(between(0.5, 1) * 100) / 100,
      scene: 's', illuminant: pick(ILLUMINANTS), mixedLighting: maybe(0.2), backlit: maybe(0.2), intent: pick(INTENTS.concat(Array(6).fill('none'))),
      skinCast: 'none', subjectExposure: pick(SUBJECT_EXPOSURE), proposed, reason: 'r',
      skinTone: maybe(0.9) ? {verdict, temperatureShift: ['correct', 'no-skin', 'mixed-light'].includes(verdict) ? 0 : Math.round(between(-700, 700)),
        tintShift: ['correct', 'no-skin', 'mixed-light'].includes(verdict) ? 0 : Math.round(between(-14, 14)), note: ''} : null} : null;
    return {id: String(i + 1), filename: 'F' + i, state: maybe(0.04) ? 'unsupported' : 'baselined', baseline: base, origin,
      capabilities: {supported: true, wb: wbOk, wbMode: wbOk ? (relative ? 'relative' : 'kelvin') : null, exposure: true, tone: true},
      identity: {captureTime: '2026-06-01 15:00:' + String(i * 7 % 60).padStart(2, '0')},
      exif: {cameraModel: 'R5', flash: flash ? 'Fired' : 'Did not fire', aperture: 'f / 2.8',
        shutterSpeed: pick(['1/125 sec', '1/250 sec', '1/250 sec', '1/500 sec']), isoSpeedRating: pick(['ISO 400', 'ISO 400', 'ISO 800'])},
      metrics, ai, aiError: ai ? null : 'unavailable'};
  });
  const scene = {id: 'S1', photos: photos.map(p => p.id), reference: photos[0].id, flash,
    ...(maybe(0.15) ? {referenceApproved: true, reference: pick(photos).id} : {})};
  return {photos, scenes: [scene], policy: resolvePolicy(look, strength), enabled, look, strength};
}

function check(seed) {
  const s = scenario(seed), where = 'seed ' + seed;
  const out = decide({photos: s.photos, scenes: s.scenes, policy: s.policy, enabled: s.enabled});
  assert.deepEqual(decide({photos: s.photos, scenes: s.scenes, policy: s.policy, enabled: s.enabled}), out, where + ': same input, same plan');
  const shuffled = [...s.photos].reverse();
  assert.deepEqual(decide({photos: shuffled, scenes: s.scenes, policy: s.policy, enabled: s.enabled}), out, where + ': photo order in memory must not matter');
  for (const p of s.photos) {
    const d = out[p.id], at = where + ' photo ' + p.id + ' ' + JSON.stringify(d);
    assert.ok(d && ['proposed', 'skipped', 'flagged', 'unsupported'].includes(d.status), at);
    assert.ok(!String(d.reason).startsWith('Blocked by safety limits'), at + ': the planner proposed something its own limits reject');
    const keys = Object.keys(d.changes);
    if (d.status !== 'proposed') { assert.equal(keys.length, 0, at); continue; }
    assert.ok(keys.length > 0, at);
    assert.ok(p.state !== 'unsupported' && p.ai && !p.ai.skip, at);
    assert.ok(p.ai.confidence >= s.policy.corroboratedConfidence, at + ': below the floor nothing is proposed');
    const reference = s.scenes[0].referenceApproved && s.scenes[0].reference === p.id;
    assert.ok(!reference, at + ': an approved reference is never changed');
    for (const k of keys) {
      const v = d.changes[k], from = p.origin[k] ?? p.baseline[k];
      assert.ok(Number.isFinite(v) && v !== p.baseline[k], at + ' ' + k);
      if (WB.includes(k)) assert.ok(s.enabled.wb && p.capabilities.wb, at);
      if (k === 'Exposure2012') assert.ok(s.enabled.exposure, at);
      if (TONE.includes(k)) assert.ok(s.enabled.tone && p.ai.confidence >= s.policy.minConfidence, at);
      if ((k === 'Temperature' || k === 'Tint') ) assert.equal(p.capabilities.wbMode, 'kelvin', at);
      if (k.startsWith('Incremental')) assert.equal(p.capabilities.wbMode, 'relative', at);
      const moved = k === 'Temperature' ? Math.abs(mired(v) - mired(from)) : Math.abs(v - from);
      const cap = k === 'Temperature' ? s.policy.caps.TemperatureMired : k === 'IncrementalTint' ? s.policy.caps.Tint : s.policy.caps[k];
      const hard = k === 'Temperature' ? HARD_CAPS.TemperatureMired : k === 'IncrementalTint' ? HARD_CAPS.Tint : HARD_CAPS[k];
      assert.ok(moved <= Math.min(cap, hard) + 1e-6, at + ': ' + k + ' moved ' + moved + ' from its origin, limit ' + cap);
    }
    if (p.ai.confidence < s.policy.minConfidence) assert.ok(keys.every(k => k === 'Exposure2012' || WB.includes(k)), at + ': below the bar only exposure / white balance');
  }
}

test('planner invariants hold across 4,000 random scenes', () => {
  for (let seed = 1; seed <= 4000; seed++) check(seed);
});

test('a journal cut at any byte (crash, power loss) reopens truthfully: never "applied" or "restored" beyond what was recorded', async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const {setup, rawPhoto} = await import('./helpers.mjs');
  const {loadSession, deriveStatus, sessionView} = await import('../Engine/session.mjs');
  const x = setup({photos: {101: rawPhoto('A.CR3'), 102: rawPhoto('B.CR3'), 103: rawPhoto('C.CR3')}});
  try {
    const dir = x.analyze(['101', '102', '103']);
    assert.equal(x.run(['--mode', 'apply', '--session', dir, '--confirm']).status, 0);
    assert.equal(x.run(['--mode', 'restore', '--session', dir, '--confirm']).status, 0);
    const full = fs.readFileSync(path.join(dir, 'journal.jsonl'));
    const cut = path.join(x.temp, 'cut'); fs.mkdirSync(cut);
    const seen = new Set();
    for (let n = 0; n <= full.length; n += (n % 97 === 0 ? 1 : 3)) {
      fs.writeFileSync(path.join(cut, 'journal.jsonl'), full.subarray(0, n));
      const s = loadSession(cut);
      if (!s) continue;
      const status = deriveStatus(s), at = 'cut at byte ' + n + ' → ' + status.status;
      sessionView(s);   // must never throw
      seen.add(status.status);
      assert.notEqual(status.status, 'damaged', at + ': a torn tail is not damage');
      // What the surviving complete records prove, independently of the fold.
      const lines = full.subarray(0, n).toString('utf8').split('\n').slice(0, -1).map(l => JSON.parse(l));
      const last = {};
      for (const r of lines) if (['write-intent', 'write-result', 'restore-intent', 'restore-result'].includes(r.type)) last[r.photo] = r;
      const inFlight = Object.values(last).some(r => r.type.endsWith('-intent'));
      const present = Object.values(last).filter(r => r.type === 'write-result' && r.outcome === 'verified').length;
      const everWritten = new Set(lines.filter(r => r.type === 'write-result' && r.outcome === 'verified').map(r => r.photo)).size;
      if (inFlight) assert.equal(status.status, 'interrupted', at);
      if (inFlight) assert.ok(!status.actions.apply && !status.actions.restore && !status.actions.discard, at + ': nothing but a check is offered');
      if (status.status === 'applied') assert.ok(present > 0 && present === everWritten && !inFlight, at);
      if (status.status === 'restored') assert.ok(present === 0 && everWritten > 0 && !inFlight, at);
      if (['planned', 'analysis-incomplete', 'analysis-failed', 'not-applied'].includes(status.status)) assert.equal(present, 0, at);
      assert.equal(status.present, present, at + ': photos believed changed in Lightroom');
    }
    for (const st of ['analysis-incomplete', 'planned', 'interrupted', 'partially-applied', 'applied', 'partially-restored', 'restored'])
      assert.ok(seen.has(st), 'the cuts passed through ' + st + ' (saw ' + [...seen].join(', ') + ')');
  } finally { x.cleanup(); }
});
