// The fake Lightroom behind both mock bridges (mock-lightroom.mjs: MCP over stdio;
// mock-plugin.mjs: TonePilot's plug-in protocol over TCP), with fault injection.
// State lives in TONEPILOT_MOCK_STATE so tests can inspect writes and simulate the
// photographer editing in Lightroom between engine runs.
//
// White-balance behaviour mirrors Lightroom's SDK: writing Temperature/Tint leaves the mode
// label unchanged; selecting a mode recomputes Temperature/Tint.
import fs from 'node:fs';

const dbfile = process.env.TONEPILOT_MOCK_STATE;
export const load = () => JSON.parse(fs.readFileSync(dbfile, 'utf8'));
export const save = obj => fs.writeFileSync(dbfile, JSON.stringify(obj, null, 1));
// Lightroom SDK key -> field in the mock's settings (the bridges' lowerCamel names).
export const FIELDS = {Exposure2012: 'exposure', Tint: 'tint', Temperature: 'temperature', WhiteBalance: 'whiteBalance',
  IncrementalTemperature: 'incrementalTemperature', IncrementalTint: 'incrementalTint',
  Highlights2012: 'highlights', Shadows2012: 'shadows', Whites2012: 'whites', Blacks2012: 'blacks', Contrast2012: 'contrast'};
const SDK_KEYS = {...FIELDS, Clarity2012: 'clarity'};
// TonePilot's plug-in write allowlist (TonePilot.lrplugin/Actions.lua; plugin.test.mjs keeps them equal).
export const PLUGIN_WRITABLE = ['WhiteBalance', 'Temperature', 'Tint', 'IncrementalTemperature', 'IncrementalTint',
  'Exposure2012', 'Highlights2012', 'Shadows2012', 'Whites2012', 'Blacks2012'];
const PRESET_K = {Daylight: 5500, Cloudy: 6500, Shade: 7500, Tungsten: 2850, Fluorescent: 3800, Flash: 5500};

function applySettings(photo, settings, faults) {
  const s = photo.settings;
  const relative = 'incrementalTemperature' in s;
  if ('WhiteBalance' in settings) {
    s.whiteBalance = settings.WhiteBalance;
    if (relative) { if (settings.WhiteBalance === 'As Shot') { s.incrementalTemperature = 0; s.incrementalTint = 0; } }
    else if (settings.WhiteBalance === 'As Shot' || settings.WhiteBalance === 'Auto') { s.temperature = photo.asShot.temperature; s.tint = photo.asShot.tint; }
    else if (PRESET_K[settings.WhiteBalance]) { s.temperature = PRESET_K[settings.WhiteBalance]; s.tint = 0; }
  }
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'WhiteBalance') continue;
    s[FIELDS[key]] = key === 'Exposure2012' && faults.roundExposure ? Math.round(value * 10) / 10 : value;
    // Like real Lightroom (observed Oct 22): a plug-in setting Temperature/Tint does NOT flip
    // the WB mode; only the Develop UI does. The mode changes only when WhiteBalance is written.
  }
  if (faults.sideEffectOnWrite) s[faults.sideEffectOnWrite.field] = faults.sideEffectOnWrite.value;
}

// One bridge call. io: reply(result) | fail(message) | killEngine() | dropBridge(); a call
// that must never be answered calls none of them. writable: keys the write tool accepts.
// full: also report every Develop value under developSettings.full, as TonePilot's plug-in does.
export function callTool(name, args, io, {writable, full = false}) {
  const data = load();
  const faults = data.faults || {};
  if (name === 'get_selected_photos') {
    const ids = data.selected.slice(args.offset || 0, (args.offset || 0) + (args.limit ?? 100));
    // Lets tests measure how many metadata rows the engine makes Lightroom read.
    (data.selectionCalls ||= []).push({limit: args.limit ?? 100, offset: args.offset || 0, rows: ids.length});
    save(data);
    return io.reply({count: data.selected.length, photos: ids.map(pid => ({id: Number(pid), filename: data.photos[pid].filename,
      path: data.photos[pid].path, dateTimeOriginal: data.photos[pid].dateTimeOriginal}))});
  }
  if (name === 'get_photo_metadata') {
    const p = data.photos[String(args.photo_id)];
    if (!p) return io.fail('Photo not found: ' + args.photo_id);
    const settings = {...p.settings};
    if (full) {
      settings.full = {...p.hidden};   // values only TonePilot's plug-in reports (crop, profile…)
      for (const [key, field] of Object.entries(SDK_KEYS)) if (field in p.settings) settings.full[key] = p.settings[field];
    }
    return io.reply({id: Number(args.photo_id), path: p.path, filename: p.filename, fileFormat: p.fileFormat || 'RAW',
      dateTimeOriginal: p.dateTimeOriginal, cameraModel: p.cameraModel || 'Mock Camera', flash: p.flash || 'Did not fire',
      aperture: p.aperture || 'f / 2.8', shutterSpeed: p.shutterSpeed || '1/250 sec', isoSpeedRating: p.iso || 'ISO 400',
      rating: p.rating || 0, developSettings: settings});
  }
  if (name === 'get_photo_preview') {
    const p = data.photos[String(args.photo_id)];
    if (!p) return io.fail('Photo not found');
    if ((faults.previewOffline || []).includes(String(args.photo_id))) return io.fail('[string "HandlerPreview.lua"]:91: Preview failed: error loading thumb');
    const pid = String(args.photo_id), flaky = faults.previewFailFirst?.[pid];
    if (flaky) {   // transient: fail the first N requests for this photo
      data.previewFailures = data.previewFailures || {};
      data.previewFailures[pid] = (data.previewFailures[pid] || 0) + 1;
      save(data);
      if (data.previewFailures[pid] <= flaky) return io.fail('[string "HandlerPreview.lua"]:91: Preview failed: error loading thumb');
    }
    const body = Buffer.from('MOCKPREVIEW:' + args.photo_id + ':' + JSON.stringify(p.settings) + ':'.padEnd(200, '.'));
    return io.reply({photo_id: args.photo_id, width: 640, height: 427, image: {mime_type: 'image/jpeg', data: body.toString('base64')}});
  }
  if (name === 'set_develop_settings') {
    const pid = String(args.photo_id);
    const p = data.photos[pid];
    if (!p) return io.fail('Photo not found: ' + pid);
    for (const key of Object.keys(args.settings)) if (!writable.includes(key)) return io.fail('Unsupported develop setting key: ' + key);
    data.writeCount = (data.writeCount || 0) + 1;
    const n = data.writeCount;
    const apply = () => { applySettings(p, args.settings, faults); data.writes.push({id: pid, settings: args.settings, n, history: args.history}); };
    if (faults.killBeforeWrite === n) { save(data); return io.killEngine(); }
    if (faults.errorOnWrite === n) { save(data); return io.fail('LrCatalog:withWriteAccessDo: blocked by another write'); }
    if (faults.timeoutWrite?.n === n) {
      save(data);
      if (faults.timeoutWrite.applyAfterMs !== null) setTimeout(() => { const later = load(); applySettings(later.photos[pid], args.settings, faults); later.writes.push({id: pid, settings: args.settings, n, late: true}); save(later); }, faults.timeoutWrite.applyAfterMs);
      return;   // never answers
    }
    apply();
    if (faults.changeSelectionAfterWrite === n) data.selected = [];
    if (faults.swapSelectionAfterWrite?.n === n) {   // same count, one photo replaced by an unauthorized one
      const {from, to} = faults.swapSelectionAfterWrite;
      data.selected = data.selected.map(x => (x === from ? to : x));
    }
    save(data);
    if (faults.killAfterWrite === n) return io.killEngine();
    if (faults.exitAfterWrite === n) return io.dropBridge();
    const delay = faults.writeDelayMs || 0;
    const ok = {success: true, photo_id: pid};
    return delay ? setTimeout(() => io.reply(ok), delay) : io.reply(ok);
  }
  return io.fail('Unknown tool ' + name);
}
