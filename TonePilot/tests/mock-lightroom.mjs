#!/usr/bin/env node
// Fake Lightroom MCP server for deterministic, no-photo unit tests.
import fs from 'node:fs';
const dbfile=process.env.TONEPILOT_MOCK_STATE;
const parse=()=>JSON.parse(fs.readFileSync(dbfile,'utf8'));
const save=obj=>fs.writeFileSync(dbfile,JSON.stringify(obj));
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  buffer+=chunk;
  let index;
  while((index=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
    if(!line.trim())continue;
    let msg;try{msg=JSON.parse(line);}catch{continue;}
    if(msg.id===undefined)continue;
    const respond=(result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result})+'\n');
    const error=(message)=>respond({isError:true,content:[{type:'text',text:message}]});
    if(msg.method==='initialize'){
      respond({protocolVersion:'2025-03-26',serverInfo:{name:'tonepilot-mock',version:'1'},capabilities:{}});
      continue;
    }
    if(msg.method!=='tools/call'){error('Unknown method');continue;}
    const name=msg.params.name,args=msg.params.arguments||{};
    const data=parse();
    if(name==='get_selected_photos'){
      respond({content:[{type:'text',text:JSON.stringify({
        count:data.selected.length,photos:data.selected.map(id=>({id,filename:data.photos[id].filename}))
      })}]});
    }else if(name==='get_photo_metadata'){
      const photo=data.photos[String(args.photo_id)];
      if(!photo){error('Photo not found');continue;}
      respond({content:[{type:'text',text:JSON.stringify({
        id:args.photo_id,path:'/safe/mock/'+photo.filename,filename:photo.filename,dateTimeOriginal:'2026-10-01',developSettings:photo.settings
      })}]});
    }else if(name==='get_photo_preview'){
      const p=data.photos[String(args.photo_id)];
      if(!p){error('Photo not found');continue;}
      const jpg=Buffer.alloc(200,0x4b).toString('base64');
      respond({content:[
        {type:'text',text:JSON.stringify({photo_id:args.photo_id,width:400,height:300})},
        {type:'image',mimeType:'image/jpeg',data:jpg}
      ]});
    }else if(name==='set_develop_settings'){
      if(!data.selected.includes(String(args.photo_id))){error('Unauthorized photo');continue;}
      const p=data.photos[String(args.photo_id)];
      for(const [key,value] of Object.entries(args.settings)){
        const fields={Exposure2012:'exposure',Tint:'tint',Temperature:'temperature',
          WhiteBalance:'whiteBalance',Highlights2012:'highlights',Shadows2012:'shadows',
          Whites2012:'whites',Blacks2012:'blacks'};
        if(!fields[key]){error('Forbidden setting');break;}
        p.settings[fields[key]]=value;
      }
      data.writes.push({id:String(args.photo_id),settings:args.settings});
      save(data);
      respond({content:[{type:'text',text:JSON.stringify({success:true,photo_id:args.photo_id})}]});
    }else error('Unknown tool '+name);
  }
});
