const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createApp}=require('../app');

test('manual release is shown as 임의불출 but Worker releases to 김무경',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-manual-release-'));
  const catalogPath=path.join(dir,'catalog.json');
  const stockPath=path.join(dir,'stock.json');
  const code='10000060837';
  const catalog={
    managers:['TEST','김무경'],
    manager_settings:{TEST:{visible:true},'김무경':{visible:true}},
    materials:[{material_code:code,material_name:'FTTx 인식표',material_unit:1,visible:true}]
  };
  const syncedAt=Date.now()-5000;
  fs.writeFileSync(catalogPath,JSON.stringify(catalog));
  fs.writeFileSync(stockPath,JSON.stringify({
    version:1,
    generated_at:Date.now(),
    items:[{material_code:code,material_name:'FTTx 인식표',specification:'주황색',stock_quantity:10,synced_at:syncedAt}]
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

  try{
    const createdResponse=await fetch(base+'/api/admin/manual-release',{
      method:'POST',
      headers:adminHeaders,
      body:JSON.stringify({material_code:code,quantity:3,request_key:'manual-release-test-0001'})
    });
    assert.equal(createdResponse.status,201);
    const created=await createdResponse.json();
    assert.equal(created.manager_name,'임의불출');
    assert.equal(created.release_manager_name,'김무경');
    assert.equal(created.quantity,3);

    const stored=store.item(created.item_id);
    assert.equal(stored.status,'approved');
    assert.equal(stored.manager_name,'임의불출');

    const overview=await(await fetch(base+'/api/admin/overview',{headers:adminHeaders})).json();
    const sheetItem=overview.approval_sheet.find(item=>item.id===created.item_id);
    assert.ok(sheetItem);
    assert.equal(sheetItem.manager_name,'임의불출');
    assert.equal(sheetItem.quantity,3);

    const batchStart=await fetch(base+'/api/admin/batch/start',{method:'POST',headers:adminHeaders,body:'{}'});
    assert.equal(batchStart.status,200);

    const preview=await(await fetch(base+'/api/worker/preview',{headers:workerHeaders})).json();
    const previewItem=preview.items.find(item=>item.id===created.item_id);
    assert.ok(previewItem);
    assert.equal(previewItem.manager_name,'김무경');
    assert.equal(previewItem.request_manager_name,'임의불출');

    const claimResponse=await fetch(base+'/api/worker/claim',{method:'POST',headers:workerHeaders,body:'{}'});
    assert.equal(claimResponse.status,200);
    const claimed=(await claimResponse.json()).item;
    assert.equal(claimed.id,created.item_id);
    assert.equal(claimed.manager_name,'김무경');
    assert.equal(claimed.request_manager_name,'임의불출');

    const directWorkerItem=await(await fetch(base+'/api/worker/items/'+created.item_id,{headers:workerHeaders})).json();
    assert.equal(directWorkerItem.manager_name,'김무경');
    assert.equal(directWorkerItem.request_manager_name,'임의불출');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    store.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('manual release rejects quantity beyond real available stock',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-manual-release-limit-'));
  const catalogPath=path.join(dir,'catalog.json');
  const stockPath=path.join(dir,'stock.json');
  const code='10000060837';
  fs.writeFileSync(catalogPath,JSON.stringify({managers:['TEST'],materials:[{material_code:code,material_name:'FTTx 인식표',material_unit:1,visible:true}]}));
  fs.writeFileSync(stockPath,JSON.stringify({version:1,generated_at:Date.now(),items:[{material_code:code,material_name:'FTTx 인식표',specification:'',stock_quantity:2,synced_at:Date.now()-1000}]}));
  const cfg={DB_PATH:path.join(dir,'db.sqlite'),CATALOG_PATH:catalogPath,STOCK_SNAPSHOT_PATH:stockPath,ADMIN_TOKEN:'1234',KIOSK_TOKEN:'5678',WORKER_TOKEN:'w'.repeat(40)};
  const {app,store}=createApp(cfg);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const response=await fetch(base+'/api/admin/manual-release',{
      method:'POST',
      headers:{Authorization:'Bearer '+cfg.ADMIN_TOKEN,'Content-Type':'application/json'},
      body:JSON.stringify({material_code:code,quantity:3,request_key:'manual-release-test-0002'})
    });
    assert.equal(response.status,409);
    const body=await response.json();
    assert.match(body.error,/2개/);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    store.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
