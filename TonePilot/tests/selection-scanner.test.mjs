import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const scanner = resolve(fileURLToPath(new URL('../scan-selection.mjs', import.meta.url)));

function runMock(mode) {
  const folder = mkdtempSync(join(tmpdir(), 'tonepilot-mcp-test-'));
  const mock = join(folder, 'fake-npx');
  const script = `#!/usr/bin/env node
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
 buffer+=chunk;
 let pos;
 while((pos=buffer.indexOf('\\n'))!==-1) {
  const line=buffer.slice(0,pos); buffer=buffer.slice(pos+1);
  if(!line.trim())continue;
  const req=JSON.parse(line);
  if(req.id===1) {
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'stub',version:'1'}}})+'\\n');
  }
  if(req.id===2) {
   if('${mode}'==='error') {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{isError:true,content:[{type:'text',text:'Lightroom plugin not connected'}]}})+'\\n');
   } else {
    const count='${mode}'==='empty'?0:2;
    const photos=count?[{id:'101',filename:'DSC_0101.NEF'},{id:'102',filename:'DSC_0102.NEF'}]:[];
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:JSON.stringify({count,photos})}]}})+'\\n');
   }
  }
 }
});`;
  writeFileSync(mock,script);
  chmodSync(mock,0o755);
  const child=spawnSync(process.execPath,[scanner],{
    env:{...process.env,TONEPILOT_NPX:mock},
    encoding:'utf8',
    timeout:12000
  });
  rmSync(folder,{recursive:true,force:true});
  return child;
}

test('reads an explicit Lightroom selection through MCP without write calls', () => {
  const result=runMock('success');
  assert.equal(result.status,0,result.stderr);
  const payload=JSON.parse(result.stdout.trim());
  assert.equal(payload.count,2);
  assert.deepEqual(payload.photos.map(p=>p.filename),['DSC_0101.NEF','DSC_0102.NEF']);
});

test('represents a confirmed empty selection without manufacturing photos', () => {
  const result=runMock('empty');
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).count,0);
});

test('reports a disconnected Lightroom server instead of claiming success', () => {
  const result=runMock('error');
  assert.equal(result.status,1);
  const payload=JSON.parse(result.stdout.trim());
  assert.match(payload.error,/plugin not connected/);
  assert.equal(payload.photos.length,0);
});
