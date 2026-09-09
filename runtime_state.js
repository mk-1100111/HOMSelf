const fs=require('node:fs');
const {RUNTIME_STATE_FILE,writeJsonFile}=require('./github_data');

function rows(db,sql){return db.prepare(sql).all();}

function exportRuntimeState(store){
  return {
    version:1,
    generated_at:Date.now(),
    settings:rows(store.db,'SELECT key,value FROM settings ORDER BY key'),
    requests:rows(store.db,'SELECT id,idempotency_key,payload_hash,manager_name,created_at FROM requests ORDER BY created_at,id'),
    request_items:rows(store.db,'SELECT id,request_id,material_code,material_name,quantity,status,attempt_id,updated_at,evidence FROM request_items ORDER BY updated_at,id'),
    events:rows(store.db,'SELECT id,item_id,event_type,actor,note,created_at FROM events ORDER BY id'),
    homs_receipts:rows(store.db,'SELECT transaction_id,item_id,evidence,verified_at FROM homs_receipts ORDER BY verified_at,transaction_id')
  };
}

function validateRuntimeState(state){
  if(!state||typeof state!=='object'||state.version!==1)throw new Error('runtime state 버전이 잘못됐습니다.');
  for(const key of ['settings','requests','request_items','events','homs_receipts']){
    if(!Array.isArray(state[key]))throw new Error(`runtime state ${key} 형식이 잘못됐습니다.`);
  }
  if(state.request_items.length>1000)throw new Error('runtime state 요청 항목이 1000건을 초과했습니다.');
}

function restoreRuntimeState(store,state){
  validateRuntimeState(state);
  const existing=Number((store.db.prepare('SELECT COUNT(*) AS n FROM requests').get()||{}).n||0);
  if(existing>0)return {restored:false,requests:existing,items:Number((store.db.prepare('SELECT COUNT(*) AS n FROM request_items').get()||{}).n||0)};

  store.tx(()=>{
    store.db.prepare('DELETE FROM events').run();
    store.db.prepare('DELETE FROM homs_receipts').run();
    store.db.prepare('DELETE FROM request_items').run();
    store.db.prepare('DELETE FROM requests').run();

    const putSetting=store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for(const row of state.settings){
      if(!row||typeof row.key!=='string')continue;
      putSetting.run(row.key,String(row.value??''));
    }

    const putRequest=store.db.prepare('INSERT INTO requests(id,idempotency_key,payload_hash,manager_name,created_at) VALUES(?,?,?,?,?)');
    for(const row of state.requests)putRequest.run(row.id,row.idempotency_key,row.payload_hash,row.manager_name,row.created_at);

    const putItem=store.db.prepare('INSERT INTO request_items(id,request_id,material_code,material_name,quantity,status,attempt_id,updated_at,evidence) VALUES(?,?,?,?,?,?,?,?,?)');
    for(const row of state.request_items)putItem.run(row.id,row.request_id,row.material_code,row.material_name,row.quantity,row.status,row.attempt_id??null,row.updated_at,row.evidence||'');

    const putEvent=store.db.prepare('INSERT INTO events(id,item_id,event_type,actor,note,created_at) VALUES(?,?,?,?,?,?)');
    for(const row of state.events)putEvent.run(row.id,row.item_id??null,row.event_type,row.actor,row.note||'',row.created_at);

    const putReceipt=store.db.prepare('INSERT INTO homs_receipts(transaction_id,item_id,evidence,verified_at) VALUES(?,?,?,?)');
    for(const row of state.homs_receipts)putReceipt.run(row.transaction_id,row.item_id,row.evidence,row.verified_at);

    // A Render restart must never resume an in-flight HOMS operation automatically.
    const active=store.db.prepare("SELECT id FROM request_items WHERE status IN ('claimed','submitting')").all();
    const now=Date.now();
    for(const row of active){
      store.db.prepare("UPDATE request_items SET status='needs_review',attempt_id=NULL,updated_at=? WHERE id=?").run(now,row.id);
      store.event(row.id,'needs_review','system','render_restart_restore');
    }
    store.setSetting('paused','1');
    store.setSetting('batch_active','0');
    store.setSetting('batch_items','[]');
    store.pruneItems();
  });

  return {
    restored:true,
    requests:Number((store.db.prepare('SELECT COUNT(*) AS n FROM requests').get()||{}).n||0),
    items:Number((store.db.prepare('SELECT COUNT(*) AS n FROM request_items').get()||{}).n||0)
  };
}

function restoreRuntimeStateFromFile(store,filePath){
  const path=String(filePath||'').trim();
  if(!path||!fs.existsSync(path))return {restored:false,requests:0,items:0};
  return restoreRuntimeState(store,JSON.parse(fs.readFileSync(path,'utf8')));
}

function createRuntimePersistence(store,config){
  let chain=Promise.resolve();
  let lastCommit='';
  const persist=reason=>{
    const job=chain.catch(()=>{}).then(async()=>{
      const state=exportRuntimeState(store);
      const commit=await writeJsonFile(config,RUNTIME_STATE_FILE,state,`Persist HOMSelf runtime state: ${reason}`,{compact:true});
      lastCommit=commit||lastCommit;
      return {persisted:true,commit};
    });
    chain=job.catch(()=>{});
    return job;
  };
  return {persist,get lastCommit(){return lastCommit;}};
}

module.exports={exportRuntimeState,validateRuntimeState,restoreRuntimeState,restoreRuntimeStateFromFile,createRuntimePersistence};
