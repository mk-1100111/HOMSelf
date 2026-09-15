const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');

const source=fs.readFileSync('worker/worker_entry.py','utf8');

test('worker entry Python compiles',()=>{
  execFileSync('python3',['-m','py_compile','worker/worker_entry.py'],{stdio:'pipe'});
});

test('inventory sync advances one numeric page per full 90-row page',()=>{
  assert.match(source,/PAGE_SIZE = 90/);
  assert.match(source,/PAGING_XPATH = '\/\/\*\[@id="wrap"\]\/div\[3\]\/div\[2\]\/div\[3\]'/);
  assert.match(source,/def _inventory_click_page\(self, target_page\):/);
  assert.match(source,/if page_added < self\.PAGE_SIZE:\s*\n\s*break/);
  assert.match(source,/next_page=page_number\+1/);
  assert.match(source,/moved=self\._inventory_click_page\(next_page\)/);
  assert.match(source,/xp\+'\/a\['\+index\+'\]'/);
  assert.match(source,/HOMS 전체 재고조회 완료/);
});
