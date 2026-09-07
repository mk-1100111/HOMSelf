"""One item per invocation. Default mode only reads the queue; no HOMS access."""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from common import ROOT, API, config

class Journal:
    def __init__(self, file):
        self.db = sqlite3.connect(file)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS attempts(item_id TEXT PRIMARY KEY, attempt_id TEXT, phase TEXT, updated_at TEXT)')
        self.db.commit()

    def record(self, item, phase):
        self.db.execute('INSERT INTO attempts VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET attempt_id=excluded.attempt_id, phase=excluded.phase, updated_at=excluded.updated_at',
                        (item['id'],item['attempt_id'],phase,datetime.now(timezone.utc).isoformat()))
        self.db.commit()

    def exists(self, item):
        return self.db.execute("SELECT phase FROM attempts WHERE item_id=? AND phase!='cleared_manual'",(item['id'],)).fetchone()

def execute_item(api, adapter, journal, item, ask=input):
    route = 'items/' + item['id'] + '/'
    def update(action, note=''):
        return api.post(route+action, {'attempt_id':item['attempt_id'],'note':note})
    if journal.exists(item):
        update('review','동일 항목의 회사 PC 처리 기록이 이미 있습니다. 재불출 차단.')
        raise RuntimeError('로컬 기록이 있는 항목입니다. HOMS 대조 없이 재처리할 수 없습니다.')
    journal.record(item,'claimed')
    try:
        adapter.prepare(item)
        confirmation=f"{item['manager_name']} {item['material_code']} {item['quantity']}"
        if ask('실제 불출하려면 다음 내용을 그대로 입력하세요: '+confirmation+'\n> ').strip() != confirmation:
            raise RuntimeError('사용자가 실제 불출을 승인하지 않았습니다.')
        adapter.verify(item)
        # Persist intent BEFORE requesting the single-use server permit.
        journal.record(item,'begin_requested')
        update('begin')
        journal.record(item,'submitting')
        adapter.submit_once(item)
        note=ask('HOMS 실제 불출내역에서 매니저·자재·수량을 확인하세요.\n확인한 불출번호/시각 등 근거를 10자 이상 입력(불명확하면 Enter): ').strip()
        if len(note)<10 or len(note)>1000:
            raise RuntimeError('HOMS 실제 저장 결과를 확인하지 못했습니다.')
        journal.record(item,'result_verified')
        update('complete',note)
        journal.record(item,'completed')
        print('HOMS 결과 확인 및 HOMSelf 완료 기록 성공. 다음 항목은 프로그램을 다시 실행하세요.')
    except BaseException as error:
        journal.record(item,'needs_review')
        try: update('review','회사 PC 처리 중단. 실제 HOMS 내역 대조가 필요합니다.')
        except Exception: pass
        raise error

def main():
    parser=argparse.ArgumentParser(description='HOMSelf 회사 PC 처리기 — 기본은 비불출 점검 모드')
    parser.add_argument('--live',action='store_true',help='현장 검증된 선택자로 1건만 실제 불출; 매번 사용자 확인 필수')
    parser.add_argument('--reconcile',metavar='ITEM_ID',help='서버에서 미불출 수동 판정한 항목의 로컬 재처리 차단 해제')
    args=parser.parse_args()
    cfg=config(); api=API(cfg)
    if args.reconcile:
        if args.live: raise RuntimeError('--live와 --reconcile은 함께 사용할 수 없습니다.')
        item=api.get('items/'+args.reconcile)
        if item['status']!='pending' or item['attempt_id'] is not None or len(item['evidence'])<10:
            raise RuntimeError('관리자 화면에서 미불출 수동 판정을 먼저 완료해야 합니다.')
        if input('모든 처리기를 종료하고 HOMS 미불출을 직접 확인했으면 항목 번호를 입력하세요: ').strip()!=item['id']:
            raise RuntimeError('취소했습니다.')
        runtime=ROOT/'runtime';runtime.mkdir(exist_ok=True)
        journal=Journal(runtime/'journal.sqlite')
        try: journal.record(item,'cleared_manual')
        finally: journal.db.close()
        print('로컬 차단 해제. 관리자 재승인 후 새 시도로 처리할 수 있습니다.');return
    api.post('heartbeat',{'mode':'live' if args.live else 'check'})
    preview=api.get('preview')
    print('서버 일시정지:',preview['paused'])
    print(json.dumps(preview['items'],ensure_ascii=False,indent=2))
    if not args.live:
        print('점검 완료. HOMS 접속/불출/요청 점유를 하지 않았습니다.');return
    if preview['paused']: raise RuntimeError('관리자 화면에서 처리 허용 후 실행하세요.')
    from homs_adapter import HomsAdapter, validate_profile
    profile=json.loads((ROOT/cfg['selectors_file']).read_text(encoding='utf-8-sig'))
    validate_profile(profile)
    runtime=ROOT/'runtime';runtime.mkdir(exist_ok=True)
    # OS-managed lock is released even on a crash. Do not delete the journal to retry.
    with (runtime/'worker.lock').open('a+b') as lock:
        lock.seek(0);lock.write(b'0');lock.flush();lock.seek(0)
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        adapter=HomsAdapter(profile)
        journal=Journal(runtime/'journal.sqlite')
        try:
            adapter.login()
            item=api.post('claim',{})['item']
            if not item: print('대기 중인 승인 항목이 없습니다.');return
            print('이번 처리:',item['manager_name'],item['material_code'],item['quantity'])
            execute_item(api,adapter,journal,item)
        finally:
            journal.db.close();adapter.close()

if __name__=='__main__':
    try: main()
    except (Exception, KeyboardInterrupt) as error:
        print('중단:',str(error) if not isinstance(error, KeyboardInterrupt) else '사용자 중단')
        print('HOMS 저장 여부를 확인하세요. 불출 버튼을 다시 누르거나 journal.sqlite를 삭제하지 마세요.')
        sys.exit(1)
