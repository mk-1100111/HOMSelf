const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Store,catalog}=require('../model/store');
const body={manager_name:catalog.managers[0],items:[{material_code:catalog.materials[0].material_code,quantity:2}]};
function pending(s,key='12345678-1234-1234-1234-123456789abc'){const r=s.submit(body,key);return s.items().find(i=>i.request_id===r.request_id);}
function approved(s){const item=pending(s);s.adminAction(item.id,'approve');s.pause(false);return item;}
test('new database is paused; duplicate payload/key returns same request',()=>{
  const s=new Store(':memory:');assert.equal(s.paused(),true);
  const a=s.submit(body,'12345678-1234-1234');const b=s.submit(body,'12345678-1234-1234');
  assert.equal(a.request_id,b.request_id);assert.equal(s.items().length,1);
  assert.throws(()=>s.submit({...body,items:[{...body.items[0],quantity:3}]},'12345678-1234-1234'));
  s.close();
});
test('invalid manager/quantity/material/empty/duplicates rejected',()=>{
  const s=new Store(':memory:');
  for(const bad of [{...body,manager_name:'unknown'},{...body,items:[]},{...body,items:[{material_code:'bad',quantity:1}]},
    {...body,items:[...body.items,...body.items]},...[-1,0,1.5,100001,'2'].map(quantity=>({...body,items:[{...body.items[0],quantity}]}))])
    assert.throws(()=>s.submit(bad,'12345678-1234-1234'));
  s.close();
});
test('single worker, single-use begin and idempotent completion',()=>{
  const s=new Store(':memory:');approved(s);const i=s.claim();
  assert.throws(()=>s.claim());assert.throws(()=>s.transition(i.id,'wrong','begin'));
  s.transition(i.id,i.attempt_id,'begin');assert.throws(()=>s.transition(i.id,i.attempt_id,'begin'));
  assert.throws(()=>s.transition(i.id,i.attempt_id,'complete','short'));
  s.transition(i.id,i.attempt_id,'complete','HOMS verified record number 123');
  s.transition(i.id,i.attempt_id,'complete','HOMS verified record number 123');
  assert.equal(s.claim(),null);s.close();
});
test('pause quarantines in-flight work and invalidates delayed worker',()=>{
  const s=new Store(':memory:');approved(s);const i=s.claim();s.pause(true);
  assert.equal(s.item(i.id).status,'needs_review');assert.throws(()=>s.transition(i.id,i.attempt_id,'begin'));
  s.adminAction(i.id,'confirm_not_submitted','HOMS checked no release; stopped old PC');
  assert.equal(s.item(i.id).status,'pending');assert.throws(()=>s.transition(i.id,i.attempt_id,'begin'));s.close();
});
test('partial success is not claimed again and ambiguous work blocks queue',()=>{
  const s=new Store(':memory:');approved(s);let i=s.claim();s.transition(i.id,i.attempt_id,'begin');
  s.transition(i.id,i.attempt_id,'complete','HOMS actual release confirmed');
  const next=pending(s,'22345678-1234-1234-1234-123456789abc');s.adminAction(next.id,'approve');
  i=s.claim();assert.equal(i.id,next.id);s.transition(i.id,i.attempt_id,'review');assert.throws(()=>s.claim());s.close();
});
test('restart quarantines work and consistent snapshot is readable',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'homself-test-'));
  const filename=path.join(folder,'db.sqlite');let s=new Store(filename);approved(s);const i=s.claim();
  s.snapshot(path.join(folder,'snapshot.sqlite'));s.close();s=new Store(filename);
  assert.equal(s.paused(),true);assert.equal(s.item(i.id).status,'needs_review');s.close();
  s=new Store(path.join(folder,'snapshot.sqlite'));assert.equal(s.items().length,1);s.close();
  fs.rmSync(folder,{recursive:true});
});
