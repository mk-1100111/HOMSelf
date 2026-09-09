const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const adminSource=fs.readFileSync(path.join(__dirname,'..','public','admin.js'),'utf8');
const adminView=fs.readFileSync(path.join(__dirname,'..','views','admin.ejs'),'utf8');
const materialsAdminSource=fs.readFileSync(path.join(__dirname,'..','public','materials_admin.js'),'utf8');

 test('admin request UI script parses and keeps manager grouping client-side',()=>{
  assert.doesNotThrow(()=>new vm.Script(adminSource,{filename:'public/admin.js'}));
  assert.match(adminSource,/function managerGroups\(items\)/);
  assert.match(adminSource,/collapsedRequestManagers/);
  assert.match(adminSource,/collapsedApprovalManagers/);
  assert.match(adminSource,/renderRequestTable\(data,currentBatchIds\)/);
  assert.match(adminSource,/renderApprovalSheet\(data\)/);
});

test('request list uses only simplified pending/completed status labels',()=>{
  assert.match(adminSource,/function simpleStatus\(item\)\{return item\.status==='completed'\?'완료':'접수';\}/);
  assert.match(adminSource,/status-simple-completed/);
  assert.match(adminSource,/status-simple-pending/);
});

test('cleanup hides only completed and rejected request rows without changing request state',()=>{
  assert.match(adminSource,/\['completed','cancelled'\]\.includes\(item\.status\)/);
  assert.match(adminSource,/cleanedItemsKey='homself\.admin\.cleaned\.items\.v1'/);
  assert.match(adminSource,/visibleRequestItems\(data\.items\|\|\[\]\)/);
  assert.doesNotMatch(adminSource,/api\('cleanup/);
});

test('completed rejected decision includes rejected batch and HOMS missing result evidence',()=>{
  assert.match(adminSource,/evidence==='rejected_batch_completed'/);
  assert.match(adminSource,/evidence\.startsWith\('HOMS 조회 결과'\)/);
});

test('request list removes repeated manager column and shows detailed material options',()=>{
  assert.match(adminView,/id="cleanup-list"[^>]*>정리<\/button>/);
  assert.doesNotMatch(adminView,/<th>매니저<\/th>/);
  assert.match(adminView,/<th>자재 \/ 옵션<\/th>/);
  assert.match(adminSource,/옵션 · /);
  assert.match(adminSource,/상품코드 /);
  assert.match(adminSource,/불출단위 /);
  assert.match(adminSource,/HOMS명 · /);
});

test('material admin shows kiosk-equivalent available stock badges',()=>{
  assert.doesNotThrow(()=>new vm.Script(materialsAdminSource,{filename:'public/materials_admin.js'}));
  assert.match(materialsAdminSource,/function stockBadge\(item\)/);
  assert.match(materialsAdminSource,/item\.available_stock\.toLocaleString\('ko-KR'\)/);
  assert.match(materialsAdminSource,/manage-stock-badge/);
  assert.match(materialsAdminSource,/키오스크 사용 가능 재고/);
});
