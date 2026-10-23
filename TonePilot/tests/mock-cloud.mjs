#!/usr/bin/env node
// TonePilot Cloud's real handler (TonePilot/Cloud/handler.mjs) on a local port, with an
// in-memory usage store and the fake model of mock-answers.mjs in place of Bedrock. Run as a
// process, it writes its port to TONEPILOT_MOCK_CLOUD_PORT, logs the handler's log lines to
// <state>.cloud and exits when its parent closes stdin. The test secret is TEST_SECRET.
import fs from 'node:fs';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createHandler} from '../Cloud/handler.mjs';
import {answerFor, photoIdOf} from './mock-answers.mjs';

export const TEST_SECRET = 'test-secret-for-tonepilot-cloud-0123456789';
export const SERVER_MODEL = 'anthropic.claude-opus-5-5';

// Same contract as the DynamoDB store in lambda.mjs: the check and the increment are one
// step, taken after a yield so concurrent requests really interleave.
export function memoryUsage() {
  const rows = new Map();
  return {rows,
    async reserve({licenseId, day, photos, cap}) {
      await new Promise(setImmediate);
      const row = rows.get(licenseId + '#' + day) || {photos: 0, calls: 0, inputTokens: 0, outputTokens: 0};
      if (row.photos + photos > cap) return false;
      rows.set(licenseId + '#' + day, {...row, photos: row.photos + photos});
      return true;
    },
    async record({licenseId, day, inputTokens, outputTokens}) {
      const row = rows.get(licenseId + '#' + day);
      Object.assign(row, {calls: row.calls + 1, inputTokens: row.inputTokens + inputTokens, outputTokens: row.outputTokens + outputTokens});
    }};
}

// The fake model behind the handler: answers from the mock state, like mock-claude.mjs.
export function mockModel(stateFile) {
  return {name: 'bedrock', model: SERVER_MODEL, async run({jpegs, schema}) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const ids = jpegs.map(photoIdOf);
    fs.appendFileSync(stateFile + '.calls', jpegs.length + '\n');
    if (ids.some(id => (state.aiFail || []).includes(id))) throw new Error('model unavailable');
    return {raw: answerFor(state, ids, !!schema.properties.photos),
      stats: {ms: 5, inputTokens: 2500 * jpegs.length + 1500, outputTokens: 150 * jpegs.length}};
  }};
}

// Node request → API Gateway HTTP API (payload 2.0) event → Node response.
export function serve(handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const r = await handler({rawPath: req.url, headers: req.headers, body, isBase64Encoded: false,
        requestContext: {http: {method: req.method, path: req.url}}});
      res.writeHead(r.statusCode, r.headers);
      res.end(r.body);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const STATE = process.env.TONEPILOT_MOCK_STATE;
  const handler = createHandler({getSecret: async () => TEST_SECRET, usage: memoryUsage(), model: mockModel(STATE),
    dailyCap: Number(process.env.TONEPILOT_MOCK_CLOUD_CAP || 1000), log: line => fs.appendFileSync(STATE + '.cloud', JSON.stringify(line) + '\n')});
  const server = serve(handler).listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.TONEPILOT_MOCK_CLOUD_PORT, String(server.address().port)));
  process.stdin.on('end', () => process.exit(0)).resume();
}
