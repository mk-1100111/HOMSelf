"""Approval-driven continuous worker. Normal processing never asks for terminal input."""
import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from common import ROOT, API, config, ConnectionFailure, HTTPFailure

class Journal:
    def __init__(self, file):
        self.db = sqlite3.connect(file)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS attempts(item_id TEXT PRIMARY KEY, attempt_id TEXT, phase TEXT, updated_at TEXT)')
        self.db.execute('CREATE TABLE IF NOT EXISTS receipts(transaction_id TEXT PRIMARY KEY, item_id TEXT UNIQUE, evidence TEXT)')
        self.db.commit()

    def record(self, item, phase):
        self.db.execute('INSERT INTO attempts VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET attempt_id=excluded.attempt_id, phase=excluded.phase, updated_at=excluded.updated_at',
                        (item['id'],item['attempt_id'],phase,datetime.now(timezone.utc).isoformat()))
        self.db.commit()

    def exists(self, item):
        return self.db.execute("SELECT phase FROM attempts WHERE item_id=? AND phase!='cleared_manual'",(item['id'],)).fetchone()

    def save_proof(self, item, proof):
        self.db.execute('INSERT INTO receipts VALUES(?,?,?)',
                        (proof['transaction_id'],item['id'],json.dumps(proof,ensure_ascii=False)))
        self.db.commit()

def execute_item(api, adapter, journal, item):
    route = 'items/' + item['id'] + '/'
    def update(action, note='', proof=None):
        return api.post(route+action, {'attempt_id':item['attempt_id'],'note':note,'proof':proof})
    if journal.exists(item):
        update('review','동일 항목의 회사 PC 처리 기록이 이미 있습니다. 재불출 차단.')
        raise RuntimeError('로컬 기록이 있는 항목입니다. HOMS 대조 없이 재처리할 수 없습니다.')
    journal.record(item,'claimed')
    stage='prepare'
    try:
        adapter.prepare(item)
        adapter.verify(item)
        stage='begin'
        journal.record(item,'begin_requested')
        update('begin')
        journal.record(item,'submitting')
        stage='submit'
        result=adapter.submit_once(item)
        journal.record(item,'ui_confirmed')
        stage='complete'
        note=json.dumps({
            'source':result.get('source','homs-ui-return'),
            'manager_name':item['manager_name'],
            'material_code':item['material_code'],
            'quantity':item['quantity'],
            'confirmed_at':datetime.now(timezone.utc).isoformat()
        },ensure_ascii=False,separators=(',',':'))
        update('complete',note=note)
        journal.record(item,'completed')
        print('자동 불출 완료:',item['id'],item['manager_name'],item['material_code'],item['quantity'],flush=True)
    except BaseException as error:
        journal.record(item,'needs_review')
        note=f'자동 처리 중단: {stage} / {type(error).__name__}. HOMS 실제 불출내역 대조 필요.'
        try: update('review',note)
        except Exception: pass
        raise

def run_loop(api, adapter, journal, poll_seconds=5, once=False, sleep=time.sleep, stop=lambda:False):
    """Only idle polls reconnect. An uncertain claim/begin/release always stops."""
    previous=None
    while not stop():
        try:
            api.post('heartbeat',{'mode':'live'})
            state=api.get('preview')
        except (ConnectionFailure, TimeoutError, OSError):
            print('대기 중 서버 연결 끊김. 불출 없이 연결을 재확인합니다.',flush=True)
            if once: raise
            sleep(min(30,poll_seconds*2));continue
        if state.get('worker_protocol')!=2:
            raise RuntimeError('서버가 자동처리 프로토콜 v2가 아닙니다. 새 코드 배포를 확인하세요.')
        mode='일시정지' if state['paused'] else '확인 필요/다른 처리기 작업 중' if state.get('blocked') else '승인 요청 대기'
        if mode!=previous:
            print(mode,flush=True);previous=mode
        if not state['paused'] and not state.get('blocked') and state['items']:
            adapter.ensure_session()
            try:
                item=api.post('claim',{})['item']
            except HTTPFailure as error:
                if error.status!=409: raise
                item=None
            if item:
                print('자동 처리 시작:',item['manager_name'],item['material_code'],item['quantity'],flush=True)
                execute_item(api,adapter,journal,item)
        if once:return
        sleep(poll_seconds)

def reconcile(api, item_id, journal):
    item=api.get('items/'+item_id)
    if item['status']!='pending' or item['attempt_id'] is not None or len(item['evidence'])<10:
        raise RuntimeError('관리자 화면에서 미불출 수동 판정을 먼저 완료해야 합니다.')
    if journal.db.execute('SELECT 1 FROM receipts WHERE item_id=?',(item_id,)).fetchone():
        raise RuntimeError('이 항목에는 기존 검증 거래 기록이 있습니다. 재불출하지 마세요.')
    if input('모든 처리기를 종료하고 HOMS 미불출을 확인했으면 항목 번호를 입력하세요: ').strip()!=item_id:
        raise RuntimeError('취소했습니다.')
    journal.record(item,'cleared_manual')
    print('로컬 차단 해제. 관리자 재승인 후 새 시도로 처리할 수 있습니다.')

def main():
    parser=argparse.ArgumentParser(description='HOMSelf — 기본은 비불출 연결 점검, --live는 승인 요청 자동 감시')
    parser.add_argument('--live',action='store_true',help='승인된 요청을 계속 자동 처리')
    parser.add_argument('--once',action='store_true',help='--live와 함께 사용하면 감시 1회 후 종료')
    parser.add_argument('--reconcile',metavar='ITEM_ID',help='관리자 미불출 판정 이후 로컬 차단 해제')
    args=parser.parse_args()
    cfg=config();api=API(cfg)
    interval=cfg.get('poll_seconds',5)
    if type(interval) not in (int,float) or not 2<=interval<=60:
        raise RuntimeError('poll_seconds는 2~60초여야 합니다.')
    if args.reconcile and (args.live or args.once):
        raise RuntimeError('--reconcile은 다른 실행 모드와 함께 사용할 수 없습니다.')
    if args.once and not args.live:raise RuntimeError('--once는 --live와 함께 사용하세요.')
    if not args.live and not args.reconcile:
        api.post('heartbeat',{'mode':'check'})
        state=api.get('preview')
        print(json.dumps(state,ensure_ascii=False,indent=2))
        print('비불출 점검 완료. HOMS 접속/불출/요청 점유 없음.')
        return
    runtime=ROOT/'runtime';runtime.mkdir(exist_ok=True)
    with (runtime/'worker.lock').open('a+b') as lock:
        lock.seek(0);lock.write(b'0');lock.flush();lock.seek(0)
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        journal=Journal(runtime/'journal.sqlite')
        adapter=None
        try:
            if args.reconcile:
                reconcile(api,args.reconcile,journal);return
            from homs_adapter import HomsAdapter
            profile=json.loads((ROOT/cfg['selectors_file']).read_text(encoding='utf-8-sig'))
            adapter=HomsAdapter(profile)
            print('승인 요청 자동 감시 시작. 종료: Ctrl+C',flush=True)
            run_loop(api,adapter,journal,interval,once=args.once)
        finally:
            journal.db.close()
            if adapter:adapter.close()

if __name__=='__main__':
    try:main()
    except (Exception,KeyboardInterrupt) as error:
        print('중단:',str(error) if not isinstance(error,KeyboardInterrupt) else '사용자 중단',flush=True)
        print('처리 중인 항목은 관리자 화면과 HOMS 내역을 대조하세요. journal.sqlite를 삭제하지 마세요.')
        sys.exit(1)
