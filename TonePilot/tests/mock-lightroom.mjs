#!/usr/bin/env node
// Fake Lightroom MCP bridge for deterministic, no-photo tests, with fault injection.
// State lives in TONEPILOT_MOCK_STATE so tests can inspect writes and simulate the
// photographer editing in Lightroom between engine runs.
//
// White-balance behaviour mirrors Lightroom: writing Temperature/Tint switches the mode
// to Custom; selecting a mode recomputes Temperature/Tint.
import fs from 'node:fs';

const dbfile = process.env.TONEPILOT_MOCK_STATE;
const load = () => JSON.parse(fs.readFileSync(dbfile, 'utf8'));
const save = obj => fs.writeFileSync(dbfile, JSON.stringify(obj, null, 1));
const FIELDS = {Exposure2012: 'exposure', Tint: 'tint', Temperature: 'temperature', WhiteBalance: 'whiteBalance',
  IncrementalTemperature: 'incrementalTemperature', IncrementalTint: 'incrementalTint',
  Highlights2012: 'highlights', Shadows2012: 'shadows', Whites2012: 'whites', Blacks2012: 'blacks', Contrast2012: 'contrast'};
const PRESET_K = {Daylight: 5500, Cloudy: 6500, Shade: 7500, Tungsten: 2850, Fluorescent: 3800, Flash: 5500};

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const respond = (id, result) => out({jsonrpc: '2.0', id, result});
const text = (id, obj) => respond(id, {content: [{type: 'text', text: JSON.stringify(obj)}]});
const error = (id, message) => respond(id, {isError: true, content: [{type: 'text', text: message}]});

// Relative white balance (JPEG/HEIC/TIFF) is only accepted when the "bridge" advertises it.
const RELATIVE_WB = process.env.TONEPILOT_MOCK_NO_RELATIVE_WB !== '1';
const WRITABLE = Object.keys(FIELDS).filter(k => RELATIVE_WB || !k.startsWith('Incremental'));

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
    if (/^(Incremental)?(Temperature|Tint)$/.test(key) && 'whiteBalance' in s) s.whiteBalance = 'Custom';
  }
  if (faults.sideEffectOnWrite) s[faults.sideEffectOnWrite.field] = faults.sideEffectOnWrite.value;
}

function handle(msg) {
  const {id} = msg;
  if (msg.method === 'initialize') return respond(id, {protocolVersion: '2025-03-26', serverInfo: {name: 'tonepilot-mock', version: process.env.TONEPILOT_MOCK_BRIDGE_VERSION || '0.24.1'}, capabilities: {}});
  if (msg.method === 'tools/list') {
    return respond(id, {tools: [{name: 'set_develop_settings', inputSchema: {type: 'object', properties: {
      photo_id: {type: 'string'}, settings: {type: 'object', additionalProperties: false,
        properties: Object.fromEntries(WRITABLE.map(k => [k, {type: 'number'}]))}}}}]});
  }
  if (msg.method !== 'tools/call') return error(id, 'Unknown method');
  const name = msg.params.name, args = msg.params.arguments || {};
  const data = load();
  const faults = data.faults || {};
  if (name === 'get_selected_photos') {
    const ids = data.selected.slice(args.offset || 0, (args.offset || 0) + (args.limit ?? 100));
    // Lets tests measure how many metadata rows the engine makes Lightroom read.
    (data.selectionCalls ||= []).push({limit: args.limit ?? 100, offset: args.offset || 0, rows: ids.length});
    save(data);
    return text(id, {count: data.selected.length, photos: ids.map(pid => ({id: Number(pid), filename: data.photos[pid].filename,
      path: data.photos[pid].path, dateTimeOriginal: data.photos[pid].dateTimeOriginal}))});
  }
  if (name === 'get_photo_metadata') {
    const p = data.photos[String(args.photo_id)];
    if (!p) return error(id, 'Photo not found: ' + args.photo_id);
    const settings = {...p.settings};
    return text(id, {id: Number(args.photo_id), path: p.path, filename: p.filename, fileFormat: p.fileFormat || 'RAW',
      dateTimeOriginal: p.dateTimeOriginal, cameraModel: p.cameraModel || 'Mock Camera', flash: p.flash || 'Did not fire',
      aperture: p.aperture || 'f / 2.8', shutterSpeed: p.shutterSpeed || '1/250 sec', isoSpeedRating: p.iso || 'ISO 400',
      rating: p.rating || 0, developSettings: settings});
  }
  if (name === 'get_photo_preview') {
    const p = data.photos[String(args.photo_id)];
    if (!p) return error(id, 'Photo not found');
    if ((faults.previewOffline || []).includes(String(args.photo_id))) return error(id, 'Preview failed: original offline');
    const body = Buffer.from('MOCKPREVIEW:' + args.photo_id + ':' + JSON.stringify(p.settings) + ':'.padEnd(200, '.'));
    return respond(id, {content: [{type: 'text', text: JSON.stringify({photo_id: args.photo_id, width: 640, height: 427})},
      {type: 'image', mimeType: 'image/jpeg', data: body.toString('base64')}]});
  }
  if (name === 'set_develop_settings') {
    const pid = String(args.photo_id);
    const p = data.photos[pid];
    if (!p) return error(id, 'Photo not found: ' + pid);
    for (const key of Object.keys(args.settings)) if (!WRITABLE.includes(key)) return error(id, 'Unsupported develop setting key: ' + key);
    data.writeCount = (data.writeCount || 0) + 1;
    const n = data.writeCount;
    const apply = () => { applySettings(p, args.settings, faults); data.writes.push({id: pid, settings: args.settings, n}); };
    if (faults.killBeforeWrite === n) { save(data); process.kill(process.ppid, 'SIGKILL'); return process.exit(0); }
    if (faults.errorOnWrite === n) { save(data); return error(id, 'LrCatalog:withWriteAccessDo: blocked by another write'); }
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
    if (faults.killAfterWrite === n) { process.kill(process.ppid, 'SIGKILL'); return process.exit(0); }
    if (faults.exitAfterWrite === n) return process.exit(3);
    const delay = faults.writeDelayMs || 0;
    return delay ? setTimeout(() => text(id, {success: true, photo_id: pid}), delay) : text(id, {success: true, photo_id: pid});
  }
  return error(id, 'Unknown tool ' + name);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined) continue;
    handle(msg);
  }
});
