import fs from 'node:fs';
// The fake model's answers, shared by the fake Codex CLI (mock-model.mjs) and the fake
// Messages API (mock-claude.mjs): the assessment configured in the mock state
// (state.ai[id]) or a default proposal; several images get a batch answer, and
// state.aiBatchMalformed drops its last entry.
export function answerFor(state, ids, batch) {
  const recordFor = id => state.ai?.[id] ?? state.aiDefault ?? {
    skip: false, confidence: 0.96, scene: 'open shade', illuminant: 'open-shade', mixedLighting: false, backlit: false,
    intent: 'none', skinCast: 'none', subjectExposure: 'under',
    changes: [{setting: 'Exposure2012', value: state.photos[id].settings.exposure + 0.3}],
    reason: 'Test fixture: subject slightly underexposed'
  };
  return !batch ? recordFor(ids[0])
    : {photos: ids.map((id, i) => ({index: i + 1, ...recordFor(id)})).slice(0, state.aiBatchMalformed ? -1 : undefined)};
}
// Mock previews are FF D8 + 'MOCKPREVIEW:<photo id>:…'.
export const photoIdOf = bytes => String(bytes).split(':')[1];

// Records any AI or AWS secret a child process could read into <state>.child-secrets
// (TonePilot's helpers — the bridge, the Codex CLI, the analyzer — must see none).
export function recordSecrets(who) {
  const seen = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'TONEPILOT_LICENSE']
    .filter(k => process.env[k]);
  if (seen.length && process.env.TONEPILOT_MOCK_STATE)
    fs.appendFileSync(process.env.TONEPILOT_MOCK_STATE + '.child-secrets', who + ': ' + seen.join(',') + '\n');
}
