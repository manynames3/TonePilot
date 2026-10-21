#!/usr/bin/env node
// Blind, externally scored benchmark. This cannot fabricate editing quality.
import fs from 'node:fs';
if(process.argv.length!==3){
  console.error('Usage: node evaluate.mjs /path/to/independently-scored-gallery.json');process.exit(2);
}
const raw=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!Array.isArray(raw.photos)||!raw.photos.length)throw new Error('Missing evaluations');
if(!raw.blinded||raw.blinded!==true)throw new Error('Evaluations must document blind scoring');
const methods=['tonepilot','baseline'];
function summarize(name){
  const rows=raw.photos.map(p=>{
    const value=p.scores?.[name];
    if(!value||typeof value.accepted!=='boolean'||typeof value.majorRegression!=='boolean'||
       !Number.isFinite(value.reviewMinutes)||value.reviewMinutes<0)
       throw new Error('Incomplete independent scoring for '+name+' on '+p.id);
    return value;
  });
  const count=rows.length;
  return {method:name,photos:count,
    accepted:rows.filter(p=>p.accepted).length,
    acceptance:rows.filter(p=>p.accepted).length/count,
    majorRegressions:rows.filter(p=>p.majorRegression).length,
    majorRegressionRate:rows.filter(p=>p.majorRegression).length/count,
    reviewMinutes:rows.reduce((a,p)=>a+p.reviewMinutes,0)};
}
const [tonepilot,baseline]=methods.map(summarize);
const saved=baseline.reviewMinutes>0?1-tonepilot.reviewMinutes/baseline.reviewMinutes:null;
const target={
  acceptedRateAtLeast85Percent:tonepilot.acceptance>=0.85,
  majorRegressionsUnder2Percent:tonepilot.majorRegressionRate<0.02,
  reviewTimeSavedAtLeast40Percent:saved!==null&&saved>=0.40,
  beatExistingWorkflow:tonepilot.acceptance>baseline.acceptance
};
const result={evaluations:raw.photos.length,tonepilot,baseline,timeSavedFraction:saved,
  targetGates:target,passedAll:Object.values(target).every(Boolean)};
console.log(JSON.stringify(result,null,2));
if(raw.photos.length<100){
  console.error('Preliminary sample under 100 photos; do not market result as validated.');
  process.exitCode=3;
}
