const {createApp:createCoreApp}=require('./app_core');

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
  if(!stack||!stack.length)throw new Error('Express 라우터를 초기화할 수 없습니다.');
  const layer=stack.pop();
  const firstRouteIndex=stack.findIndex(entry=>entry.route);
  if(firstRouteIndex<0)throw new Error('Express API 라우트를 찾을 수 없습니다.');
  stack.splice(firstRouteIndex,0,layer);
}

function createApp(config){
  const result=createCoreApp(config);
  installResponseTweaks(result.app,result.store);
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
