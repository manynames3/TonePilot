import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateSettings,compareCurrent,assertUntouchedDevelop} from '../Engine/guard.mjs';

const folder=dirname(fileURLToPath(import.meta.url));
const engine=resolve(folder,'../Engine/engine.mjs');
const mockMCP=resolve(folder,'mock-lightroom.mjs');
const mockModel=resolve(folder,'mock-model.mjs');
const runs=resolve(folder,'../../runs');

function setup() {
  const temp=mkdtempSync(join(tmpdir(),'tonepilot-integration-'));
  const state=join(temp,'state.json');
  writeFileSync(state,JSON.stringify({selected:['101'],writes:[],
    photos:{101:{filename:'SAFE_TEST.JPG',settings:{
      whiteBalance:'As Shot',temperature:5200,tint:0,exposure:0,highlights:0,shadows:0,whites:0,blacks:0
    }}}}));
  chmodSync(mockModel,0o755);
  const env={...process.env,TONEPILOT_NPX:process.execPath,
    TONEPILOT_MCP_ARGS:JSON.stringify([mockMCP]),TONEPILOT_MOCK_STATE:state,
    TONEPILOT_CODEX:mockModel};
  const run=(args)=>spawnSync(process.execPath,[engine,...args],{env,encoding:'utf8',timeout:25000});
  const get=()=>JSON.parse(readFileSync(state,'utf8'));
  const events=result=>result.stdout.split('\n').filter(Boolean).map(x=>JSON.parse(x));
  const cleanup=()=>rmSync(temp,{recursive:true,force:true});
  return {state,temp,env,run,get,events,cleanup};
}

test('no out-of-scope photo IDs, disabled settings or excessive changes',()=>{
  const current={Exposure2012:0,Temperature:5200,Tint:0,WhiteBalance:'As Shot'};
  assert.throws(()=>validateSettings(current,{CropAngle:20},{wb:true,exposure:true,tone:true},0.9),/allowlisted/);
  assert.throws(()=>validateSettings(current,{Exposure2012:0.4},{wb:true,exposure:false,tone:true},0.9),/disabled/);
  assert.throws(()=>validateSettings(current,{Exposure2012:3},{wb:true,exposure:true,tone:true},0.9),/excessive/);
  assert.throws(()=>validateSettings(current,{Exposure2012:0.2},{wb:true,exposure:true,tone:true},0.6),/Low-confidence/);
  assert.throws(()=>compareCurrent({Exposure2012:0},{Exposure2012:0.5},['Exposure2012']),/changed/);
});

test('plan is read-only; explicit confirmation permits verified write and restore',()=>{
  const x=setup();
  let sessionDir;
  try{
    const inspect=x.run(['--mode','inspect']);
    assert.equal(inspect.status,0,inspect.stderr+' '+inspect.stdout);
    assert.equal(x.events(inspect)[0].count,1);
    const analyze=x.run(['--mode','analyze','--ids','["101"]','--look','Natural','--strength','Balanced']);
    assert.equal(analyze.status,0,analyze.stderr+' '+analyze.stdout);
    const completed=x.events(analyze).find(e=>e.type==='complete');
    assert.equal(completed.state,'planned');
    sessionDir=completed.path;
    assert.equal(x.get().writes.length,0,'AI analysis must never edit photos');
    let saved=JSON.parse(readFileSync(join(sessionDir,'session.json'),'utf8'));
    assert.equal(saved.photos[0].state,'proposed');
    assert.deepEqual(saved.photos[0].changes,{Exposure2012:0.3});
    const unapproved=x.run(['--mode','apply','--session',sessionDir]);
    assert.notEqual(unapproved.status,0);
    assert.equal(x.get().writes.length,0,'Missing confirmation must not write');
    const apply=x.run(['--mode','apply','--session',sessionDir,'--confirm']);
    assert.equal(apply.status,0,apply.stderr+' '+apply.stdout);
    assert.equal(x.get().photos['101'].settings.exposure,0.3);
    saved=JSON.parse(readFileSync(join(sessionDir,'session.json'),'utf8'));
    assert.equal(saved.state,'applied');
    assert.equal(saved.photos[0].state,'verified');
    const restore=x.run(['--mode','restore','--session',sessionDir,'--confirm']);
    assert.equal(restore.status,0,restore.stderr+' '+restore.stdout);
    assert.equal(x.get().photos['101'].settings.exposure,0);
    saved=JSON.parse(readFileSync(join(sessionDir,'session.json'),'utf8'));
    assert.equal(saved.state,'restored');
  }finally{
    if(sessionDir)rmSync(sessionDir,{recursive:true,force:true});
    x.cleanup();
  }
});

test('changed Lightroom selection prevents applying an approved plan',()=>{
  const x=setup();
  let sessionDir;
  try{
    const analyzed=x.run(['--mode','analyze','--ids','["101"]']);
    assert.equal(analyzed.status,0,analyzed.stderr+' '+analyzed.stdout);
    sessionDir=x.events(analyzed).find(e=>e.type==='complete').path;
    const changed=x.get();
    changed.selected=[];
    writeFileSync(x.state,JSON.stringify(changed));
    const apply=x.run(['--mode','apply','--session',sessionDir,'--confirm']);
    assert.notEqual(apply.status,0,'stale selection must stop');
    assert.equal(x.get().writes.length,0);
  }finally{
    if(sessionDir)rmSync(sessionDir,{recursive:true,force:true});
    x.cleanup();
  }
});

test('manual Develop edits between analysis and apply are respected',()=>{
  const x=setup();
  let dir;
  try{
    const run=x.run(['--mode','analyze','--ids','["101"]']);
    assert.equal(run.status,0,run.stderr+' '+run.stdout);
    dir=x.events(run).find(e=>e.type==='complete').path;
    const state=x.get();state.photos['101'].settings.exposure=0.20;
    writeFileSync(x.state,JSON.stringify(state));
    const result=x.run(['--mode','apply','--session',dir,'--confirm']);
    assert.notEqual(result.status,0);
    assert.equal(x.get().photos['101'].settings.exposure,0.2);
    assert.equal(x.get().writes.length,0);
  }finally{
    if(dir)rmSync(dir,{recursive:true,force:true});
    x.cleanup();
  }
});

test('independent post-write guard detects changes outside requested Lightroom controls',()=>{
  assert.doesNotThrow(()=>assertUntouchedDevelop(
    {exposure:0,contrast:8,hsl:{HueAdjustmentOrange:-2}},
    {exposure:0.2,contrast:8,hsl:{HueAdjustmentOrange:-2}},
    ['Exposure2012']));
  assert.throws(()=>assertUntouchedDevelop(
    {exposure:0,contrast:8},{exposure:0.2,contrast:9},['Exposure2012']),
    /Unexpected Develop change/);
});
