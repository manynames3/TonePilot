#!/usr/bin/env node
// Fake Lightroom MCP bridge (JSON-RPC over stdio) around the shared fake Lightroom in
// mock-core.mjs. The engine starts one per run, as it does the real bridge.
import {callTool, FIELDS} from './mock-core.mjs';
import {recordSecrets} from './mock-answers.mjs';

recordSecrets('bridge');

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const respond = (id, result) => out({jsonrpc: '2.0', id, result});
const text = (id, obj) => respond(id, {content: [{type: 'text', text: JSON.stringify(obj)}]});
const error = (id, message) => respond(id, {isError: true, content: [{type: 'text', text: message}]});

// Relative white balance (JPEG/HEIC/TIFF) is only accepted when the "bridge" advertises it.
const RELATIVE_WB = process.env.TONEPILOT_MOCK_NO_RELATIVE_WB !== '1';
const WRITABLE = Object.keys(FIELDS).filter(k => RELATIVE_WB || !k.startsWith('Incremental'));

function handle(msg) {
  const {id} = msg;
  if (msg.method === 'initialize') return respond(id, {protocolVersion: '2025-03-26', serverInfo: {name: 'tonepilot-mock', version: process.env.TONEPILOT_MOCK_BRIDGE_VERSION || '0.24.1'}, capabilities: {}});
  if (msg.method === 'tools/list') {
    return respond(id, {tools: [{name: 'set_develop_settings', inputSchema: {type: 'object', properties: {
      photo_id: {type: 'string'}, settings: {type: 'object', additionalProperties: false,
        properties: Object.fromEntries(WRITABLE.map(k => [k, {type: 'number'}]))}}}}]});
  }
  if (msg.method !== 'tools/call') return error(id, 'Unknown method');
  callTool(msg.params.name, msg.params.arguments || {}, {
    reply: result => {
      if (!result.image) return text(id, result);
      const {image, ...meta} = result;
      respond(id, {content: [{type: 'text', text: JSON.stringify(meta)}, {type: 'image', mimeType: image.mime_type, data: image.data}]});
    },
    fail: message => error(id, message),
    killEngine: () => { process.kill(process.ppid, 'SIGKILL'); process.exit(0); },
    dropBridge: () => process.exit(3)
  }, {writable: WRITABLE});
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
