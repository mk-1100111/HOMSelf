const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const updater=fs.readFileSync(path.join(root,'UPDATE_HOMSELF.cmd'),'utf8');
const company=fs.readFileSync(path.join(root,'worker','HOMSelf_회사PC.cmd'),'utf8');
const start=fs.readFileSync(path.join(root,'worker','START_HOMSELF.cmd'),'utf8');

test('company worker launchers auto-update before starting worker',()=>{
  for(const source of [company,start]){
    assert.match(source,/HOMSELF_AUTOUPDATE_DONE/);
    assert.match(source,/UPDATE_HOMSELF\.cmd" --auto/);
    assert.match(source,/call "%~f0"/);
    assert.match(source,/worker_entry\.py --live/);
  }
});

test('root updater supports noninteractive auto mode and fast-forward pull',()=>{
  assert.match(updater,/if \/I "%~1"=="--auto" set "AUTO_MODE=1"/);
  assert.match(updater,/git fetch origin "%BRANCH%"/);
  assert.match(updater,/git pull --ff-only origin "%BRANCH%"/);
  assert.match(updater,/if "%AUTO_MODE%"=="0" pause/);
});
