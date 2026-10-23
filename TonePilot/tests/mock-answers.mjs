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
