const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('admin request UI script parses and keeps manager grouping client-side',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','public','admin.js'),'utf8');
  assert.doesNotThrow(()=>new vm.Script(source,{filename:'public/admin.js'}));
  assert.match(source,/function managerGroups\(items\)/);
  assert.match(source,/collapsedRequestManagers/);
  assert.match(source,/collapsedApprovalManagers/);
  assert.match(source,/renderRequestTable\(data,currentBatchIds\)/);
  assert.match(source,/renderApprovalSheet\(data\)/);
});
