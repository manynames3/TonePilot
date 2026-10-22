#!/usr/bin/env node
// Fake Codex CLI. Identifies each photo from its mock preview bytes and answers with the
// assessment configured in the mock state (state.ai[id]) or a default proposal. Several
// --image arguments get a batch answer ({photos: [{index, ...}]}); state.aiBatchMalformed
// drops the last entry. Every call is logged to <state>.calls as its image count.
import fs from 'node:fs';
const args = process.argv;
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const answer = arg('--output-last-message'), schemaFile = arg('--output-schema');
const images = args.flatMap((a, i) => (a === '--image' ? [args[i + 1]] : []));
if (!answer || !images.length || !schemaFile) process.exit(3);
const batch = images.length > 1;
if (batch !== !!JSON.parse(fs.readFileSync(schemaFile, 'utf8')).properties.photos) process.exit(3);
fs.appendFileSync(process.env.TONEPILOT_MOCK_STATE + '.calls', images.length + '\n');
const ids = images.map(f => fs.readFileSync(f, 'utf8').split(':')[1]);
const state = JSON.parse(fs.readFileSync(process.env.TONEPILOT_MOCK_STATE, 'utf8'));
if (ids.some(id => (state.aiFail || []).includes(id))) { process.stderr.write('model unavailable'); process.exit(1); }
const recordFor = id => state.ai?.[id] ?? state.aiDefault ?? {
  skip: false, confidence: 0.96, scene: 'open shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
  intent: 'none', skinCast: 'none', subjectExposure: 'under',
  changes: [{setting: 'Exposure2012', value: state.photos[id].settings.exposure + 0.3}],
  reason: 'Test fixture: subject slightly underexposed'
};
const result = !batch ? recordFor(ids[0])
  : {photos: ids.map((id, i) => ({index: i + 1, ...recordFor(id)})).slice(0, state.aiBatchMalformed ? -1 : undefined)};
const finish = () => {
  fs.writeFileSync(answer, JSON.stringify(result));
  process.stdout.write(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1200, output_tokens: 90}}) + '\n');
};
if (state.aiDelayMs) setTimeout(finish, state.aiDelayMs); else finish();
