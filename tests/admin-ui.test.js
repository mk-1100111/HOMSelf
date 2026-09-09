const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const adminSource=fs.readFileSync(path.join(__dirname,'..','public','admin.js'),'utf8');
const adminView=fs.readFileSync(path.join(__dirname,'..','views','admin.ejs'),'utf8');
const materialsAdminSource=fs.readFileSync(path.join(__dirname,'..','public','materials_admin.js'),'utf8');
const managersAdminSource=fs.readFileSync(path.join(__dirname,'..','public','managers_admin.js'),'utf8');
const managersAdminView=fs.readFileSync(path.join(__dirname,'..','views','managers_admin.ejs'),'utf8');
const materialsAdminView=fs.readFileSync(path.join(__dirname,'..','views','materials_admin.ejs'),'utf8');
const adminCss=fs.readFileSync(path.join(__dirname,'..','public','admin.css'),'utf8');
const adminManageCss=fs.readFileSync(path.join(__dirname,'..','public','admin_manage.css'),'utf8');
const adminNavCss=fs.readFileSync(path.join(__dirname,'..','public','admin_nav.css'),'utf8');
const adminLoginCss=fs.readFileSync(path.join(__dirname,'..','public','admin_login.css'),'utf8');

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

test('manager and material admin always keep three proportional columns',()=>{
  assert.doesNotThrow(()=>new vm.Script(managersAdminSource,{filename:'public/managers_admin.js'}));
  assert.match(managersAdminView,/class="manage-grid manager-grid"/);
  assert.match(managersAdminSource,/manager-image-wrap/);
  assert.match(managersAdminSource,/manager-card-body/);
  assert.match(adminManageCss,/\.manage-grid,\.manager-grid\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(adminManageCss,/@media\(max-width:650px\)/);
  assert.match(adminManageCss,/\.manage-grid,\.manager-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\);gap:5px\}/);
  assert.match(adminManageCss,/\.manage-image-wrap\{[^}]*aspect-ratio:1\/1/);
  assert.match(adminManageCss,/\.manager-image-wrap\{[^}]*aspect-ratio:1\/1/);
});

test('material admin removes HOMS name explanation labels',()=>{
  assert.doesNotMatch(materialsAdminSource,/HOMS 이름:/);
  assert.doesNotMatch(materialsAdminView,/HOMS 이름/);
  assert.match(materialsAdminSource,/원본 이름 사용/);
});

test('admin navigation stays high and distributes links proportionally',()=>{
  assert.match(adminNavCss,/\.admin-shortcuts\{[^}]*right:22px;top:100px/);
  assert.match(adminNavCss,/@media\(max-width:1100px\)/);
  assert.match(adminNavCss,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(adminNavCss,/grid-template-columns:auto minmax\(0,1fr\) auto!important/);
  assert.match(adminNavCss,/\.topbar-logout\{white-space:nowrap;min-width:max-content\}/);
  assert.match(adminNavCss,/width:calc\(100% - 176px\)/);
});

test('admin typography scales fluidly and keeps critical labels on one line',()=>{
  assert.match(adminCss,/font-size:clamp\(16px,1\.35vw,19px\)/);
  assert.match(adminCss,/--admin-lg:clamp\(/);
  assert.match(adminCss,/\.topbar h1\{[^}]*font-size:var\(--admin-xl\)[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(adminCss,/\.material-title\{[^}]*font-size:var\(--admin-lg\)[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(adminCss,/\.status-pill\{[^}]*font-size:var\(--admin-sm\)[^}]*white-space:nowrap/);
  assert.match(adminManageCss,/\.manager-card h3\{[^}]*font-size:clamp\(/);
  assert.match(adminManageCss,/\.manage-card h3\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(adminNavCss,/font-size:clamp\(/);
  assert.match(adminLoginCss,/\.admin-login-card h1\{[^}]*font-size:clamp\(/);
});
