const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createApp}=require('../app');
test('HTTP auth, role isolation, schema and EJS routes',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'homself-http-'));
  const cfg={DB_PATH:path.join(dir,'db.sqlite'),CATALOG_PATH:path.resolve('config/catalog.example.json'),ADMIN_TOKEN:'a'.repeat(40),KIOSK_TOKEN:'k'.repeat(40),WORKER_TOKEN:'w'.repeat(40)};
  const {app,store}=createApp(cfg);const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(base+'/api/admin/overview')).status,401);
    assert.equal((await fetch(base+'/api/admin/overview',{headers:{Authorization:'Bearer '+cfg.WORKER_TOKEN}})).status,401);
    const schema=await(await fetch(base+'/api/admin/database',{headers:{Authorization:'Bearer '+cfg.ADMIN_TOKEN}})).json();
    assert.equal(schema.tables.length,6);
    for(const route of ['/main','/material_list?managerName=test','/admin','/healthz'])assert.equal((await fetch(base+route)).status,200);
    const material=await(await fetch(base+'/material_list')).text();assert.ok(!material.includes('writeDataToSheet'));
    const preview=await(await fetch(base+'/api/worker/preview',{headers:{Authorization:'Bearer '+cfg.WORKER_TOKEN}})).json();assert.deepEqual(preview.items,[]);
    const backup=await fetch(base+'/api/admin/backup',{headers:{Authorization:'Bearer '+cfg.ADMIN_TOKEN}});
    assert.equal(Buffer.from(await backup.arrayBuffer()).subarray(0,15).toString(),'SQLite format 3');
  } finally {await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(dir,{recursive:true});}
});
