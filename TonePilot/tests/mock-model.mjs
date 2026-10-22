#!/usr/bin/env node
// Fake Codex CLI. Identifies the photo from the mock preview bytes and answers with the
// assessment configured in the mock state (state.ai[id]) or a default proposal.
import fs from 'node:fs';
const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const answer = arg('--output-last-message'), image = arg('--image');
if (!answer || !image || !process.argv.includes('--output-schema')) process.exit(3);
const id = fs.readFileSync(image, 'utf8').split(':')[1];
const state = JSON.parse(fs.readFileSync(process.env.TONEPILOT_MOCK_STATE, 'utf8'));
if ((state.aiFail || []).includes(id)) { process.stderr.write('model unavailable'); process.exit(1); }
const record = state.ai?.[id] ?? state.aiDefault ?? {
  skip: false, confidence: 0.96, scene: 'open shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
  intent: 'none', skinCast: 'none', subjectExposure: 'under',
  changes: [{setting: 'Exposure2012', value: state.photos[id].settings.exposure + 0.3}],
  reason: 'Test fixture: subject slightly underexposed'
};
const finish = () => {
  fs.writeFileSync(answer, JSON.stringify(record));
  process.stdout.write(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1200, output_tokens: 90}}) + '\n');
};
if (state.aiDelayMs) setTimeout(finish, state.aiDelayMs); else finish();
