// Lightroom clients. TonePilot's own plug-in (tonepilot-bridge.mjs) is used when it is
// running; otherwise the minimal MCP (JSON-RPC over stdio) client below talks to the
// third-party Lightroom Classic bridge (github.com/Automaat/lightroom-mcp). Both expose
// connect / tool / close / serverInfo / writableKeys / kind. Only the engine may write.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {TonePilotBridge, bridgeFile} from './tonepilot-bridge.mjs';

// The bridge version TonePilot was verified against. A floating `npx -y` would run
// whatever npm serves today with write access to the catalog, so the server is either
// bundled inside the app or pinned to this exact version.
export const TESTED_BRIDGE_VERSION = '0.24.1';
export const BRIDGE_PACKAGE = '@mskalski/lightroom-mcp@' + TESTED_BRIDGE_VERSION;

export class BridgeError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }   // kind: tool | timeout | closed
}

function defaultLaunch() {
  const home = process.env.HOME || '';
  if (process.env.TONEPILOT_MCP_ARGS) {
    return {command: process.env.TONEPILOT_NPX || home + '/.local/bin/npx', args: JSON.parse(process.env.TONEPILOT_MCP_ARGS)};
  }
  if (process.env.TONEPILOT_MCP_SERVER) return {command: process.env.TONEPILOT_NODE || process.execPath, args: [process.env.TONEPILOT_MCP_SERVER]};
  return {command: process.env.TONEPILOT_NPX || home + '/.local/bin/npx', args: ['-y', BRIDGE_PACKAGE]};
}

// The third-party bridge needs no AI or AWS credentials, so it never gets them.
const SECRETS = ['ANTHROPIC_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'TONEPILOT_LICENSE'];
const withoutSecrets = env => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRETS.includes(k)));

export class LightroomMCP {
  constructor({timeout = 30000, writeTimeout = Number(process.env.TONEPILOT_WRITE_TIMEOUT_MS) || 40000} = {}) {
    Object.assign(this, defaultLaunch());
    this.timeout = timeout; this.writeTimeout = writeTimeout;
    this.sequence = 0; this.pending = new Map(); this.buffer = ''; this.proc = null;
    this.closed = false; this.stderrTail = ''; this.serverInfo = null; this.writableKeys = null; this.kind = 'mcp';
  }

  async connect() {
    if (this.proc) throw new Error('MCP client already connected');
    const home = process.env.HOME || '';
    const proc = spawn(this.command, this.args, {stdio: ['pipe', 'pipe', 'pipe'],
      env: {...withoutSecrets(process.env), PATH: path.dirname(process.execPath) + ':' + home + '/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}});
    this.proc = proc;
    proc.stdout.on('data', chunk => this.onData(chunk));
    proc.stderr.on('data', chunk => { this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000); });
    proc.on('error', e => this.failAll(new BridgeError('Lightroom bridge failed to start: ' + e.message, 'closed')));
    proc.on('exit', code => { this.closed = true; this.failAll(new BridgeError('Lightroom bridge exited (' + code + ')', 'closed')); });
    const init = await this.request('initialize', {protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: {name: 'TonePilot Engine', version: process.env.TONEPILOT_VERSION || 'dev'}});
    this.serverInfo = init?.serverInfo || null;
    this.send({jsonrpc: '2.0', method: 'notifications/initialized'});
    this.writableKeys = await this.readWritableKeys();
    return this;
  }

  // The Develop keys the bridge's write tool accepts, from its published schema. Null if
  // unknown; callers then treat optional keys (relative white balance) as unwritable.
  async readWritableKeys() {
    try {
      const list = await this.request('tools/list', {});
      const tool = (list?.tools || []).find(t => t.name === 'set_develop_settings');
      const keys = Object.keys(tool?.inputSchema?.properties?.settings?.properties || {});
      return keys.length ? new Set(keys) : null;
    } catch { return null; }
  }

  onData(chunk) {
    this.buffer += String(chunk);
    let i;
    while ((i = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      clearTimeout(pending.timer); this.pending.delete(msg.id);
      if (msg.error) pending.reject(new BridgeError(msg.error.message || JSON.stringify(msg.error), 'tool'));
      else pending.resolve(msg.result);
    }
  }

  send(obj) {
    if (!this.proc || this.closed || this.proc.stdin.destroyed) throw new BridgeError('Lightroom bridge unavailable', 'closed');
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params = {}, timeout = this.timeout) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('Lightroom ' + (params?.name || method) + ' timed out after ' + timeout + 'ms', 'timeout'));
      }, timeout);
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({jsonrpc: '2.0', id, method, params}); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async tool(name, args = {}) {
    const timeout = name === 'get_photo_preview' ? 45000 : name === 'set_develop_settings' ? this.writeTimeout : this.timeout;
    const result = await this.request('tools/call', {name, arguments: args}, timeout);
    if (result?.isError) {
      throw new BridgeError(result.content?.filter(x => x.type === 'text').map(x => x.text).join(' ') || name + ' failed', 'tool');
    }
    const value = result?.structuredContent?.result ?? result?.structuredContent;
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    const content = result?.content || [];
    const message = content.find(x => x.type === 'text')?.text;
    let parsed = {};
    if (message) { try { parsed = JSON.parse(message); } catch { parsed = {message}; } }
    const image = content.find(x => x.type === 'image');
    if (image) parsed.image = {mime_type: image.mimeType || 'image/jpeg', data: image.data};
    return parsed;
  }

  async close() {
    if (!this.proc) return;
    const p = this.proc; this.proc = null; this.failAll(new BridgeError('Bridge closed', 'closed'));
    p.stdin.end(); if (p.exitCode === null) p.kill('SIGTERM');
  }

  failAll(error) {
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
  }
}

// TonePilot's plug-in when its bridge file exists and it answers hello; otherwise the
// MCP bridge, exactly as before.
export async function connectLightroom() {
  if (fs.existsSync(bridgeFile())) {
    const own = new TonePilotBridge();
    try { return await own.connect(); } catch { await own.close(); }
  }
  return new LightroomMCP().connect();
}

export function normalizeSelection(selection) {
  if (!Number.isInteger(selection?.count) || selection.count < 0) throw new Error('Invalid selection count');
  if (!Array.isArray(selection.photos)) throw new Error('Missing selected photo list');
  const photos = selection.photos.map(p => ({id: String(p.id), filename: String(p.filename || ''),
    path: String(p.path || ''), captureTime: String(p.dateTimeOriginal || '')}));
  if (photos.some(p => !(/^[0-9]+$/.test(p.id)) || !p.filename)) throw new Error('Invalid photo ID or filename');
  if (new Set(photos.map(x => x.id)).size !== photos.length) throw new Error('Duplicate photo IDs in selection');
  return photos;
}

// Reads the whole selection (the bridge pages it). Note: Lightroom reports the entire
// filmstrip when nothing is selected, so the UI always shows the filenames being authorized.
export async function readSelection(client, max) {
  const raw = await client.tool('get_selected_photos', {limit: max + 1, offset: 0});
  const photos = normalizeSelection(raw);
  return {count: raw.count, photos, truncated: raw.count > photos.length};
}

export async function requireSameSelection(client, authorized) {
  const {count, photos} = await readSelection(client, Math.max(authorized.length, 1));
  const expected = new Set(authorized.map(String));
  if (count !== expected.size || photos.length !== expected.size || photos.some(x => !expected.has(x.id)))
    throw new BridgeError('Lightroom selection changed. No further writes until the original photos are selected again.', 'selection');
  return photos;
}

// Apply-time selection interlock. Reading the whole selection before every write costs
// n metadata rows per photo, O(n²) per apply (≈250,000 rows at 500 photos). Instead:
// a full check when apply starts, before the last photo and after every `fullEvery`
// photos; in between, one row per photo — the selection count plus one photo sampled at
// a rotating position, which must belong to the authorized set. Any cheap-check mismatch
// escalates to a full check, so a real change stops the run within `fullEvery` photos at
// most (usually sooner). The interlock is a signal of the photographer's intent; what
// prevents writing the wrong photo is the per-photo identity check in engine.mjs.
export class SelectionGuard {
  constructor(client, authorized, {fullEvery = Number(process.env.TONEPILOT_SELECTION_FULL_EVERY) || 25} = {}) {
    this.client = client;
    this.authorized = authorized.map(String);
    this.members = new Set(this.authorized);
    this.fullEvery = Math.max(1, Math.floor(fullEvery));
    this.sinceFull = 0; this.cursor = 0;
    this.reads = {full: 0, sampled: 0};
  }

  async full() {
    this.reads.full++;
    this.sinceFull = 0;
    return requireSameSelection(this.client, this.authorized);
  }

  async beforeWrite({last = false} = {}) {
    if (last || this.sinceFull >= this.fullEvery) return this.full();
    this.reads.sampled++;
    const offset = this.cursor++ % this.members.size;
    const raw = await this.client.tool('get_selected_photos', {limit: 1, offset});
    const sampled = raw?.photos?.[0]?.id;
    if (raw?.count !== this.members.size || sampled === undefined || !this.members.has(String(sampled))) return this.full();
    this.sinceFull++;
  }
}
