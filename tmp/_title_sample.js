const fs=require('fs');const path=require('path');
const envPath=path.join(__dirname,'..','.env.local');
for (const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){const m=/^([A-Z0-9_]+)=(.*)$/.exec(line.trim());if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');}
const {getPrimaryEvent}=require('../api/mc/gcal-write-lib');
const r=require('../tmp/mc-reconcile-post-push-LATEST.json');
(async()=>{
  const titleOnly=(r.mismatches||[]).filter(m=>m.titleOk===false&&m.startOk&&m.endOk).slice(0,8);
  for(const m of titleOnly){
    try{
      const live=await getPrimaryEvent(m.event_id);
      console.log('---');
      console.log('DB :', m.title);
      console.log('GCAL:', live.summary);
      console.log('same?', live.summary===m.title);
    }catch(e){console.log('err',e.message);}
  }
  const timeish=(r.mismatches||[]).filter(m=>!m.startOk||!m.endOk||m.error);
  console.log('TIME_OR_ERROR_COUNT', timeish.length);
  for(const m of timeish.slice(0,20)){
    console.log(m.kind, (m.title||'').slice(0,45), 'DB', m.db_start, 'GCAL', m.gcal_start||m.error, 't/s/e', m.titleOk, m.startOk, m.endOk);
  }
})();
