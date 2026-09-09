const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Store,catalog}=require('../model/store');
const {exportRuntimeState,restoreRuntimeState}=require('../runtime_state');

function body(){
  return {manager_name:catalog.managers[0],items:[{material_code:catalog.materials[0].material_code,quantity:catalog.materials[0].material_unit}]};
}

test('runtime state restores pending and approved requests',()=>{
  const source=new Store(':memory:');
  source.submit(body(),'runtime-restore-0000000001');
  const second=source.submit(body(),'runtime-restore-0000000002');
  const secondItem=source.items().find(x=>x.request_id===second.request_id);
  source.adminAction(secondItem.id,'approve');
  const state=exportRuntimeState(source);
  source.close();

  const target=new Store(':memory:');
  const result=restoreRuntimeState(target,state);
  assert.equal(result.restored,true);
  assert.equal(result.requests,2);
  assert.equal(result.items,2);
  const statuses=target.items().map(x=>x.status).sort();
  assert.deepEqual(statuses,['approved','pending']);
  assert.equal(target.paused(),true);
  assert.equal(target.batchActive(),false);
  target.close();
});

test('runtime state never resumes an in-flight HOMS item after restart',()=>{
  const source=new Store(':memory:');
  const request=source.submit(body(),'runtime-active-0000000001');
  const item=source.items().find(x=>x.request_id===request.request_id);
  source.adminAction(item.id,'approve');
  source.startBatch();
  const claimed=source.claim();
  assert.equal(source.item(claimed.id).status,'claimed');
  const state=exportRuntimeState(source);
  source.close();

  const target=new Store(':memory:');
  restoreRuntimeState(target,state);
  const restored=target.item(claimed.id);
  assert.equal(restored.status,'needs_review');
  assert.equal(restored.attempt_id,null);
  assert.equal(target.paused(),true);
  assert.equal(target.batchActive(),false);
  const events=target.db.prepare('SELECT event_type,note FROM events WHERE item_id=? ORDER BY id').all(claimed.id);
  assert.ok(events.some(e=>e.event_type==='needs_review'&&e.note==='render_restart_restore'));
  target.close();
});
