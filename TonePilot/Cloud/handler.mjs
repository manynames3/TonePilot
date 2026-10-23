// TonePilot Cloud: POST /v1/assess behind an API Gateway HTTP API (payload format 2.0).
// The app sends a prompt and 1–6 JPEG previews with its license. The SERVER picks the model
// and the output schema, so this is not a general Claude proxy: every answer is constrained
// to TonePilot's assessment schema. Zero retention: prompts, images and answers are never
// logged or stored; one log line per request holds only licenseId, image count, tokens, ms
// and status. Dependencies are injected (lambda.mjs wires the AWS ones; tests use fakes).
import {ASSESSMENT_SCHEMA, batchSchema, BATCH_SIZE, normalizeAssessment} from '../Engine/ai.mjs';
import {verifyLicense} from './license.mjs';

export const LIMITS = {promptChars: 24000, images: BATCH_SIZE, imageBytes: 2 * 1024 * 1024};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const reply = (statusCode, body) => ({statusCode, body: JSON.stringify(body),
  headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});

// The request body, or null when it is not {prompt, images} within limits. Other fields
// (a model, a schema, max_tokens…) are ignored: the client cannot choose them.
function parseRequest(event) {
  let body;
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || ''); } catch { return null; }
  const {prompt, images} = body && typeof body === 'object' ? body : {};
  if (typeof prompt !== 'string' || !prompt.length || prompt.length > LIMITS.promptChars) return null;
  if (!Array.isArray(images) || !images.length || images.length > LIMITS.images) return null;
  const jpegs = [];
  for (const b64 of images) {
    if (typeof b64 !== 'string' || b64.length % 4 || b64.length > Math.ceil(LIMITS.imageBytes / 3) * 4 || !BASE64.test(b64)) return null;
    const jpeg = Buffer.from(b64, 'base64');
    if (jpeg.length < 3 || jpeg.length > LIMITS.imageBytes || jpeg[0] !== 0xFF || jpeg[1] !== 0xD8) return null;
    jpegs.push(jpeg);
  }
  return {prompt, jpegs};
}

// What the client gets back: the model's answer re-built from normalizeAssessment, so only
// the schema's fields, with its short text limits, ever leave the server — the endpoint
// can't be used to get free-form text out of the model. Throws when the answer doesn't fit.
function cleanAnswer(raw, n) {
  const one = r => {
    const {proposed, ...a} = normalizeAssessment(r);
    return {...a, changes: Object.entries(proposed).map(([setting, value]) => ({setting, value}))};
  };
  if (n === 1) return one(raw);
  const photos = raw?.photos;
  if (!Array.isArray(photos) || photos.length !== n || new Set(photos.map(p => p?.index)).size !== n
    || photos.some(p => !Number.isInteger(p?.index) || p.index < 1 || p.index > n)) throw new Error('batch answer does not match its images');
  return {photos: photos.map(p => ({index: p.index, ...one(p)}))};
}

// getSecret: async () → license-signing secret. usage: {reserve, record} (atomic per-license,
// per-UTC-day photo counter). model: a provider from claude.mjs ({model, run}).
export function createHandler({getSecret, usage, model, dailyCap, timeoutMs = 25000, now = Date.now,
  log = line => console.log(JSON.stringify(line))}) {
  return async event => {
    const started = now();
    const line = {licenseId: null, images: 0, inputTokens: null, outputTokens: null, ms: 0, status: 0};
    const done = (status, body) => {
      Object.assign(line, {status, ms: now() - started});
      log(line);
      return reply(status, body);
    };
    try {
      if (event.requestContext?.http?.method !== 'POST' || event.rawPath !== '/v1/assess') return done(404, {error: 'not-found'});
      const auth = event.headers?.authorization || '';
      const license = verifyLicense(auth.startsWith('Bearer ') ? auth.slice(7) : '', await getSecret(), Math.floor(now() / 1000));
      if (license.error) return done(401, {error: license.error});
      line.licenseId = license.licenseId;

      const request = parseRequest(event);
      if (!request) return done(400, {error: 'invalid-request'});
      const {prompt, jpegs} = request;
      line.images = jpegs.length;

      // Counted before the model call, atomically against the cap: concurrent requests can't overshoot it.
      const key = {licenseId: license.licenseId, day: new Date(now()).toISOString().slice(0, 10)};
      if (!await usage.reserve({...key, photos: jpegs.length, cap: dailyCap})) return done(429, {error: 'daily-limit'});

      let result, answer;
      try {
        result = await model.run({jpegs, prompt, schema: jpegs.length === 1 ? ASSESSMENT_SCHEMA : batchSchema(jpegs.length), timeoutMs});
        answer = cleanAnswer(result.raw, jpegs.length);
      } catch (e) {
        line.error = String(e?.status || e?.name || 'Error').slice(0, 40);   // the kind of failure, never its text
        return done(502, {error: 'model-unavailable'});
      }
      const {ms, inputTokens = null, outputTokens = null} = result.stats || {};
      Object.assign(line, {inputTokens, outputTokens});
      // Token accounting is best effort: it never costs the photographer an answer already paid for.
      await usage.record({...key, inputTokens: inputTokens || 0, outputTokens: outputTokens || 0}).catch(() => {});
      return done(200, {raw: answer, model: model.model, stats: {ms, inputTokens, outputTokens}});
    } catch {
      return done(500, {error: 'server-error'});
    }
  };
}
