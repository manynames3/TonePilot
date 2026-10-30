#!/usr/bin/env node
// Fake TonePilotAnalyzer: returns fixture measurements for the photo in a mock preview.
// Face brightness follows the photo's CURRENT exposure, so post-apply checks behave
// like the real analyzer measuring Lightroom's re-rendered preview.
import fs from 'node:fs';
import {recordSecrets} from './mock-answers.mjs';
recordSecrets('analyzer');
const [file] = process.argv.slice(2);
if (file === '--selftest') { console.log(JSON.stringify({passed: true, checks: []})); process.exit(0); }
const id = fs.readFileSync(file, 'utf8').split(':')[1];
const state = JSON.parse(fs.readFileSync(process.env.TONEPILOT_MOCK_STATE, 'utf8'));
const photo = state.photos[id];
const fx = photo.metrics;
if (!fx) process.exit(2);
const scale = 2 ** (photo.settings.exposure - (fx.atExposure ?? 0));
const luma = fx.faceLuma ? fx.faceLuma * scale : null;
const wbChanged = photo.settings.tint !== (fx.atTint ?? 4) || photo.settings.temperature !== (fx.atTemperature ?? 5200);
const whites = wbChanged && fx.whitesAfter ? fx.whitesAfter : fx.whites;
const clip = Math.min(1, (fx.clip ?? 0.001) * scale);
console.log(JSON.stringify({
  version: 1, width: 640, height: 427,
  luma: {median: 0.45, p05: 0.05, p95: 0.9, meanLinear: 0.18},
  clip: {white: clip / 2, channel: clip, deepShadow: 0.01},
  clipAtEV: fx.clipAtEV || Array.from({length: 20}, (_, i) => clip + (i + 1) * 0.0005),
  grid: fx.grid || Array(48).fill(50),
  neutral: fx.neutral || {a: 0, b: 0, fraction: 0.2}, whites: whites || {a: 0, b: 0, fraction: 0.05},
  faces: luma ? [{luma, lumaSRGB: 0.5, hue: fx.hue ?? 55, chroma: 20, area: 0.04}] : [],
  persons: luma ? 1 : 0,
  subject: luma ? {method: 'face', luma, lumaSRGB: 0.5, count: 1, area: 0.04} : {method: 'none'},
  exif: fx.exif || undefined, ms: 3
}));
