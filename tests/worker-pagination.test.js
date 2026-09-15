const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');

const source=fs.readFileSync('worker/worker_entry.py','utf8');

test('worker entry Python compiles',()=>{
  execFileSync('python3',['-m','py_compile','worker/worker_entry.py'],{stdio:'pipe'});
});

test('inventory sync reads 90-row pages until no next page remains',()=>{
  assert.match(source,/def sync_inventory\(self\):/);
  assert.match(source,/def _inventory_page_rows\(self, rows_xpath\):/);
  assert.match(source,/def _inventory_click_next_page\(self\):/);
  assert.match(source,/self\._select_page_size_90\(\)/);
  assert.match(source,/while page_number<=50:/);
  assert.match(source,/if not moved\.get\('clicked'\):\s*\n\s*break/);
  assert.match(source,/HOMS 전체 재고조회 완료/);
});