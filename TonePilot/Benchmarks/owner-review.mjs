#!/usr/bin/env node
// Owner pilot: the photographer rates TonePilot's result on their own session, photo by
// photo, in Lightroom. It reads the session journal only and never talks to Lightroom.
// One person, not blind: this is a pilot signal, NOT validation (that is evaluate.mjs, G3).
//
//   node owner-review.mjs start <session-dir> --out review.json   create, or resume, the review file
//   node owner-review.mjs rate review.json                         rate unrated photos (saves after every answer)
//   node owner-review.mjs report review.json                       counts per category, worse photos with reasons
//
// review.json holds filenames and your notes: it is written 0600; keep it private.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {loadSession, photoView} from '../Engine/session.mjs';
import {atomicWrite} from '../Engine/journal.mjs';

export const LABEL = 'Owner pilot — not validated';
const ANSWERS = {b: 'better', s: 'same', w: 'worse', n: 'na'};
const VALUES = Object.values(ANSWERS);
const save = (file, review) => { atomicWrite(file, JSON.stringify(review, null, 1) + '\n'); fs.chmodSync(file, 0o600); };
const done = p => p.rating?.note !== undefined;

export function start(dir, out) {
  const session = loadSession(path.resolve(dir));
  if (!session) throw new Error('No session journal in ' + dir);
  const review = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8'))
    : {label: LABEL, session: session.id, sessionDir: path.resolve(dir), createdAt: new Date().toISOString(), photos: []};
  if (review.session !== session.id) throw new Error(out + ' belongs to another session (' + review.session + ')');
  const known = new Map(review.photos.map(p => [p.id, p]));
  review.photos = session.order.map(id => {
    const v = photoView(session.photos[id]);
    const tonepilot = {state: v.state, label: v.stateLabel, reason: v.reason,
      changes: v.changes.map(c => ({setting: c.label, from: c.original, to: c.applied ?? c.proposed}))};
    return {id, filename: v.filename, tonepilot, rating: known.get(id)?.rating ?? null};
  });
  save(out, review);
  return review;
}

function describe(p) {
  const changes = p.tonepilot.changes.length
    ? p.tonepilot.changes.map(c => '  ' + c.setting + ': ' + c.from + ' → ' + c.to).join('\n') : '  (no changes)';
  return '\n' + p.filename + ' — ' + p.tonepilot.label + (p.tonepilot.reason ? ' (' + p.tonepilot.reason + ')' : '') + '\n' + changes;
}

export async function rate(file, input = process.stdin, output = process.stdout) {
  const review = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rl = readline.createInterface({input, terminal: false});
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q, valid) => {
    for (;;) {
      output.write(q);
      const next = await lines.next();
      if (next.done) return undefined;
      const a = next.value.trim().toLowerCase();
      if (!valid) return next.value.trim().slice(0, 200);
      const v = ANSWERS[a] || (VALUES.includes(a) ? a : null);
      if (v) return v;
      output.write('Please answer better, same, worse or na (b/s/w/n).\n');
    }
  };
  try {
    for (const p of review.photos.filter(x => !done(x))) {
      output.write(describe(p) + '\n');
      p.rating ||= {};
      for (const [key, q, valid] of [['exposure', 'Exposure: better/same/worse/na? ', true],
        ['whiteBalance', 'White balance: better/same/worse/na? ', true], ['note', 'Reason (optional, Enter to skip): ', false]]) {
        if (p.rating[key] !== undefined) continue;
        const a = await ask(q, valid);
        if (a === undefined) { output.write('\nSaved. Run rate again to continue.\n'); return review; }
        p.rating[key] = a;
        if (key === 'note') p.rating.at = new Date().toISOString();
        save(file, review);
      }
    }
    output.write('\nAll ' + review.photos.length + ' photos rated.\n');
    return review;
  } finally { rl.close(); }
}

export function report(review) {
  const count = key => Object.fromEntries([...VALUES, 'unrated'].map(v =>
    [v, review.photos.filter(p => (p.rating?.[key] ?? 'unrated') === v).length]));
  const worse = review.photos.filter(p => p.rating?.exposure === 'worse' || p.rating?.whiteBalance === 'worse');
  const row = c => VALUES.map(v => v + ' ' + c[v]).join(', ') + ', unrated ' + c.unrated;
  return [LABEL.toUpperCase() + ': one photographer rating their own session, not blind. Not evidence of quality.',
    'Photos: ' + review.photos.length + ' (rated ' + review.photos.filter(done).length + ')',
    'Exposure:      ' + row(count('exposure')),
    'White balance: ' + row(count('whiteBalance')),
    'Worse (' + worse.length + '):',
    ...worse.map(p => '  ' + p.filename + ' [' + p.tonepilot.label + '] ' +
      ['exposure', 'whiteBalance'].filter(k => p.rating[k] === 'worse').map(k => k === 'exposure' ? k : 'white balance').join(' + ') + (p.rating.note ? ' — ' + p.rating.note : ''))
  ].join('\n');
}

if (import.meta.url === 'file://' + path.resolve(process.argv[1] || '')) {
  const [cmd, a, flag, b] = process.argv.slice(2);
  try {
    if (cmd === 'start' && a && flag === '--out' && b) {
      const r = start(a, path.resolve(b));
      console.log('Review file ' + b + ': ' + r.photos.length + ' photos, ' + r.photos.filter(done).length + ' already rated.');
    } else if (cmd === 'rate' && a) await rate(path.resolve(a));
    else if (cmd === 'report' && a) console.log(report(JSON.parse(fs.readFileSync(a, 'utf8'))));
    else { console.error('Usage: node owner-review.mjs start <session-dir> --out review.json | rate review.json | report review.json'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(1); }
}
