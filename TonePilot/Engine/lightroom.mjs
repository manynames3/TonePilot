import {spawn} from 'node:child_process';

export class LightroomMCP {
  constructor({command=process.env.TONEPILOT_NPX || process.env.HOME+'/.local/bin/npx',
    args=process.env.TONEPILOT_MCP_ARGS?JSON.parse(process.env.TONEPILOT_MCP_ARGS):['-y','@mskalski/lightroom-mcp'],timeout=30000}={}) {
    this.command=command;this.args=args;this.timeout=timeout;this.sequence=0;this.pending=new Map();this.buffer='';this.proc=null;
  }
  async connect() {
    if(this.proc)throw new Error('MCP client already connected');
    const proc=spawn(this.command,this.args,{stdio:['pipe','pipe','pipe'],env:{
      ...process.env,PATH:process.env.HOME+'/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
    }});
    this.proc=proc;
    proc.stdout.on('data',chunk=>{
      this.buffer+=String(chunk);
      let i;
      while((i=this.buffer.indexOf('\n'))!==-1){
        const line=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+1);
        if(!line)continue;
        let msg;try{msg=JSON.parse(line);}catch{continue;}
        const pending=this.pending.get(msg.id);
        if(!pending)continue;
        clearTimeout(pending.timer);this.pending.delete(msg.id);
        if(msg.error)pending.reject(new Error(msg.error.message||JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
    });
    proc.on('error',e=>this.failAll(e));
    proc.on('exit',code=>this.failAll(new Error('Lightroom bridge exited ('+code+')')));
    proc.stderr.on('data',()=>{});
    await this.request('initialize',{
      protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'TonePilot Guarded Engine',version:'0.4.0'}
    });
    this.send({jsonrpc:'2.0',method:'notifications/initialized'});
    return this;
  }
  send(obj) {
    if(!this.proc||this.proc.stdin.destroyed)throw new Error('Lightroom bridge unavailable');
    this.proc.stdin.write(JSON.stringify(obj)+'\n');
  }
  request(method,params={},timeout=this.timeout) {
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);
        reject(new Error('Lightroom '+method+' timed out after '+timeout+'ms'));
      },timeout);
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({jsonrpc:'2.0',id,method,params});}
      catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  async tool(name,args={}) {
    const result=await this.request('tools/call',{name,arguments:args},
      name==='get_photo_preview'?45000:this.timeout);
    if(result?.isError)throw new Error(
      result.content?.filter(x=>x.type==='text').map(x=>x.text).join(' ')||name+' failed');
    const value=result?.structuredContent?.result??result?.structuredContent;
    if(value&&typeof value==='object'&&!Array.isArray(value))return value;
    const content=result?.content||[];
    const message=content.find(x=>x.type==='text')?.text;
    let parsed={};
    if(message){try{parsed=JSON.parse(message);}catch{parsed={message};}}
    const image=content.find(x=>x.type==='image');
    if(image)parsed.image={mime_type:image.mimeType||'image/jpeg',data:image.data};
    return parsed;
  }
  async close(){
    if(!this.proc)return;
    const p=this.proc;this.proc=null;this.failAll(new Error('Bridge closed'));
    p.stdin.end();if(p.exitCode===null)p.kill('SIGTERM');
  }
  failAll(error){
    for(const task of this.pending.values()){clearTimeout(task.timer);task.reject(error);}
    this.pending.clear();
  }
}
export function normalizeSelection(selection){
  if(!Number.isInteger(selection?.count)||selection.count<0)throw new Error('Invalid selection count');
  if(!Array.isArray(selection.photos))throw new Error('Missing selected photo list');
  const photos=selection.photos.map(p=>({id:String(p.id),filename:String(p.filename||'')}));
  if(photos.some(p=>!(/^[0-9]+$/.test(p.id))||!p.filename))throw new Error('Invalid photo ID or filename');
  if(photos.length!==selection.count||new Set(photos.map(x=>x.id)).size!==photos.length)
    throw new Error('Selection incomplete or duplicate photo IDs');
  return photos;
}
export async function requireSameSelection(client,authorized){
  const {count,photos}=await client.tool('get_selected_photos',{limit:Math.max(21,authorized.length+1),offset:0});
  const now=normalizeSelection({count,photos});
  const expected=new Set(authorized.map(String));
  if(now.length!==expected.size||now.some(x=>!expected.has(x.id)))
    throw new Error('Lightroom selection changed. No further writes permitted.');
  return now;
}
