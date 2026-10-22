#!/usr/bin/env node
// Fake TonePilot Lightroom plug-in: its protocol (a request port and a response port on
// localhost, newline-delimited JSON, the bridge-file token on every request) around the
// shared fake Lightroom in mock-core.mjs. Unlike the MCP mock it outlives engine runs, as
// the real plug-in does; it writes TONEPILOT_BRIDGE_FILE once listening and exits when
// its parent closes stdin.
import fs from 'node:fs';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {callTool, load, save, PLUGIN_WRITABLE} from './mock-core.mjs';

const token = randomBytes(32).toString('hex');
let requests = null, responses = null, enginePid = null;

const send = obj => { if (responses && !responses.destroyed) responses.write(JSON.stringify(obj) + '\n'); };

function handle(req) {
  const {id} = req;
  const io = {reply: result => send({id, result}), fail: message => send({id, error: message}),
    killEngine: () => { if (enginePid) process.kill(enginePid, 'SIGKILL'); },
    dropBridge: () => { requests?.destroy(); responses?.destroy(); }};
  if (req.token !== token) return io.fail('Unauthorized');
  const params = req.params || {};
  switch (req.action) {
    case 'hello':
      enginePid = params.pid;   // lets fault injection kill the engine, as the MCP mock kills its parent
      return io.reply({pluginVersion: '0.1.0', lightroomVersion: 'mock', catalogPath: '/Mock/Catalog.lrcat'});
    case 'writable_keys': return io.reply({keys: PLUGIN_WRITABLE});
    case 'create_snapshot': {
      const data = load();
      if (data.faults?.snapshotUnsupported) return io.reply({supported: false});
      (data.snapshots ||= []).push({id: String(params.photo_id), name: params.name, writesBefore: data.writes.length});
      save(data);
      return io.reply({supported: true, created: true, name: params.name});
    }
    case 'select_photos': {
      const data = load();
      const ids = (params.photo_ids || []).map(String);
      data.selected = ids.filter(x => data.photos[x]);
      (data.selectCalls ||= []).push(ids);
      save(data);
      return io.reply({requested: data.selected.length, selected: data.selected.length, missing: ids.filter(x => !data.photos[x])});
    }
    case 'get_selected_photos': case 'get_photo_metadata': case 'get_photo_preview': case 'set_develop_settings':
      return callTool(req.action, params, io, {writable: PLUGIN_WRITABLE, full: true});
    default: return io.fail('Unknown action: ' + req.action);
  }
}

const requestServer = net.createServer(socket => {
  requests = socket;
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let req; try { req = JSON.parse(line); } catch { continue; }
      handle(req);
    }
  });
});
const responseServer = net.createServer(socket => {
  socket.on('error', () => {});
  const data = load();
  // The real plug-in can drop an engine's first response connection while it rebinds.
  if (data.faults?.dropResponseConnections > 0) {
    data.faults.dropResponseConnections--;
    save(data);
    return socket.destroy();
  }
  responses = socket;
});

const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const [requestPort, responsePort] = [await listen(requestServer), await listen(responseServer)];
const file = process.env.TONEPILOT_BRIDGE_FILE;
fs.writeFileSync(file + '.tmp', JSON.stringify({version: 1, plugin: '0.1.0', requestPort, responsePort, token}), {mode: 0o600});
fs.renameSync(file + '.tmp', file);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
