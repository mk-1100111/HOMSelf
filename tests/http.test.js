const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../app');

test('rejects invalid admin and kiosk PIN configuration',()=>{
  const base={DB_PATH:path.join(os.tmpdir(),'unused.sqlite'),CATALOG_PATH:path.resolve('config/catalog.example.json'),ADMIN_TOKEN:'1234',KIOSK_TOKEN:'5678',WORKER_TOKEN:'w'.repeat(40)};
  assert.throws(()=>createApp({...base,ADMIN_TOKEN:'abcd'}),/ADMIN_TOKEN/);
  assert.throws(()=>createApp({...base,KIOSK_TOKEN:'12345'}),/KIOSK_TOKEN/);
  assert.throws(()=>createApp({...base,KIOSK_TOKEN:'1234'}),/서로 달라야/);
  assert.throws(()=>createApp({...base,WORKER_TOKEN:'short'}),/WORKER_TOKEN/);
});

test('restores last stock snapshot before Worker starts',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-stock-'));
  const catalogPath=path.join(dir,'catalog.json');
  const stockPath=path.join(dir,'stock.json');
  const catalog={managers:['TEST'],manager_settings:{TEST:{visible:true}},materials:[{material_code:'10000060837',material_name:'FTTx 인식표',display_name:'FTTx 인식표 (주황)',material_unit:1,visible:true}]};
  const syncedAt=Date.now()-1000;
  fs.writeFileSync(catalogPath,JSON.stringify(catalog));
  fs.writeFileSync(stockPath,JSON.stringify({version:1,generated_at:Date.now(),items:[{material_code:'10000060837',material_name:'FTTx 인식표',specification:'주황색',stock_quantity:77,synced_at:syncedAt}]}));
  const cfg={DB_PATH:path.join(dir,'db.sqlite'),CATALOG_PATH:catalogPath,STOCK_SNAPSHOT_PATH:stockPath,ADMIN_TOKEN:'1234',KIOSK_TOKEN:'5678',WORKER_TOKEN:'w'.repeat(40)};
  const {app,store}=createApp(cfg);const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    const response=await fetch(base+'/api/catalog',{headers:{Authorization:'Bearer '+cfg.KIOSK_TOKEN}});
    assert.equal(response.status,200);
    const body=await response.json();
    const item=body.materials.find(x=>x.material_code==='10000060837');
    assert.equal(item.stock_quantity,77);
    assert.equal(item.available_stock,77);
    assert.equal(item.stock_synced_at,syncedAt);
    assert.equal(body.inventory_sync.snapshot_restored,true);

    const adminResponse=await fetch(base+'/api/admin/catalog-management',{headers:{Authorization:'Bearer '+cfg.ADMIN_TOKEN}});
    assert.equal(adminResponse.status,200);
    const adminBody=await adminResponse.json();
    const adminItem=adminBody.materials.find(x=>x.material_code==='10000060837');
    assert.equal(adminItem.stock_quantity,item.stock_quantity);
    assert.equal(adminItem.available_stock,item.available_stock);
    assert.equal(adminItem.stock_synced_at,item.stock_synced_at);
    assert.equal(adminItem.specification,item.specification);
  }finally{await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true});}
});

test('badge always equals synchronized HOMS stock regardless of approvals',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-sync-baseline-'));
  const catalogPath=path.join(dir,'catalog.json');
  const stockPath=path.join(dir,'stock.json');
  const code='10000060837';
  const catalog={managers:['TEST'],manager_settings:{TEST:{visible:true}},materials:[{material_code:code,material_name:'FTTx 인식표',material_unit:1,visible:true}]};
  const syncedAt=Date.now()-5000;
  fs.writeFileSync(catalogPath,JSON.stringify(catalog));
  fs.writeFileSync(stockPath,JSON.stringify({version:1,generated_at:Date.now(),items:[{material_code:code,material_name:'FTTx 인식표',specification:'주황색',stock_quantity:10,synced_at:syncedAt}]}));
  const cfg={DB_PATH:path.join(dir,'db.sqlite'),CATALOG_PATH:catalogPath,STOCK_SNAPSHOT_PATH:stockPath,ADMIN_TOKEN:'1234',KIOSK_TOKEN:'5678',WORKER_TOKEN:'w'.repeat(40)};
  const {app,store}=createApp(cfg);const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
  const adminHeaders={Authorization:'Bearer '+cfg.ADMIN_TOKEN,'Content-Type':'application/json'};
  const workerHeaders={Authorization:'Bearer '+cfg.WORKER_TOKEN,'Content-Type':'application/json'};
  const kioskHeaders=key=>({Authorization:'Bearer '+cfg.KIOSK_TOKEN,'Content-Type':'application/json','Idempotency-Key':key});
  const stock=async()=>{
    const body=await(await fetch(base+'/api/catalog',{headers:{Authorization:'Bearer '+cfg.KIOSK_TOKEN}})).json();
    return body.materials.find(x=>x.material_code===code);
  };
  try{
    await fetch(base+'/api/requests',{method:'POST',headers:kioskHeaders('stock-baseline-test-0001'),body:JSON.stringify({manager_name:'TEST',items:[{material_code:code,quantity:2}]})});
    await fetch(base+'/api/admin/approve-all',{method:'POST',headers:adminHeaders,body:'{}'});
    let exact=await stock();
    assert.equal(exact.stock_quantity,10);
    assert.equal(exact.reserved_stock,0);
    assert.equal(exact.available_stock,10,'승인 여부와 관계없이 뱃지는 마지막 HOMS stock 값과 같다');

    const requested=await(await fetch(base+'/api/admin/inventory-sync',{method:'POST',headers:adminHeaders,body:'{}'})).json();
    assert.equal(requested.status,'requested');
    const synced=await fetch(base+'/api/worker/inventory-sync',{method:'POST',headers:workerHeaders,body:JSON.stringify({request_id:requested.request_id,items:[{material_code:code,material_name:'FTTx 인식표',specification:'주황색',stock_quantity:10}]})});
    assert.equal(synced.status,200);
    exact=await stock();
    assert.equal(exact.stock_quantity,10);
    assert.equal(exact.reserved_stock,0);
    assert.equal(exact.available_stock,10,'동기화 직후 뱃지는 HOMS stockCell 값과 정확히 일치한다');

    const adminBody=await(await fetch(base+'/api/admin/catalog-management',{headers:adminHeaders})).json();
    const adminItem=adminBody.materials.find(x=>x.material_code===code);
    assert.equal(adminItem.available_stock,10,'관리자 자재 화면도 HOMS 동기화값과 일치한다');

    await new Promise(resolve=>setTimeout(resolve,2));
    await fetch(base+'/api/requests',{method:'POST',headers:kioskHeaders('stock-baseline-test-0002'),body:JSON.stringify({manager_name:'TEST',items:[{material_code:code,quantity:1}]})});
    await fetch(base+'/api/admin/approve-all',{method:'POST',headers:adminHeaders,body:'{}'});
    exact=await stock();
    assert.equal(exact.stock_quantity,10);
    assert.equal(exact.available_stock,10,'새 승인이 생겨도 뱃지는 HOMS stock 값에서 차감하지 않는다');
  }finally{await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true});}
});

test('batch completion requests HOMS resync and badge changes only when synced stock changes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-stock-flow-'));
  const catalogPath=path.join(dir,'catalog.json');
  const stockPath=path.join(dir,'stock.json');
  const code='10000060837';
  const catalog={managers:['TEST'],manager_settings:{TEST:{visible:true}},materials:[{material_code:code,material_name:'FTTx 인식표',material_unit:1,visible:true}]};
  const syncedAt=Date.now()-5000;
  fs.writeFileSync(catalogPath,JSON.stringify(catalog));
  fs.writeFileSync(stockPath,JSON.stringify({version:1,generated_at:Date.now(),items:[{material_code:code,material_name:'FTTx 인식표',specification:'주황색',stock_quantity:10,synced_at:syncedAt}]}));
  const cfg={DB_PATH:path.join(dir,'db.sqlite'),CATALOG_PATH:catalogPath,STOCK_SNAPSHOT_PATH:stockPath,ADMIN_TOKEN:'1234',KIOSK_TOKEN:'5678',WORKER_TOKEN:'w'.repeat(40)};
  const {app,store}=createApp(cfg);const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
  const kioskHeaders={Authorization:'Bearer '+cfg.KIOSK_TOKEN,'Content-Type':'application/json','Idempotency-Key':'stock-flow-test-0001'};
  const adminHeaders={Authorization:'Bearer '+cfg.ADMIN_TOKEN,'Content-Type':'application/json'};
  const workerHeaders={Authorization:'Bearer '+cfg.WORKER_TOKEN,'Content-Type':'application/json'};
  const stock=async()=>{
    const body=await(await fetch(base+'/api/catalog',{headers:{Authorization:'Bearer '+cfg.KIOSK_TOKEN}})).json();
    return body.materials.find(x=>x.material_code===code);
  };
  try{
    assert.equal((await stock()).available_stock,10);
    const created=await fetch(base+'/api/requests',{method:'POST',headers:kioskHeaders,body:JSON.stringify({manager_name:'TEST',items:[{material_code:code,quantity:2}]})});
    assert.equal(created.status,201);
    assert.equal((await stock()).available_stock,10,'접수 상태에서도 HOMS stock 값을 그대로 표시한다');

    const approved=await(await fetch(base+'/api/admin/approve-all',{method:'POST',headers:adminHeaders,body:'{}'})).json();
    assert.equal(approved.count,1);
    assert.equal((await stock()).available_stock,10,'승인 후에도 뱃지는 차감하지 않는다');

    await fetch(base+'/api/admin/batch/start',{method:'POST',headers:adminHeaders,body:'{}'});
    const claimed=await(await fetch(base+'/api/worker/claim',{method:'POST',headers:workerHeaders,body:'{}'})).json();
    const item=claimed.item;
    assert.ok(item&&item.attempt_id);
    await fetch(base+`/api/worker/items/${item.id}/begin`,{method:'POST',headers:workerHeaders,body:JSON.stringify({attempt_id:item.attempt_id})});
    const completed=await fetch(base+`/api/worker/items/${item.id}/auto_complete`,{method:'POST',headers:workerHeaders,body:JSON.stringify({attempt_id:item.attempt_id,proof:{source:'homs-history',transaction_id:'stock-flow-tx-1',receiver_id:'TEST',manager_name:'TEST',material_code:code,quantity:2,status:'completed'}})});
    assert.equal(completed.status,200);
    assert.equal((await stock()).available_stock,10,'불출 완료 후 재동기화 전에는 마지막 HOMS stock 값을 유지한다');

    const finished=await(await fetch(base+'/api/worker/batch/finish',{method:'POST',headers:workerHeaders,body:'{}'})).json();
    assert.equal(finished.inventory_sync.status,'requested','일괄 불출 완료 직후 HOMS 재고 동기화를 자동 요청한다');
    const syncResponse=await fetch(base+'/api/worker/inventory-sync',{method:'POST',headers:workerHeaders,body:JSON.stringify({request_id:finished.inventory_sync.request_id,items:[{material_code:code,material_name:'FTTx 인식표',specification:'주황색',stock_quantity:8}]})});
    assert.equal(syncResponse.status,200);
    const finalStock=await stock();
    assert.equal(finalStock.stock_quantity,8);
    assert.equal(finalStock.reserved_stock,0);
    assert.equal(finalStock.available_stock,8,'재동기화된 HOMS stock 값이 8이면 뱃지도 정확히 8이다');
  }finally{await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true});}
});

test('HTTP auth, approval sheet workflow, schema and EJS routes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-http-'));
  const cfg={DB_PATH:path.join(dir,'db.sqlite'),CATALOG_PATH:path.resolve('config/catalog.example.json'),ADMIN_TOKEN:'1234',KIOSK_TOKEN:'5678',WORKER_TOKEN:'w'.repeat(40)};
  const {app,store}=createApp(cfg);const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
  const adminHeaders={Authorization:'Bearer '+cfg.ADMIN_TOKEN,'Content-Type':'application/json'};
  const kioskHeaders={Authorization:'Bearer '+cfg.KIOSK_TOKEN,'Content-Type':'application/json','Idempotency-Key':'http-test-request-0001'};
  try{
    assert.equal((await fetch(base+'/api/admin/overview')).status,401);
    assert.equal((await fetch(base+'/api/admin/overview',{headers:{Authorization:'Bearer '+cfg.WORKER_TOKEN}})).status,401);
    const schema=await(await fetch(base+'/api/admin/database',{headers:adminHeaders})).json();assert.equal(schema.tables.length,6);
    for(const route of ['/main','/material_list?managerName=test','/admin','/healthz'])assert.equal((await fetch(base+route)).status,200);
    const material=await(await fetch(base+'/material_list')).text();assert.ok(!material.includes('writeDataToSheet'));
    const preview=await(await fetch(base+'/api/worker/preview',{headers:{Authorization:'Bearer '+cfg.WORKER_TOKEN}})).json();assert.deepEqual(preview.items,[]);
    const catalogResponse=await fetch(base+'/api/catalog',{headers:{Authorization:'Bearer '+cfg.KIOSK_TOKEN}});assert.equal(catalogResponse.status,200);
    const catalog=await catalogResponse.json();
    const requestBody={manager_name:catalog.managers[0],items:[{material_code:catalog.materials[0].material_code,quantity:catalog.materials[0].material_unit}]};
    const created=await fetch(base+'/api/requests',{method:'POST',headers:kioskHeaders,body:JSON.stringify(requestBody)});assert.equal(created.status,201);
    let overview=await(await fetch(base+'/api/admin/overview',{headers:adminHeaders})).json();assert.equal(overview.pending_waiting,1);assert.equal(overview.approval_sheet.length,0);
    const approved=await(await fetch(base+'/api/admin/approve-all',{method:'POST',headers:adminHeaders,body:'{}'})).json();assert.equal(approved.count,1);
    overview=await(await fetch(base+'/api/admin/overview',{headers:adminHeaders})).json();assert.equal(overview.approval_sheet.length,1);
    const backup=await fetch(base+'/api/admin/backup',{headers:adminHeaders});assert.equal(Buffer.from(await backup.arrayBuffer()).subarray(0,15).toString(),'SQLite format 3');
  } finally {await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true});}
});