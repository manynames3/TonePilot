#!/usr/bin/env node
// Fake Codex CLI. Identifies each photo from its mock preview bytes and answers as
// mock-answers.mjs says. Every call is logged to <state>.calls as its image count.
import fs from 'node:fs';
import {answerFor, photoIdOf, recordSecrets} from './mock-answers.mjs';
recordSecrets('codex');
const args = process.argv;
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const answer = arg('--output-last-message'), schemaFile = arg('--output-schema');
const images = args.flatMap((a, i) => (a === '--image' ? [args[i + 1]] : []));
if (!answer || !images.length || !schemaFile) process.exit(3);
const batch = images.length > 1;
if (batch !== !!JSON.parse(fs.readFileSync(schemaFile, 'utf8')).properties.photos) process.exit(3);
fs.appendFileSync(process.env.TONEPILOT_MOCK_STATE + '.calls', images.length + '\n');
fs.appendFileSync(process.env.TONEPILOT_MOCK_STATE + '.codex', JSON.stringify({model: arg('-m'),
  config: args.flatMap((a, i) => (a === '-c' ? [args[i + 1]] : []))}) + '\n');
const ids = images.map(f => photoIdOf(fs.readFileSync(f, 'utf8')));
const state = JSON.parse(fs.readFileSync(process.env.TONEPILOT_MOCK_STATE, 'utf8'));
if (ids.some(id => (state.aiFail || []).includes(id))) { process.stderr.write('model unavailable'); process.exit(1); }
if (state.codexError) {   // as Codex reports a plan limit: JSON events on stdout, exit 1
  process.stdout.write(JSON.stringify({type: 'error', message: state.codexError}) + '\n');
  process.stdout.write(JSON.stringify({type: 'turn.failed', error: {message: state.codexError}}) + '\n');
  process.exit(1);
}
const result = answerFor(state, ids, batch);
const finish = () => {
  fs.writeFileSync(answer, JSON.stringify(result));
  process.stdout.write(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1200, output_tokens: 90}}) + '\n');
};
if (state.aiDelayMs) setTimeout(finish, state.aiDelayMs); else finish();
