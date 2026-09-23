const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../app');

test('batch finish requests one full HOMS inventory refresh and zeros missing materials',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-batch-stock-'));
  const catalogPath=path.join(dir,'catalog.json');
  const stockPath=path.join(dir,'stock.json');
  const codeA='10000000001';
  const codeB='10000000002';
  const catalog={
    managers:['TEST'],
    manager_settings:{TEST:{visible:true}},
    materials:[
      {material_code:codeA,material_name:'A 자재',material_unit:1,visible:true},
      {material_code:codeB,material_name:'B 자재',material_unit:1,visible:true}
    ]
  };
  fs.writeFileSync(catalogPath,JSON.stringify(catalog));
  fs.writeFileSync(stockPath,JSON.stringify({
    version:1,
    generated_at:Date.now(),
    items:[
      {material_code:codeA,material_name:'A 자재',specification:'',stock_quantity:10,synced_at:Date.now()-1000},
      {material_code:codeB,material_name:'B 자재',specification:'',stock_quantity:20,synced_at:Date.now()-1000}
    ]
  }));

  const cfg={
    DB_PATH:path.join(dir,'db.sqlite'),
    CATALOG_PATH:catalogPath,
    STOCK_SNAPSHOT_PATH:stockPath,
    ADMIN_TOKEN:'1234',
    KIOSK_TOKEN:'5678',
    WORKER_TOKEN:'w'.repeat(40)
  };
  const {app,store}=createApp(cfg);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const adminHeaders={Authorization:'Bearer '+cfg.ADMIN_TOKEN,'Content-Type':'application/json'};
  const workerHeaders={Authorization:'Bearer '+cfg.WORKER_TOKEN,'Content-Type':'application/json'};
  const kioskHeaders={Authorization:'Bearer '+cfg.KIOSK_TOKEN,'Content-Type':'application/json','Idempotency-Key':'batch-stock-test-0001'};

  try{
    let response=await fetch(base+'/api/requests',{
      method:'POST',headers:kioskHeaders,
      body:JSON.stringify({manager_name:'TEST',items:[
        {material_code:codeA,quantity:1},
        {material_code:codeB,quantity:1}
      ]})
    });
    assert.equal(response.status,201);
    await fetch(base+'/api/admin/approve-all',{method:'POST',headers:adminHeaders,body:'{}'});
    await fetch(base+'/api/admin/batch/start',{method:'POST',headers:adminHeaders,body:'{}'});

    let claimed=await(await fetch(base+'/api/worker/claim',{method:'POST',headers:workerHeaders,body:'{}'})).json();
    const releasedCode=claimed.item.material_code;
    await fetch(base+`/api/worker/items/${claimed.item.id}/begin`,{
      method:'POST',headers:workerHeaders,body:JSON.stringify({attempt_id:claimed.item.attempt_id})
    });
    response=await fetch(base+`/api/worker/items/${claimed.item.id}/complete`,{
      method:'POST',headers:workerHeaders,
      body:JSON.stringify({attempt_id:claimed.item.attempt_id,note:'HOMS UI 실제 불출 완료 확인'})
    });
    assert.equal(response.status,200);

    claimed=await(await fetch(base+'/api/worker/claim',{method:'POST',headers:workerHeaders,body:'{}'})).json();
    const skippedCode=claimed.item.material_code;
    assert.notEqual(skippedCode,releasedCode);
    response=await fetch(base+`/api/worker/items/${claimed.item.id}/skip_missing_result`,{
      method:'POST',headers:workerHeaders,
      body:JSON.stringify({attempt_id:claimed.item.attempt_id,note:'HOMS 조회 결과 없음 - 미불출 스킵'})
    });
    assert.equal(response.status,200);

    const finished=await(await fetch(base+'/api/worker/batch/finish',{
      method:'POST',headers:workerHeaders,body:'{}'
    })).json();
    assert.equal(finished.inventory_sync.status,'requested');
    assert.equal(finished.inventory_sync.scope,'full');
    assert.deepEqual(finished.inventory_sync.material_codes,[]);

    const preview=await(await fetch(base+'/api/worker/preview',{headers:workerHeaders})).json();
    assert.equal(preview.inventory_sync.scope,'full');
    assert.deepEqual(preview.inventory_sync.material_codes,[]);

    response=await fetch(base+'/api/worker/inventory-sync',{
      method:'POST',headers:workerHeaders,
      body:JSON.stringify({request_id:finished.inventory_sync.request_id,items:[
        {material_code:codeA,material_name:'A 자재',specification:'',stock_quantity:7}
      ]})
    });
    assert.equal(response.status,200);
    const syncBody=await response.json();
    assert.equal(syncBody.count,2);

    const kiosk=await(await fetch(base+'/api/catalog',{headers:{Authorization:'Bearer '+cfg.KIOSK_TOKEN}})).json();
    const itemA=kiosk.materials.find(item=>item.material_code===codeA);
    const itemB=kiosk.materials.find(item=>item.material_code===codeB);
    assert.equal(itemA.stock_quantity,7);
    assert.equal(itemA.available_stock,7);
    assert.equal(itemB.stock_quantity,0);
    assert.equal(itemB.available_stock,0);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    store.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});


test('empty batch sync stays empty while empty full sync zeros all catalog materials',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-empty-batch-sync-'));
  const catalogPath=path.join(dir,'catalog.json');
  fs.writeFileSync(catalogPath,JSON.stringify({
    managers:['TEST'],
    materials:[{material_code:'10000000001',material_name:'A 자재',material_unit:1,visible:true}]
  }));
  const cfg={
    DB_PATH:path.join(dir,'db.sqlite'),
    CATALOG_PATH:catalogPath,
    ADMIN_TOKEN:'1234',
    KIOSK_TOKEN:'5678',
    WORKER_TOKEN:'w'.repeat(40)
  };
  const {app,store}=createApp(cfg);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const workerHeaders={Authorization:'Bearer '+cfg.WORKER_TOKEN,'Content-Type':'application/json'};

  try{
    store.setSetting('inventory_sync_status','requested');
    store.setSetting('inventory_sync_request_id','empty-batch-request');
    store.setSetting('inventory_sync_scope','batch');
    store.setSetting('inventory_sync_material_codes','[]');

    let response=await fetch(base+'/api/worker/inventory-sync',{
      method:'POST',headers:workerHeaders,
      body:JSON.stringify({request_id:'empty-batch-request',items:[]})
    });
    assert.equal(response.status,200);
    let body=await response.json();
    assert.equal(body.status,'completed');
    assert.equal(body.count,0);

    store.setSetting('inventory_sync_status','requested');
    store.setSetting('inventory_sync_request_id','empty-full-request');
    store.setSetting('inventory_sync_scope','full');
    store.setSetting('inventory_sync_material_codes','[]');

    response=await fetch(base+'/api/worker/inventory-sync',{
      method:'POST',headers:workerHeaders,
      body:JSON.stringify({request_id:'empty-full-request',items:[]})
    });
    assert.equal(response.status,200);
    body=await response.json();
    assert.equal(body.status,'completed');
    assert.equal(body.count,1);

    const stock=store.db.prepare('SELECT stock_quantity FROM material_stock WHERE material_code=?').get('10000000001');
    assert.equal(stock.stock_quantity,0);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    store.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});