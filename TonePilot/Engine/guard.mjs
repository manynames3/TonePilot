export const ALLOW = Object.freeze({
  WhiteBalance:'wb',Temperature:'wb',Tint:'wb',Exposure2012:'exposure',
  Highlights2012:'tone',Shadows2012:'tone',Whites2012:'tone',Blacks2012:'tone'
});
export const FIELD = Object.freeze({
  WhiteBalance:'whiteBalance',Temperature:'temperature',Tint:'tint',
  Exposure2012:'exposure',Highlights2012:'highlights',Shadows2012:'shadows',
  Whites2012:'whites',Blacks2012:'blacks'
});
const RANGE={
  Temperature:[2000,50000,800],
  Tint:[-150,150,12],
  Exposure2012:[-5,5,0.75],
  Highlights2012:[-100,100,25],
  Shadows2012:[-100,100,25],
  Whites2012:[-100,100,25],
  Blacks2012:[-100,100,25]
};
export function validateIDs(ids) {
  if(!Array.isArray(ids)||ids.length<1||ids.length>20)throw new Error('Pilot requires 1–20 IDs');
  const str=ids.map(String);
  if(str.some(x=>!/^[0-9]+$/.test(x))||new Set(str).size!==str.length)
    throw new Error('Invalid or duplicate photo ID');
  return str;
}
export function validateSettings(current,proposed,enabled,confidence) {
  if(!current||typeof current!=='object')throw new Error('Missing Develop baseline');
  if(!proposed||typeof proposed!=='object'||Array.isArray(proposed))throw new Error('Invalid proposed settings');
  if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error('Invalid confidence');
  if(confidence<0.8)throw new Error('Low-confidence recommendation must be flagged, not applied');
  const keys=Object.keys(proposed);
  if(keys.length>8)throw new Error('Too many adjustments');
  const updates={};
  for(const key of keys) {
    if(!Object.hasOwn(ALLOW,key))throw new Error('Setting is not allowlisted: '+key);
    if(!enabled[ALLOW[key]])throw new Error('Adjustment is disabled: '+key);
    const old=current[key], next=proposed[key];
    if(key==='WhiteBalance'){
      if(next!=='Custom')throw new Error('Only Custom WB is allowed when setting WhiteBalance');
      if(!['Custom','As Shot','Auto','Daylight','Cloudy','Shade','Tungsten','Fluorescent','Flash'].includes(old))
        throw new Error('Unknown baseline white balance state');
      updates[key]=next;
      continue;
    }
    if(typeof old!=='number'||!Number.isFinite(old))throw new Error('Baseline setting unavailable: '+key);
    if(typeof next!=='number'||!Number.isFinite(next))throw new Error('Setting must be finite: '+key);
    const [min,max,maxDelta]=RANGE[key];
    if(next<min||next>max||Math.abs(next-old)>maxDelta+0.0001)
      throw new Error('Out-of-range or excessive change: '+key);
    updates[key]=next;
  }
  // Changing white balance mode without temperature/tint is allowed but not valuable:
  if(Object.hasOwn(updates,'WhiteBalance')&&!('Temperature'in updates||'Tint'in updates))
    throw new Error('Changing WB mode without a color adjustment is not permitted');
  return updates;
}
export function developmentView(metadata) {
  if(!metadata?.developSettings||typeof metadata.developSettings!=='object')
    throw new Error('Lightroom did not provide Develop settings');
  const record={};
  for(const [key,name] of Object.entries(FIELD)){
    const x=metadata.developSettings[name];
    if(typeof x==='number'&&Number.isFinite(x)||typeof x==='string')record[key]=x;
  }
  return record;
}
export function compareCurrent(expected,current,keys) {
  for(const key of keys){
    if(!(key in expected)||!(key in current))throw new Error('Develop field unavailable: '+key);
    if(expected[key]!==current[key]&&!(
      typeof expected[key]==='number'&&typeof current[key]==='number'&&
      Math.abs(expected[key]-current[key])<=0.0001
    ))throw new Error('Develop value changed outside TonePilot: '+key);
  }
}
export function baselineRestore(baseline,updates) {
  const keys=Object.keys(updates);
  const restore={};
  for(const key of keys){
    if(!(key in baseline))throw new Error('Missing original value for '+key);
    restore[key]=baseline[key];
  }
  return restore;
}


// Independent post-write check of all Develop controls exposed by Lightroom metadata.
// The SDK may omit some controls; this is not a full catalog-level verification.
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object'){
    return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
      .map(([k,v])=>[k,stable(v)]));
  }
  return value;
}
export function assertUntouchedDevelop(before,after,updatedKeys){
  const allowed=new Set(updatedKeys.map(key=>FIELD[key]));
  if(updatedKeys.includes('Temperature')||updatedKeys.includes('Tint'))allowed.add('whiteBalance');
  for(const key of new Set([...Object.keys(before||{}),...Object.keys(after||{})])){
    if(allowed.has(key))continue;
    if(JSON.stringify(stable(before?.[key]))!==JSON.stringify(stable(after?.[key])))
      throw new Error('Unexpected Develop change outside approved controls: '+key);
  }
}
