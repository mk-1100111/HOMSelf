const crypto=require('node:crypto');
const {createApp:createCoreApp}=require('./app_core');
const {createRuntimePersistence}=require('./runtime_state');

function insertBeforeFirstRoute(app,layer){
  const stack=app._router&&app._router.stack;
  if(!stack||!stack.length)throw new Error('Express 라우터를 초기화할 수 없습니다.');
  const firstRouteIndex=stack.findIndex(entry=>entry.route);
  if(firstRouteIndex<0)throw new Error('Express API 라우트를 찾을 수 없습니다.');
  stack.splice(firstRouteIndex,0,layer);
}

function workerReleaseItem(item){
  if(!item||item.manager_name!=='임의불출')return item;
  return {...item,manager_name:'김무경',request_manager_name:'임의불출'};
}

function installResponseTweaks(app,store){
  const readSyncCodes=()=>{
    try{
      const value=JSON.parse(store.setting('inventory_sync_material_codes')||'[]');
      return Array.isArray(value)?value.filter(code=>typeof code==='string'&&code):[];
    }catch{return [];}
  };
  const writeSyncMeta=(scope,codes=[])=>{
    const normalized=[...new Set((Array.isArray(codes)?codes:[]).filter(code=>typeof code==='string'&&code))];
    store.setSetting('inventory_sync_scope',scope==='batch'?'batch':'full');
    store.setSetting('inventory_sync_material_codes',JSON.stringify(normalized));
    return normalized;
  };
  const releasedBatchCodes=()=>{
    const ids=store.batchItems();
    if(!ids.length)return [];
    const placeholders=ids.map(()=>'?').join(',');
    const rows=store.db.prepare(`SELECT DISTINCT material_code FROM request_items WHERE id IN (${placeholders}) AND status='completed' AND evidence!='rejected_batch_completed' AND evidence NOT LIKE 'HOMS 조회 결과%' ORDER BY material_code`).all(...ids);
    return rows.map(row=>row.material_code);
  };

  const responseTweaks=(req,res,next)=>{
    const batchCodes=req.method==='POST'&&req.path==='/api/worker/batch/finish'?releasedBatchCodes():null;
    const originalJson=res.json.bind(res);
    res.json=body=>{
      if((req.path==='/api/catalog'||req.path==='/api/admin/catalog-management')&&body&&Array.isArray(body.materials)){
        body={...body,materials:body.materials.map(item=>{
          if(!Number.isSafeInteger(item&&item.stock_quantity))return item;
          return {...item,reserved_stock:0,available_stock:item.stock_quantity};
        })};
      }

      if(req.method==='POST'&&req.path==='/api/worker/claim'&&body&&body.item){
        body={...body,item:workerReleaseItem(body.item)};
      }

      if(req.method==='GET'&&/^\/api\/worker\/items\/[^/]+$/.test(req.path)&&body&&body.id){
        body=workerReleaseItem(body);
      }

      if(req.method==='GET'&&req.path==='/api/worker/preview'&&body&&Array.isArray(body.items)){
        body={...body,items:body.items.map(workerReleaseItem)};
      }

      if(req.method==='POST'&&req.path==='/api/admin/inventory-sync'&&res.statusCode<400&&body&&body.status==='requested'){
        writeSyncMeta('full',[]);
        body={...body,scope:'full',material_codes:[]};
      }

      if(req.method==='POST'&&req.path==='/api/worker/batch/finish'&&res.statusCode<400&&body&&body.inventory_sync){
        const codes=writeSyncMeta('batch',batchCodes||[]);
        if(body.inventory_sync.status==='requested'&&codes.length===0){
          const completedAt=Date.now();
          store.setSetting('inventory_sync_status','completed');
          store.setSetting('inventory_sync_completed_at',completedAt);
          store.setSetting('inventory_sync_count','0');
          store.setSetting('inventory_sync_error','');
          body={...body,inventory_sync:{...body.inventory_sync,status:'completed',completed_at:completedAt,count:0,scope:'batch',material_codes:[]}};
        }else{
          body={...body,inventory_sync:{...body.inventory_sync,scope:'batch',material_codes:codes}};
        }
      }

      if(req.method==='GET'&&req.path==='/api/worker/preview'&&body&&body.inventory_sync){
        const scope=store.setting('inventory_sync_scope')==='batch'?'batch':'full';
        body={...body,inventory_sync:{...body.inventory_sync,scope,material_codes:readSyncCodes()}};
      }

      return originalJson(body);
    };
    next();
  };

  app.use(responseTweaks);
  const stack=app._router&&app._router.stack;
  const layer=stack&&stack.pop();
  if(!layer)throw new Error('응답 보정 미들웨어를 설치할 수 없습니다.');
  insertBeforeFirstRoute(app,layer);
}

function installManualReleaseRoute(app,store,config){
  const runtimePersistence=createRuntimePersistence(store,config);
  const digest=value=>crypto.createHash('sha256').update(String(value||'')).digest();
  const authorized=req=>{
    const supplied=String(req.get('authorization')||'').replace(/^Bearer /,'');
    return crypto.timingSafeEqual(digest(supplied),digest(config.ADMIN_TOKEN));
  };

  const route=async(req,res,next)=>{
    try{
      if(!authorized(req))return res.status(401).json({error:'인증키를 확인하세요.'});
      const code=String(req.body&&req.body.material_code||'').trim();
      const quantity=Number(req.body&&req.body.quantity);
      const requestKey=String(req.body&&req.body.request_key||'').trim();
      if(!/^[A-Za-z0-9_-]{1,80}$/.test(code)){const e=new Error('상품코드가 잘못됐습니다.');e.status=400;throw e;}
      if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100000){const e=new Error('임의불출 수량은 1~100000 정수여야 합니다.');e.status=400;throw e;}
      if(!/^[A-Za-z0-9-]{16,80}$/.test(requestKey)){const e=new Error('임의불출 요청번호가 잘못됐습니다.');e.status=400;throw e;}

      const result=store.tx(()=>{
        const prior=store.db.prepare(`SELECT r.id AS request_id,i.id AS item_id,i.material_code,i.quantity FROM requests r JOIN request_items i ON i.request_id=r.id WHERE r.idempotency_key=? LIMIT 1`).get(requestKey);
        if(prior){
          if(prior.material_code!==code||prior.quantity!==quantity){const e=new Error('같은 임의불출 요청번호의 내용이 달라졌습니다.');e.status=409;throw e;}
          return {...prior,manager_name:'임의불출',duplicate:true};
        }

        const material=(store.catalog.materials||[]).find(item=>item.material_code===code);
        if(!material){const e=new Error('부자재를 찾을 수 없습니다.');e.status=404;throw e;}
        const stock=store.db.prepare('SELECT stock_quantity,synced_at FROM material_stock WHERE material_code=?').get(code);
        if(!stock){const e=new Error('재고 동기화 후 임의불출을 등록하세요.');e.status=409;throw e;}

        const active=Number((store.db.prepare(`SELECT COALESCE(SUM(i.quantity),0) AS quantity FROM request_items i JOIN (SELECT item_id,MAX(created_at) AS approved_at FROM events WHERE event_type='approved' GROUP BY item_id) a ON a.item_id=i.id WHERE i.material_code=? AND i.status IN ('approved','claimed','submitting','needs_review') AND a.approved_at>?`).get(code,stock.synced_at)||{}).quantity||0);
        const completed=Number((store.db.prepare(`SELECT COALESCE(SUM(i.quantity),0) AS quantity FROM request_items i JOIN (SELECT item_id,MAX(created_at) AS approved_at FROM events WHERE event_type='approved' GROUP BY item_id) a ON a.item_id=i.id WHERE i.material_code=? AND i.status='completed' AND a.approved_at>? AND i.evidence!='rejected_batch_completed' AND i.evidence NOT LIKE 'HOMS 조회 결과%'`).get(code,stock.synced_at)||{}).quantity||0);
        const available=Math.max(0,Number(stock.stock_quantity)-active-completed);
        if(quantity>available){const e=new Error(`임의불출 가능 재고는 ${available}개입니다.`);e.status=409;throw e;}

        const requestId=crypto.randomUUID();
        const itemId=crypto.randomUUID();
        const now=Date.now();
        const payloadHash=crypto.createHash('sha256').update(JSON.stringify(['임의불출',[{material_code:code,quantity}]])).digest('hex');
        store.db.prepare('INSERT INTO requests(id,idempotency_key,payload_hash,manager_name,created_at) VALUES(?,?,?,?,?)').run(requestId,requestKey,payloadHash,'임의불출',now);
        store.db.prepare(`INSERT INTO request_items(id,request_id,material_code,material_name,quantity,status,attempt_id,updated_at,evidence) VALUES(?,?,?,?,?,'approved',NULL,?,'')`).run(itemId,requestId,code,material.material_name,quantity,now);
        store.event(itemId,'approved','admin','manual_release');
        store.pruneItems();
        return {request_id:requestId,item_id:itemId,material_code:code,material_name:material.material_name,quantity,manager_name:'임의불출',release_manager_name:'김무경',available_before:available,duplicate:false};
      });

      try{
        await runtimePersistence.persist('POST /api/admin/manual-release');
      }catch(error){
        error.status=503;
        error.message='임의불출은 서버에 등록됐지만 영구 저장에 실패했습니다. 관리자 불출 시트에서 중복 여부를 확인하세요.';
        throw error;
      }
      res.status(result.duplicate?200:201).json(result);
    }catch(error){next(error);}
  };

  app.post('/api/admin/manual-release',route);
  const stack=app._router&&app._router.stack;
  const layer=stack&&stack.pop();
  if(!layer)throw new Error('임의불출 라우트를 설치할 수 없습니다.');
  insertBeforeFirstRoute(app,layer);
}

function createApp(config){
  const result=createCoreApp(config);
  installResponseTweaks(result.app,result.store);
  installManualReleaseRoute(result.app,result.store,config);
  return result;
}

module.exports={createApp};

if(require.main===module){
  const {prepareStartupConfig}=require('./bootstrap');
  prepareStartupConfig(process.env).then(config=>{
    const {app,store}=createApp(config);
    const server=app.listen(config.PORT||3000,()=>console.log('HOMSelf 시작: 승인 시트의 항목은 일괄 불출 시작 전까지 대기합니다.'));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{store.close();process.exit(0);}));
  }).catch(error=>{
    console.error('HOMSelf 시작 실패:',error.name||'Error',error.message||String(error));
    process.exit(1);
  });
}