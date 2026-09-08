const crypto=require('node:crypto');

function installCatalogAdmin({app,auth,catalog,store}){
  const serverBootId=crypto.randomUUID();
  const originalPreview=store.preview.bind(store);
  store.preview=()=>({...originalPreview(),server_boot_id:serverBootId});

  const ensure=()=>{
    if(!catalog.manager_settings || typeof catalog.manager_settings!=='object' || Array.isArray(catalog.manager_settings)) catalog.manager_settings={};
    for(const name of catalog.managers||[]) if(!catalog.manager_settings[name]) catalog.manager_settings[name]={visible:true};
    for(const item of catalog.materials||[]) if(item.visible===undefined) item.visible=true;
  };
  ensure();

  const staticCatalog=()=>({
    managers:[...(catalog.managers||[])],
    manager_settings:JSON.parse(JSON.stringify(catalog.manager_settings||{})),
    materials:(catalog.materials||[]).map(item=>({
      material_code:item.material_code,
      material_name:item.material_name,
      material_unit:item.material_unit,
      specification:item.specification||'',
      visible:item.visible!==false,
      ...(item.image_data?{image_data:item.image_data}:{})
    }))
  });

  const validateImage=value=>{
    if(value===null || value==='') return null;
    if(typeof value!=='string' || value.length>800000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)){
      const error=new Error('이미지는 JPEG/PNG/WebP 형식이며 압축 후 800KB 이하여야 합니다.');error.status=400;throw error;
    }
    return value;
  };
  const markPending=()=>{
    const revision=crypto.randomUUID();
    store.setSetting('catalog_persist_revision',revision);
    store.setSetting('catalog_persist_pending','1');
    store.setSetting('catalog_persist_requested_at',Date.now());
    return revision;
  };
  const pendingState=()=>({
    pending:store.setting('catalog_persist_pending')==='1',
    revision:store.setting('catalog_persist_revision')||'',
    requested_at:Number(store.setting('catalog_persist_requested_at')||0),
    completed_at:Number(store.setting('catalog_persist_completed_at')||0)
  });

  const imageSyncState=()=>({
    status:store.setting('material_image_sync_status')||'idle',
    request_id:store.setting('material_image_sync_request_id')||'',
    requested_at:Number(store.setting('material_image_sync_requested_at')||0),
    started_at:Number(store.setting('material_image_sync_started_at')||0),
    completed_at:Number(store.setting('material_image_sync_completed_at')||0),
    updated:Number(store.setting('material_image_sync_updated')||0),
    skipped:Number(store.setting('material_image_sync_skipped')||0),
    error:store.setting('material_image_sync_error')||''
  });
  const requestImageSync=()=>{
    const current=imageSyncState();
    if(current.status==='requested'||current.status==='running'){
      const e=new Error('이미지 동기화가 이미 진행 중입니다.');e.status=409;throw e;
    }
    const requestId=crypto.randomUUID();
    store.setSetting('material_image_sync_status','requested');
    store.setSetting('material_image_sync_request_id',requestId);
    store.setSetting('material_image_sync_requested_at',Date.now());
    store.setSetting('material_image_sync_started_at','0');
    store.setSetting('material_image_sync_completed_at','0');
    store.setSetting('material_image_sync_updated','0');
    store.setSetting('material_image_sync_skipped','0');
    store.setSetting('material_image_sync_error','');
    return imageSyncState();
  };

  app.get('/api/admin/catalog-management',auth('ADMIN'),(req,res)=>{
    ensure();
    res.json({
      managers:(catalog.managers||[]).map(name=>({name,...(catalog.manager_settings[name]||{visible:true}),visible:(catalog.manager_settings[name]||{}).visible!==false})),
      materials:(catalog.materials||[]).map(item=>({...item,visible:item.visible!==false})),
      persistence:pendingState(),
      image_sync:imageSyncState()
    });
  });

  app.post('/api/admin/catalog-management',auth('ADMIN'),(req,res)=>{
    ensure();
    const type=req.body&&req.body.type;
    const key=String(req.body&&req.body.key||'').trim();
    const patch=req.body&&req.body.patch||{};
    if(type==='manager'){
      if(!(catalog.managers||[]).includes(key)){const e=new Error('매니저를 찾을 수 없습니다.');e.status=404;throw e;}
      const target=catalog.manager_settings[key]||(catalog.manager_settings[key]={visible:true});
      if('visible' in patch){if(typeof patch.visible!=='boolean'){const e=new Error('노출값이 잘못됐습니다.');e.status=400;throw e;}target.visible=patch.visible;}
      if('image_data' in patch){const image=validateImage(patch.image_data);if(image)target.image_data=image;else delete target.image_data;}
    }else if(type==='material'){
      const target=(catalog.materials||[]).find(item=>item.material_code===key);
      if(!target){const e=new Error('부자재를 찾을 수 없습니다.');e.status=404;throw e;}
      if('visible' in patch){if(typeof patch.visible!=='boolean'){const e=new Error('노출값이 잘못됐습니다.');e.status=400;throw e;}target.visible=patch.visible;}
      if('material_unit' in patch){const unit=Number(patch.material_unit);if(!Number.isSafeInteger(unit)||unit<1||unit>100000){const e=new Error('불출단위는 1~100000 정수여야 합니다.');e.status=400;throw e;}target.material_unit=unit;}
      if('image_data' in patch){const image=validateImage(patch.image_data);if(image)target.image_data=image;else delete target.image_data;}
    }else{const e=new Error('관리 대상이 잘못됐습니다.');e.status=400;throw e;}
    const revision=markPending();
    res.json({ok:true,revision,persistence:pendingState()});
  });

  app.post('/api/admin/material-image-sync',auth('ADMIN'),(req,res)=>res.json(requestImageSync()));

  app.get('/api/worker/material-image-sync',auth('WORKER'),(req,res)=>res.json({...imageSyncState(),materials:staticCatalog().materials.filter(item=>!item.image_data)}));
  app.post('/api/worker/material-image-sync/start',auth('WORKER'),(req,res)=>{
    const requestId=String(req.body&&req.body.request_id||'');
    const state=imageSyncState();
    if(state.status!=='requested'||state.request_id!==requestId){const e=new Error('이미지 동기화 요청이 변경됐습니다.');e.status=409;throw e;}
    store.setSetting('material_image_sync_status','running');store.setSetting('material_image_sync_started_at',Date.now());res.json(imageSyncState());
  });
  app.post('/api/worker/material-image-sync/complete',auth('WORKER'),(req,res)=>{
    const requestId=String(req.body&&req.body.request_id||'');
    const state=imageSyncState();
    if(state.request_id!==requestId){const e=new Error('이미지 동기화 요청이 변경됐습니다.');e.status=409;throw e;}
    store.setSetting('material_image_sync_status','completed');store.setSetting('material_image_sync_completed_at',Date.now());store.setSetting('material_image_sync_updated',Number(req.body&&req.body.updated||0));store.setSetting('material_image_sync_skipped',Number(req.body&&req.body.skipped||0));store.setSetting('material_image_sync_error','');res.json(imageSyncState());
  });
  app.post('/api/worker/material-image-sync/fail',auth('WORKER'),(req,res)=>{
    const requestId=String(req.body&&req.body.request_id||'');
    const state=imageSyncState();
    if(state.request_id!==requestId){const e=new Error('이미지 동기화 요청이 변경됐습니다.');e.status=409;throw e;}
    store.setSetting('material_image_sync_status','failed');store.setSetting('material_image_sync_completed_at',Date.now());store.setSetting('material_image_sync_error',String(req.body&&req.body.error||'이미지 동기화 실패').slice(0,300));res.json(imageSyncState());
  });

  app.get('/api/worker/catalog-persist',auth('WORKER'),(req,res)=>{
    const state=pendingState();
    res.json({...state,catalog:state.pending?staticCatalog():null});
  });
  app.post('/api/worker/catalog-persist/complete',auth('WORKER'),(req,res)=>{
    const revision=String(req.body&&req.body.revision||'');
    if(store.setting('catalog_persist_revision')!==revision){const e=new Error('catalog 저장 요청이 이미 변경됐습니다.');e.status=409;throw e;}
    store.setSetting('catalog_persist_pending','0');
    store.setSetting('catalog_persist_completed_at',Date.now());
    res.json({ok:true,...pendingState()});
  });

  app.post('/api/worker/catalog-sync',auth('WORKER'),(req,res)=>{
    const legacy=req.body&&req.body.materials;
    const incoming=req.body&&req.body.catalog;
    if(!incoming && Array.isArray(legacy)){
      const byCode=new Map(catalog.materials.map(item=>[item.material_code,item]));
      let count=0;
      for(const row of legacy){
        if(!row || typeof row.material_code!=='string' || typeof row.material_name!=='string') continue;
        let target=byCode.get(row.material_code);
        if(!target){target={material_code:row.material_code,material_name:row.material_name,material_unit:1,visible:true};catalog.materials.push(target);byCode.set(row.material_code,target);}
        target.material_name=row.material_name;
        if(Number.isSafeInteger(row.material_unit)&&row.material_unit>0) target.material_unit=row.material_unit;
        if(typeof row.specification==='string') target.specification=row.specification;
        count++;
      }
      ensure();return res.json({ok:true,count});
    }
    if(!incoming || !Array.isArray(incoming.managers) || !Array.isArray(incoming.materials)){const e=new Error('영구 catalog 형식이 잘못됐습니다.');e.status=400;throw e;}
    for(const name of incoming.managers){if(typeof name==='string' && name.trim() && !catalog.managers.includes(name.trim())) catalog.managers.push(name.trim());}
    if(incoming.manager_settings && typeof incoming.manager_settings==='object'){
      for(const [name,value] of Object.entries(incoming.manager_settings)){
        if(!catalog.managers.includes(name) || !value || typeof value!=='object') continue;
        catalog.manager_settings[name]={visible:value.visible!==false,...(typeof value.image_data==='string'&&value.image_data?{image_data:value.image_data}:{})};
      }
    }
    const byCode=new Map(catalog.materials.map(item=>[item.material_code,item]));
    for(const row of incoming.materials){
      if(!row || typeof row.material_code!=='string' || typeof row.material_name!=='string') continue;
      let target=byCode.get(row.material_code);
      if(!target){target={material_code:row.material_code,material_name:row.material_name,material_unit:1,visible:true};catalog.materials.push(target);byCode.set(row.material_code,target);}
      target.material_name=row.material_name;
      if(Number.isSafeInteger(row.material_unit)&&row.material_unit>0) target.material_unit=row.material_unit;
      if(typeof row.specification==='string') target.specification=row.specification;
      target.visible=row.visible!==false;
      if(typeof row.image_data==='string'&&row.image_data) target.image_data=row.image_data; else delete target.image_data;
    }
    ensure();res.json({ok:true,managers:catalog.managers.length,materials:catalog.materials.length});
  });
}

module.exports=installCatalogAdmin;
