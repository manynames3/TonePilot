#!/usr/bin/env node
// Scores a BLIND, independently rated evaluation. It cannot create quality evidence;
// it only summarizes ratings that photographers made without knowing which method
// produced each edit.
//
//   node evaluate.mjs scored-gallery.json
//
// Input: {"blinded": true, "photos": [{"id", "category": {"lighting": "...", "skin": "..."},
//   "confidence": 0.87, "scores": {"tonepilot": {"accepted", "majorRegression", "reviewMinutes"},
//   "<baseline>": {...}, ...}}]}. Any number of baselines (Lightroom Auto, a competitor,
//   the photographer's own preset) may be scored alongside "tonepilot".
import fs from 'node:fs';
import path from 'node:path';

export const TARGETS = Object.freeze({acceptance: 0.85, majorRegression: 0.02, timeSaved: 0.40, minPhotos: 100});

// Wilson score interval: honest at small n and near 0 or 1, unlike p ± 1.96·SE.
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function binomTwoSided(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let tail = 0, coef = 1;
  for (let i = 0; i <= k; i++) { if (i) coef = coef * (n - i + 1) / i; tail += coef; }
  return Math.min(1, 2 * tail / 2 ** n);
}

// McNemar exact test on paired accept/reject outcomes of the SAME photos.
export function mcnemar(rows, a, b) {
  let onlyA = 0, onlyB = 0;
  for (const r of rows) {
    const x = r.scores[a]?.accepted, y = r.scores[b]?.accepted;
    if (x && !y) onlyA++; else if (!x && y) onlyB++;
  }
  return {onlyA, onlyB, p: binomTwoSided(onlyA, onlyB)};
}

function check(score, method, id) {
  if (!score || typeof score.accepted !== 'boolean' || typeof score.majorRegression !== 'boolean' ||
      !Number.isFinite(score.reviewMinutes) || score.reviewMinutes < 0)
    throw new Error('Incomplete independent scoring for ' + method + ' on ' + id);
  return score;
}

export function summarize(rows, method) {
  const s = rows.map(r => check(r.scores[method], method, r.id));
  const n = s.length, acc = s.filter(x => x.accepted).length, reg = s.filter(x => x.majorRegression).length;
  const minutes = s.reduce((t, x) => t + x.reviewMinutes, 0);
  return {method, photos: n, accepted: acc, acceptance: acc / n, acceptanceCI: wilson(acc, n),
    majorRegressions: reg, majorRegressionRate: reg / n, majorRegressionCI: wilson(reg, n),
    reviewMinutes: minutes, minutesPerPhoto: minutes / n};
}

function byCategory(rows, key) {
  const groups = {};
  for (const r of rows) { const g = r.category?.[key] ?? 'unspecified'; (groups[g] ||= []).push(r); }
  return Object.fromEntries(Object.entries(groups).map(([g, list]) => {
    const t = summarize(list, 'tonepilot');
    return [g, {photos: t.photos, acceptance: t.acceptance, acceptanceCI: t.acceptanceCI, majorRegressionRate: t.majorRegressionRate}];
  }));
}

// Reliability of the model's self-reported confidence, and the lowest threshold whose
// accepted-rate clears the target. Without this, confidence is just a number.
export function calibration(rows, target = TARGETS.acceptance) {
  const rated = rows.filter(r => Number.isFinite(r.confidence));
  if (rated.length < 20) return {available: false, reason: 'Needs at least 20 photos with model confidence'};
  const bins = [];
  for (let lo = 0.5; lo < 1; lo += 0.1) {
    const hi = lo + 0.1 + (lo > 0.85 ? 1e-9 : 0);
    const inBin = rated.filter(r => r.confidence >= lo && r.confidence < hi);
    if (!inBin.length) continue;
    const meanConf = inBin.reduce((t, r) => t + r.confidence, 0) / inBin.length;
    const acc = inBin.filter(r => r.scores.tonepilot.accepted).length / inBin.length;
    bins.push({from: +lo.toFixed(1), to: +(lo + 0.1).toFixed(1), photos: inBin.length, meanConfidence: meanConf, accepted: acc});
  }
  const ece = bins.reduce((t, b) => t + b.photos / rated.length * Math.abs(b.meanConfidence - b.accepted), 0);
  let threshold = null;
  for (const c of [...new Set(rated.map(r => r.confidence))].sort((a, b) => a - b)) {
    const kept = rated.filter(r => r.confidence >= c);
    const k = kept.filter(r => r.scores.tonepilot.accepted).length;
    if (kept.length >= 20 && wilson(k, kept.length)[0] >= target) { threshold = {confidence: c, coverage: kept.length / rated.length, acceptance: k / kept.length}; break; }
  }
  return {available: true, photos: rated.length, bins, expectedCalibrationError: ece, recommendedThreshold: threshold};
}

export function evaluate(raw) {
  if (!Array.isArray(raw?.photos) || !raw.photos.length) throw new Error('Missing evaluations');
  if (raw.blinded !== true) throw new Error('Evaluations must document blind scoring');
  const rows = raw.photos;
  const methods = [...new Set(rows.flatMap(r => Object.keys(r.scores || {})))];
  if (!methods.includes('tonepilot')) throw new Error('No TonePilot scores');
  const results = Object.fromEntries(methods.map(m => [m, summarize(rows, m)]));
  const tp = results.tonepilot;
  const comparisons = methods.filter(m => m !== 'tonepilot').map(m => {
    const test = mcnemar(rows, 'tonepilot', m);
    const saved = results[m].reviewMinutes > 0 ? 1 - tp.reviewMinutes / results[m].reviewMinutes : null;
    return {baseline: m, acceptanceDifference: tp.acceptance - results[m].acceptance, mcnemar: test,
      significantlyBetter: test.p < 0.05 && test.onlyA > test.onlyB, timeSavedFraction: saved};
  });
  const best = comparisons.reduce((a, c) => (a === null || (c.timeSavedFraction ?? -1) < (a.timeSavedFraction ?? -1) ? c : a), null);
  const gates = {
    enoughPhotos: rows.length >= TARGETS.minPhotos,
    acceptanceAtLeast85: tp.acceptance >= TARGETS.acceptance,
    acceptanceLowerBoundAtLeast85: tp.acceptanceCI[0] >= TARGETS.acceptance,
    regressionsUnder2Percent: tp.majorRegressionRate < TARGETS.majorRegression,
    regressionUpperBoundUnder2Percent: tp.majorRegressionCI[1] < TARGETS.majorRegression,
    timeSavedAtLeast40AgainstEveryBaseline: comparisons.length > 0 && comparisons.every(c => c.timeSavedFraction !== null && c.timeSavedFraction >= TARGETS.timeSaved),
    significantlyBetterThanABaseline: comparisons.some(c => c.significantlyBetter)
  };
  const lightingGroups = byCategory(rows, 'lighting'), skinGroups = byCategory(rows, 'skin');
  const weakest = Object.entries(skinGroups).filter(([, g]) => g.photos >= 10).sort((a, b) => a[1].acceptance - b[1].acceptance)[0];
  return {evaluations: rows.length, methods: results, comparisons, hardestBaseline: best?.baseline ?? null,
    byLighting: lightingGroups, bySkinGroup: skinGroups,
    weakestSkinGroup: weakest ? {group: weakest[0], ...weakest[1]} : null,
    calibration: calibration(rows), gates,
    validated: Object.values(gates).every(Boolean),
    note: 'Point estimates are reported with 95% Wilson intervals. "validated" requires the interval, not just the estimate, to clear each target.'};
}

if (import.meta.url === 'file://' + path.resolve(process.argv[1] || '')) {
  if (process.argv.length !== 3) { console.error('Usage: node evaluate.mjs /path/to/independently-scored-gallery.json'); process.exit(2); }
  const result = evaluate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  if (!result.gates.enoughPhotos) { console.error('Preliminary sample under ' + TARGETS.minPhotos + ' photos; do not market this result.'); process.exitCode = 3; }
}
