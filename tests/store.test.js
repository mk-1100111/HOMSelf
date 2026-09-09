const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Store,catalog}=require('../model/store');
const body={manager_name:catalog.managers[0],items:[{material_code:catalog.materials[0].material_code,quantity:2}]};
function pending(s,key='12345678-1234-1234-1234-123456789abc'){const r=s.submit(body,key);return s.items().find(i=>i.request_id===r.request_id);}
function approve(s,key){const item=pending(s,key);s.adminAction(item.id,'approve');return item;}
function receipt(item,transaction_id='test-tx-1'){return {source:'homs-history',transaction_id,receiver_id:'test-staff',manager_name:item.manager_name,material_code:item.material_code,quantity:item.quantity,status:'completed'};}

test('approval and rejection buttons toggle and approval sheet mirrors selection',()=>{
  const s=new Store(':memory:');const item=pending(s);
  assert.equal(s.item(item.id).status,'pending');assert.equal(s.approvalSheet().length,0);
  s.adminAction(item.id,'toggle_approve');assert.equal(s.item(item.id).status,'approved');assert.equal(s.approvalSheet().length,1);
  s.adminAction(item.id,'toggle_approve');assert.equal(s.item(item.id).status,'pending');assert.equal(s.approvalSheet().length,0);
  s.adminAction(item.id,'toggle_reject');assert.equal(s.item(item.id).status,'cancelled');assert.equal(s.approvalSheet().length,0);
  s.adminAction(item.id,'toggle_reject');assert.equal(s.item(item.id).status,'pending');
  s.adminAction(item.id,'toggle_reject');s.adminAction(item.id,'toggle_approve');assert.equal(s.item(item.id).status,'approved');
  s.adminAction(item.id,'toggle_reject');assert.equal(s.item(item.id).status,'cancelled');assert.equal(s.approvalSheet().length,0);s.close();
});

test('bulk approval approves pending only and leaves rejected items rejected',()=>{
  const s=new Store(':memory:');const first=pending(s);const second=pending(s,'22345678-1234-1234-1234-123456789abc');const rejected=pending(s,'32345678-1234-1234-1234-123456789abc');
  s.adminAction(rejected.id,'toggle_reject');const result=s.approveAll();
  assert.equal(result.count,2);assert.equal(s.item(first.id).status,'approved');assert.equal(s.item(second.id).status,'approved');assert.equal(s.item(rejected.id).status,'cancelled');
  assert.equal(s.approvalSheet().length,2);assert.equal(s.startBatch().count,2);s.close();
});

test('approved items wait until admin explicitly starts a batch',()=>{
  const s=new Store(':memory:');const item=approve(s);
  assert.equal(s.paused(),true);assert.equal(s.batchActive(),false);
  assert.equal(s.overview().approved_waiting,1);assert.deepEqual(s.preview().items,[]);
  assert.throws(()=>s.claim(),/일괄 불출/);
  const started=s.startBatch();assert.equal(started.count,1);assert.equal(s.batchActive(),true);
  assert.equal(s.preview().items.length,1);assert.equal(s.claim().id,item.id);s.close();
});

test('current batch selection is locked while later approvals remain editable',()=>{
  const s=new Store(':memory:');const first=approve(s);s.startBatch();
  assert.throws(()=>s.adminAction(first.id,'toggle_approve'),/현재 일괄 불출/);
  const later=pending(s,'42345678-1234-1234-1234-123456789abc');s.adminAction(later.id,'toggle_approve');
  assert.equal(s.item(later.id).status,'approved');s.adminAction(later.id,'toggle_approve');assert.equal(s.item(later.id).status,'pending');s.close();
});

test('items approved after batch start are held for the next batch',()=>{
  const s=new Store(':memory:');const first=approve(s);s.startBatch();
  const second=approve(s,'52345678-1234-1234-1234-123456789abc');
  let preview=s.preview();assert.deepEqual(preview.items.map(i=>i.id),[first.id]);
  assert.equal(s.overview().approved_waiting,1);
  const claimed=s.claim();s.transition(claimed.id,claimed.attempt_id,'begin');
  s.transition(claimed.id,claimed.attempt_id,'complete','HOMS UI completion confirmed safely');
  assert.equal(s.approvalSheet().some(i=>i.id===first.id),false);
  assert.equal(s.batchRemaining(),0);s.finishBatch();
  assert.equal(s.paused(),true);assert.equal(s.item(second.id).status,'approved');
  const next=s.startBatch();assert.equal(next.count,1);assert.equal(s.preview().items[0].id,second.id);s.close();
});

test('batch completion pauses again and does not auto-pull later approvals',()=>{
  const s=new Store(':memory:');approve(s);s.startBatch();const item=s.claim();
  s.transition(item.id,item.attempt_id,'begin');s.transition(item.id,item.attempt_id,'complete','HOMS UI completion confirmed safely');
  s.finishBatch();assert.equal(s.paused(),true);assert.equal(s.batchActive(),false);assert.equal(s.preview().items.length,0);
  approve(s,'62345678-1234-1234-1234-123456789abc');assert.equal(s.preview().items.length,0);s.close();
});

test('pause quarantines in-flight work and clears current batch',()=>{
  const s=new Store(':memory:');approve(s);s.startBatch();const item=s.claim();s.pause(true);
  assert.equal(s.item(item.id).status,'needs_review');assert.equal(s.batchActive(),false);assert.equal(s.paused(),true);
  assert.throws(()=>s.transition(item.id,item.attempt_id,'begin'));
  s.adminAction(item.id,'confirm_not_submitted','HOMS checked no release; stopped old PC');
  assert.equal(s.item(item.id).status,'pending');s.close();
});

test('legacy receipt verification remains fail-closed',()=>{
  const s=new Store(':memory:');approve(s);s.startBatch();const item=s.claim();const p=receipt(item);
  assert.throws(()=>s.transition(item.id,item.attempt_id,'auto_complete','',p));
  s.transition(item.id,item.attempt_id,'begin');
  for(const field of ['manager_name','material_code','quantity','status','source','receiver_id']) {
    assert.throws(()=>s.transition(item.id,item.attempt_id,'auto_complete','',{...p,[field]:field==='receiver_id'?'':'wrong'}));
    assert.equal(s.item(item.id).status,'submitting');
  }
  s.transition(item.id,item.attempt_id,'auto_complete','',p);assert.equal(s.item(item.id).status,'completed');s.close();
});

test('restart cancels active batch, quarantines active item, and preserves data',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'homself-test-'));const filename=path.join(folder,'db.sqlite');
  let s=new Store(filename);const item=approve(s);s.startBatch();s.claim();s.snapshot(path.join(folder,'snapshot.sqlite'));s.close();
  s=new Store(filename);assert.equal(s.paused(),true);assert.equal(s.batchActive(),false);assert.equal(s.item(item.id).status,'needs_review');s.close();
  s=new Store(path.join(folder,'snapshot.sqlite'));assert.equal(s.items().length,1);s.close();fs.rmSync(folder,{recursive:true});
});

test('duplicate request key is idempotent and invalid payloads are rejected',()=>{
  const s=new Store(':memory:');const a=s.submit(body,'12345678-1234-1234');const b=s.submit(body,'12345678-1234-1234');
  assert.equal(a.request_id,b.request_id);assert.equal(s.items().length,1);
  assert.throws(()=>s.submit({...body,items:[{...body.items[0],quantity:3}]},'12345678-1234-1234'));
  for(const bad of [{...body,manager_name:'unknown'},{...body,items:[]},{...body,items:[{material_code:'bad',quantity:1}]},
    {...body,items:[...body.items,...body.items]},...[-1,0,1.5,100001,'2'].map(quantity=>({...body,items:[{...body.items[0],quantity}]}))])
    assert.throws(()=>s.submit(bad,'72345678-1234-1234'));
  s.close();
});

test('request history keeps at most 1000 items by pruning one completed or rejected row',()=>{
  const s=new Store(':memory:');const createdIds=[];
  for(let i=0;i<1001;i++){
    const key='retention-'+String(i).padStart(12,'0');
    const item=pending(s,key);createdIds.push(item.id);s.adminAction(item.id,'toggle_reject');
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM request_items').get().n,1000);
  const remaining=new Set(s.items().map(item=>item.id));
  assert.equal(remaining.size,1000);
  assert.equal(createdIds.filter(id=>!remaining.has(id)).length,1);
  s.close();
});