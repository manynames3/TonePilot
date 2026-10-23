#!/usr/bin/env node
// Fake Claude Messages API (Anthropic API and Bedrock Mantle share its shape) on a local
// port written to TONEPILOT_MOCK_CLAUDE_PORT. Answers as mock-answers.mjs says (doctor's
// text-only ping gets "OK") and logs
// every request's essentials to <state>.claude, one JSON line each. Exits when its parent
// closes stdin. Faults from the mock state: aiFail (photo ids → HTTP 400), claudeRefusal,
// claudeStatus (every assessment answered with that HTTP status), aiDelayMs.
import fs from 'node:fs';
import http from 'node:http';
import {answerFor, photoIdOf} from './mock-answers.mjs';

const STATE = process.env.TONEPILOT_MOCK_STATE;
const UNSUPPORTED = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'];
const hasUnsupported = s => s && typeof s === 'object' && Object.entries(s).some(([k, v]) => UNSUPPORTED.includes(k) || hasUnsupported(v));

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const reply = (status, obj) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || !req.url.endsWith('/v1/messages')) return reply(404, {type: 'error', error: {type: 'not_found_error', message: req.url}});
    const request = JSON.parse(body);
    const content = request.messages?.[0]?.content || [];
    const images = content.filter(b => b.type === 'image');
    const schema = request.output_config?.format?.schema;
    // Doctor's live check: text only, no schema, a few tokens.
    if (!schema && !images.length) {
      fs.appendFileSync(STATE + '.claude', JSON.stringify({ping: true, model: request.model, maxTokens: request.max_tokens,
        apiKey: req.headers['x-api-key'] || null}) + '\n');
      return reply(200, {id: 'msg_mock', type: 'message', role: 'assistant', model: request.model,
        content: [{type: 'text', text: 'OK'}], stop_reason: 'end_turn', stop_sequence: null, usage: {input_tokens: 12, output_tokens: 2}});
    }
    fs.appendFileSync(STATE + '.claude', JSON.stringify({model: request.model, effort: request.output_config?.effort,
      images: images.length, apiKey: req.headers['x-api-key'] || null, schemaOk: !!schema && !hasUnsupported(schema)}) + '\n');
    fs.appendFileSync(STATE + '.calls', images.length + '\n');
    const batch = images.length > 1;
    if (!schema || hasUnsupported(schema) || batch !== !!schema.properties?.photos)
      return reply(400, {type: 'error', error: {type: 'invalid_request_error', message: 'output_config.format.schema not accepted'}});
    const ids = images.map(b => photoIdOf(Buffer.from(b.source.data, 'base64')));
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (state.claudeStatus) return reply(state.claudeStatus, {type: 'error', error: {type: 'overloaded_error', message: 'busy'}});
    if (ids.some(id => (state.aiFail || []).includes(id)))
      return reply(400, {type: 'error', error: {type: 'invalid_request_error', message: 'model unavailable'}});
    const message = {id: 'msg_mock', type: 'message', role: 'assistant', model: request.model,
      content: [{type: 'text', text: JSON.stringify(answerFor(state, ids, batch))}],
      stop_reason: state.claudeRefusal ? 'refusal' : 'end_turn', stop_sequence: null,
      usage: {input_tokens: 2500 * images.length + 1500, output_tokens: 150 * images.length}};
    setTimeout(() => reply(200, message), state.aiDelayMs || 0);
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.TONEPILOT_MOCK_CLAUDE_PORT, String(server.address().port)));
process.stdin.on('end', () => process.exit(0)).resume();
