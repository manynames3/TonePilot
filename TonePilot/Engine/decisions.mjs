// OpenAI Decisions API provider (POST /v1/decisions, gpt-6-luna): the preview and the photo
// facts go in, typed answers come back — a choice with a probability for every option, a
// yes/no probability, or a score on ordered levels. They are turned into the same raw
// assessment the other providers return, so normalizeAssessment and the decision logic are
// unchanged. No free-form slider values: exposure comes from TonePilot's face measurement,
// and tone sliders are not proposed. Global fetch only, no dependencies.
import {SKIN_VERDICTS, SUBJECT_EXPOSURE, INTENTS, ILLUMINANTS} from './ai.mjs';

export const DECISIONS_MODEL = 'gpt-6-luna';
const LOCAL = ['127.0.0.1', 'localhost', '[::1]'];

// White-balance shift levels in the photo's own units (see the prompt's unit lines).
const LEVELS = {
  kelvin: {temperature: [-600, -400, -200, 0, 200, 400, 600], tint: [-10, -6, -3, 0, 3, 6, 10]},
  relative: {temperature: [-15, -9, -4, 0, 4, 9, 15], tint: [-10, -6, -3, 0, 3, 6, 10]}
};
const CAST_OF = {'too-warm': 'too-warm', 'too-cool': 'too-cool', 'too-green': 'green', 'too-magenta': 'magenta', correct: 'none', 'no-skin': 'no-skin'};
const choice = (name, instructions, values) => ({type: 'choice', name, instructions, choices: values.map(value => ({value}))});
const scale = (name, instructions, values, unit) => ({type: 'score', name, instructions,
  levels: values.map(v => ({label: (v > 0 ? '+' : '') + v + unit}))});

export function decisionQuestions(wbMode) {
  const levels = LEVELS[wbMode === 'relative' ? 'relative' : 'kelvin'], unit = wbMode === 'relative' ? '' : ' K';
  return [
    choice('skin', 'Is the skin colour of the main people natural for them under this light? If not, how is it off?', SKIN_VERDICTS),
    choice('exposure', 'Is the main subject (faces first) exposed correctly?', SUBJECT_EXPOSURE),
    choice('intent', 'Is the look deliberate (low-key, high-key, silhouette, creative colour)? none if not.', INTENTS),
    choice('light', 'What light falls on the subject?', ILLUMINANTS),
    {type: 'predicate', name: 'mixed', instructions: 'More than one light colour falls on the subject\'s skin.'},
    {type: 'predicate', name: 'backlit', instructions: 'The subject is backlit.'},
    scale('temperature', 'White-balance temperature change that would make the skin look natural (+ warmer). 0 if natural.', levels.temperature, unit),
    scale('tint', 'White-balance tint change that would make the skin look natural (+ more magenta, − more green). 0 if natural.', levels.tint, '')
  ];
}

// A score is the probability-weighted level index; read it back in the level values.
const levelValue = (score, values) => {
  const i = Math.max(0, Math.min(values.length - 1, score)), lo = Math.floor(i), hi = Math.ceil(i);
  return Math.round(values[lo] + (values[hi] - values[lo]) * (i - lo));
};

export function toAssessment(answers, wbMode) {
  const by = Object.fromEntries((answers || []).map(a => [a.name, a]));
  const refused = Object.values(by).find(a => a.type === 'refusal');
  if (refused || !by.skin?.choice || !by.exposure?.choice) throw new Error('AI declined to assess this photo');
  const levels = LEVELS[wbMode === 'relative' ? 'relative' : 'kelvin'];
  const verdict = by.skin.choice, pct = a => Math.round((a.confidence ?? 0) * 100) + '%';
  const shift = (a, values) => (verdict === 'correct' || verdict === 'no-skin' || verdict === 'mixed-light' || typeof a?.score !== 'number' ? 0 : levelValue(a.score, values));
  return {
    skip: false,
    // The two judgments every decision rests on; the weaker one sets the photo's confidence.
    confidence: Math.min(by.skin.confidence ?? 0, by.exposure.confidence ?? 0),
    scene: '', illuminant: by.light?.choice || 'unknown', intent: by.intent?.choice || 'none',
    mixedLighting: (by.mixed?.probability ?? 0) >= 0.5, backlit: (by.backlit?.probability ?? 0) >= 0.5,
    skinCast: CAST_OF[verdict] || (verdict.startsWith('too-') ? verdict.split('-and-')[0] : 'unknown'),
    subjectExposure: by.exposure.choice,
    skinTone: {verdict, temperatureShift: shift(by.temperature, levels.temperature), tintShift: shift(by.tint, levels.tint),
      note: 'Skin ' + verdict.replace(/-/g, ' ') + ' (' + pct(by.skin) + ')'},
    changes: [],
    reason: 'Skin ' + verdict.replace(/-/g, ' ') + ' (' + pct(by.skin) + '); subject exposure ' + by.exposure.choice + ' (' + pct(by.exposure) + ').'
  };
}

export function decisionsProvider(env = process.env) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new Error('No OpenAI API key (OPENAI_API_KEY)');
  const base = env.TONEPILOT_AI_BASE_URL || 'https://api.openai.com';
  // The test-only address receives the API key, so it may only point at this machine.
  if (env.TONEPILOT_AI_BASE_URL && !LOCAL.includes(new URL(base).hostname)) throw new Error('TONEPILOT_AI_BASE_URL is only for local tests');
  const url = new URL('v1/decisions', base.replace(/\/*$/, '/'));

  const call = async (body, {timeoutMs, signal}) => {
    let response;
    try {
      response = await fetch(url, {method: 'POST', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
        headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json'}, body: JSON.stringify(body)});
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'AI assessment timed out' : 'AI service unavailable');
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new Error('OpenAI Decisions API ' + response.status + (json?.error?.message ? ': ' + String(json.error.message).slice(0, 160) : ''));
    return json;
  };

  return {name: 'openai', model: DECISIONS_MODEL, call, async run({jpegs, prompt, schema, timeoutMs, signal, wbMode}) {
    // One photo per request: a batch answer can't be expressed as typed questions, so the
    // engine's per-photo fallback handles batches.
    if (jpegs.length !== 1 || schema?.properties?.photos) throw new Error('The Decisions API assesses one photo per call');
    const started = Date.now();
    const json = await call({model: DECISIONS_MODEL, questions: decisionQuestions(wbMode),
      input: [{role: 'user', content: [{type: 'input_text', text: prompt},
        {type: 'input_image', image_url: 'data:image/jpeg;base64,' + jpegs[0].toString('base64')}]}]}, {timeoutMs, signal});
    return {raw: toAssessment(json?.answers, wbMode), stats: {ms: Date.now() - started,
      inputTokens: json?.usage?.input_tokens ?? null, outputTokens: null}};
  }};
}
