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
