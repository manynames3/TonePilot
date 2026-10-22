#!/usr/bin/env node
// Generates synthetic demo sessions (planned, applied-then-partly-restored, interrupted)
// by running the real engine against the mock Lightroom bridge. For UI review and
// public screenshots, so no real client photo, filename or description is ever shown.
//
//   node TonePilot/tests/demo-sessions.mjs /path/to/demo-runs
import {cpSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {setup, rawPhoto} from './helpers.mjs';

const out = resolve(process.argv[2] || 'demo-runs');
rmSync(out, {recursive: true, force: true});
mkdirSync(out, {recursive: true});

const ai = (o = {}) => ({skip: false, confidence: 0.9, scene: 'Bridal suite, window light', illuminant: 'window', mixedLighting: false,
  backlit: false, intent: 'none', skinCast: 'none', subjectExposure: 'ok', changes: [], reason: 'Skin and exposure look natural.', ...o});
const t = (m, s = 0) => '2026-06-14 ' + String(13 + Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':' + String(s).padStart(2, '0');

const photos = {
  501: rawPhoto('BRIDE_0412.CR3', {dateTimeOriginal: t(2), asShot: {temperature: 5050, tint: 6}, settings: {...rawPhoto('').settings, temperature: 5050, tint: 6}, metrics: {faceLuma: 0.11, clip: 0.002}}),
  502: rawPhoto('BRIDE_0415.CR3', {dateTimeOriginal: t(3), asShot: {temperature: 5600, tint: 3}, settings: {...rawPhoto('').settings, temperature: 5600, tint: 3}, metrics: {faceLuma: 0.07, clip: 0.001}}),
  503: rawPhoto('BRIDE_0419.CR3', {dateTimeOriginal: t(4), asShot: {temperature: 5250, tint: 5}, settings: {...rawPhoto('').settings, temperature: 5250, tint: 5}, metrics: {faceLuma: 0.11, clip: 0.03, clipAtEV: Array.from({length: 20}, (_, i) => 0.03 + (i + 1) * 0.003)}}),
  504: rawPhoto('BRIDE_0423.CR3', {dateTimeOriginal: t(5), metrics: {faceLuma: 0.02, clip: 0.0}}),
  505: rawPhoto('RECEPTION_1102.CR3', {dateTimeOriginal: t(300), flash: 'Did fire', iso: 'ISO 3200', asShot: {temperature: 3300, tint: 8}, settings: {...rawPhoto('').settings, temperature: 3300, tint: 8}, metrics: {faceLuma: 0.09, clip: 0.004}}),
  506: rawPhoto('RECEPTION_1107.CR3', {dateTimeOriginal: t(301), flash: 'Did fire', iso: 'ISO 3200', asShot: {temperature: 3300, tint: 8}, settings: {...rawPhoto('').settings, temperature: 3300, tint: 8}, metrics: {faceLuma: 0.09, clip: 0.004}}),
  507: rawPhoto('DETAILS_0388.JPG', {fileFormat: 'JPG', dateTimeOriginal: t(1), settings: {whiteBalance: 'As Shot', exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0}, metrics: {clip: 0.01}})
};
const plan = {
  501: ai(),
  502: ai({subjectExposure: 'under', changes: [{setting: 'Exposure2012', value: 0.6}], reason: 'Bride\'s face is half a stop darker than the frames around it.'}),
  503: ai({subjectExposure: 'under', changes: [{setting: 'Exposure2012', value: 0.5}, {setting: 'Highlights2012', value: -20}], reason: 'Face slightly dark; the white dress is close to clipping.'}),
  504: ai({intent: 'low-key', subjectExposure: 'under', confidence: 0.86, changes: [{setting: 'Exposure2012', value: 0.9}], reason: 'Window silhouette; the dark subject looks deliberate.'}),
  505: ai({scene: 'Reception, bounced flash with tungsten ambient', illuminant: 'mixed', mixedLighting: true, subjectExposure: 'ok', skinCast: 'too-warm', reason: 'Flash and tungsten mix on skin; warmth on the left cheek is ambient spill.'}),
  506: ai({scene: 'Reception, bounced flash', illuminant: 'flash', confidence: 0.7, subjectExposure: 'over', changes: [{setting: 'Exposure2012', value: -0.4}], reason: 'Unsure whether the bright faces are intentional.'}),
  507: ai({scene: 'Rings on invitation', subjectExposure: 'no-subject', changes: [{setting: 'Shadows2012', value: 12}], reason: 'Lift the shadow under the rings slightly.'})
};

const ids = Object.keys(photos);
function session(fn) {
  const x = setup({photos: structuredClone(photos), ai: plan});
  try {
    const dir = x.analyze(ids, ['--look', 'Natural', '--strength', 'Balanced']);
    fn?.(x, dir);
    for (const name of readdirSync(x.runs)) cpSync(join(x.runs, name), join(out, name), {recursive: true});
  } finally { x.cleanup(); }
}

session();                                                             // ready to review
session((x, dir) => {                                                 // applied, then a manual edit blocks one restore
  x.run(['--mode', 'apply', '--session', dir, '--confirm']);
  x.set(s => { s.photos[502].settings.exposure = 0.75; });
  x.run(['--mode', 'restore', '--session', dir, '--confirm']);
});
session((x, dir) => {                                                 // engine killed mid-apply
  x.set(s => { s.faults = {killAfterWrite: 2}; });
  x.run(['--mode', 'apply', '--session', dir, '--confirm']);
});
console.log('Demo sessions written to ' + out);
