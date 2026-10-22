// Append-only, fsync'd session journal. The journal is the single source of truth
// for a session; session.json and report.md are disposable views rebuilt from it.
//
// Crash model: a record is durable once append() returns. A crash can leave at most
// one torn final line, which readJournal() ignores (and Journal.open() truncates).
// A malformed line anywhere else means the file was damaged and the session must be
// treated as needing manual review rather than guessed at.
import fs from 'node:fs';
import path from 'node:path';

export const JOURNAL_FILE = 'journal.jsonl';
export const JOURNAL_VERSION = 2;

function fsyncDir(dir) {
  try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  catch { /* best effort: not every filesystem allows fsync on a directory */ }
}

export function readJournal(dir) {
  const file = path.join(dir, JOURNAL_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return {records: [], torn: false, corrupt: 'Journal missing', validBytes: 0}; throw e; }
  const records = [];
  let corrupt = null, torn = false, offset = 0, validBytes = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (isLast) { if (line.length) torn = true; break; }   // no trailing newline: torn final append
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) { validBytes = offset; continue; }
    let rec;
    try { rec = JSON.parse(line); } catch { corrupt = 'Unreadable journal record ' + (i + 1); break; }
    if (!rec || typeof rec.type !== 'string' || rec.seq !== records.length + 1) {
      corrupt = 'Out-of-order journal record ' + (i + 1); break;
    }
    records.push(rec);
    validBytes = offset;
  }
  return {records, torn, corrupt, validBytes};
}

export class Journal {
  constructor(dir, fd, seq) { this.dir = dir; this.fd = fd; this.seq = seq; }

  static create(dir, type, data) {
    fs.mkdirSync(dir, {mode: 0o700});
    const fd = fs.openSync(path.join(dir, JOURNAL_FILE), 'wx', 0o600);
    fsyncDir(path.dirname(dir));
    const journal = new Journal(dir, fd, 0);
    journal.append(type, data);
    fsyncDir(dir);
    return journal;
  }

  static open(dir) {
    const {records, torn, corrupt, validBytes} = readJournal(dir);
    if (corrupt) throw new Error('Session journal is damaged (' + corrupt + '); manual review required');
    const file = path.join(dir, JOURNAL_FILE);
    if (torn) fs.truncateSync(file, validBytes);   // drop a half-written final line before appending
    const fd = fs.openSync(file, 'a', 0o600);
    return new Journal(dir, fd, records.length);
  }

  append(type, data = {}) {
    if (this.fd === null) throw new Error('Journal closed');
    const record = {v: JOURNAL_VERSION, seq: this.seq + 1, at: new Date().toISOString(), type, ...data};
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
    fs.fsyncSync(this.fd);
    this.seq = record.seq;
    return record;
  }

  close() { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }
}

export function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
