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

// OpenAI Decisions API: typed answers built from the same mock assessment.
function decisions(request, req, reply) {
  const parts = Array.isArray(request.input) ? request.input.flatMap(m => m.content || []) : [];
  const images = parts.filter(p => p.type === 'input_image');
  fs.appendFileSync(STATE + '.claude', JSON.stringify({decisions: true, model: request.model, images: images.length,
    questions: (request.questions || []).map(q => q.name), auth: req.headers.authorization || null}) + '\n');
  if (!images.length) return reply(200, {answers: (request.questions || []).map(q => ({type: 'predicate', name: q.name, probability: 0.97})), usage: {input_tokens: 40}});
  fs.appendFileSync(STATE + '.calls', images.length + '\n');
  const id = photoIdOf(Buffer.from(images[0].image_url.split(',')[1], 'base64'));
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if ((state.aiFail || []).includes(id)) return reply(400, {error: {message: 'model unavailable'}});
  const a = answerFor(state, [id], false), conf = a.confidence;
  const pick = (name, value) => ({type: 'choice', name, choice: value, probabilities: [{value, probability: conf}], confidence: conf});
  const level = n => ({type: 'score', name: n, score: state.decisionScores?.[n] ?? 3, probabilities: [], confidence: conf});
  reply(200, {answers: [pick('skin', a.skinTone?.verdict || 'correct'), pick('exposure', a.subjectExposure), pick('intent', a.intent),
    pick('light', a.illuminant), {type: 'predicate', name: 'mixed', probability: a.mixedLighting ? 0.9 : 0.1},
    {type: 'predicate', name: 'backlit', probability: a.backlit ? 0.9 : 0.1}, level('temperature'), level('tint')],
  usage: {input_tokens: 3100}});
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const reply = (status, obj) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && req.url.endsWith('/v1/decisions')) return decisions(JSON.parse(body), req, reply);
    // The Messages API, or classic Bedrock InvokeModel (model in the path, answer schema as a forced tool).
    const classic = req.url.match(/\/model\/([^/]+)\/invoke$/);
    if (req.method !== 'POST' || !(classic || req.url.endsWith('/v1/messages'))) return reply(404, {type: 'error', error: {type: 'not_found_error', message: req.url}});
    const request = JSON.parse(body);
    if (classic) request.model = decodeURIComponent(classic[1]);
    const content = request.messages?.[0]?.content || [];
    const images = content.filter(b => b.type === 'image');
    const tool = classic && request.tool_choice?.type === 'tool' ? request.tools?.find(t => t.name === request.tool_choice.name) : null;
    const schema = classic ? tool?.input_schema : request.output_config?.format?.schema;
    // Doctor's live check: text only, no schema, a few tokens.
    if (!schema && !images.length) {
      fs.appendFileSync(STATE + '.claude', JSON.stringify({ping: true, model: request.model, maxTokens: request.max_tokens,
        apiKey: req.headers['x-api-key'] || null}) + '\n');
      return reply(200, {id: 'msg_mock', type: 'message', role: 'assistant', model: request.model,
        content: [{type: 'text', text: 'OK'}], stop_reason: 'end_turn', stop_sequence: null, usage: {input_tokens: 12, output_tokens: 2}});
    }
    fs.appendFileSync(STATE + '.claude', JSON.stringify({model: request.model, effort: request.output_config?.effort,
      images: images.length, apiKey: req.headers['x-api-key'] || null, schemaOk: !!schema && !hasUnsupported(schema), classic: !!classic}) + '\n');
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
      content: [classic ? {type: 'tool_use', id: 'toolu_mock', name: tool.name, input: answerFor(state, ids, batch)}
        : {type: 'text', text: JSON.stringify(answerFor(state, ids, batch))}],
      stop_reason: state.claudeRefusal ? 'refusal' : 'end_turn', stop_sequence: null,
      usage: {input_tokens: 2500 * images.length + 1500, output_tokens: 150 * images.length}};
    setTimeout(() => reply(200, message), state.aiDelayMs || 0);
  });
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.env.TONEPILOT_MOCK_CLAUDE_PORT, String(server.address().port)));
process.stdin.on('end', () => process.exit(0)).resume();
