"""Approval-driven batch worker. Approved items wait until the admin starts a release batch."""
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
        self.db.execute('INSERT INTO attempts VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET attempt_id=excluded.attempt_id, phase=excluded.phase, updated_at=excluded.updated_at',(item['id'],item['attempt_id'],phase,datetime.now(timezone.utc).isoformat()))
        self.db.commit()
    def exists(self, item):
        return self.db.execute("SELECT phase FROM attempts WHERE item_id=? AND phase!='cleared_manual'",(item['id'],)).fetchone()
    def save_proof(self, item, proof):
        self.db.execute('INSERT INTO receipts VALUES(?,?,?)',(proof['transaction_id'],item['id'],json.dumps(proof,ensure_ascii=False)));self.db.commit()

def execute_item(api, adapter, journal, item):
    from homs_adapter import MissingStockResult
    route='items/'+item['id']+'/'
    def update(action,note='',proof=None):return api.post(route+action,{'attempt_id':item['attempt_id'],'note':note,'proof':proof})
    if journal.exists(item):
        update('review','동일 항목의 회사 PC 처리 기록이 이미 있습니다. 재불출 차단.')
        raise RuntimeError('로컬 기록이 있는 항목입니다. HOMS 대조 없이 재처리할 수 없습니다.')
    journal.record(item,'claimed');stage='prepare'
    try:
        adapter.prepare(item);adapter.verify(item);stage='begin';journal.record(item,'begin_requested');update('begin');journal.record(item,'submitting');stage='submit';result=adapter.submit_once(item);journal.record(item,'ui_confirmed');stage='complete'
        note=json.dumps({'source':result.get('source','homs-ui-return'),'manager_name':item['manager_name'],'material_code':item['material_code'],'quantity':item['quantity'],'confirmed_at':datetime.now(timezone.utc).isoformat()},ensure_ascii=False,separators=(',',':'))
        update('complete',note=note);journal.record(item,'completed');print('자동 불출 완료:',item['id'],item['manager_name'],item['material_code'],item['quantity'],flush=True)
        try:adapter.show_admin(refresh=False)
        except Exception:pass
    except MissingStockResult:
        note='HOMS 조회 결과 체크박스 없음 - 미불출 스킵: '+item['material_code'];update('skip_missing_result',note);journal.record(item,'skipped_missing_result');print('조회 결과 없음 - 건너뜀:',item['manager_name'],item['material_code'],item['quantity'],flush=True)
        try:adapter.show_admin(refresh=False)
        except Exception:pass
        return
    except BaseException as error:
        journal.record(item,'needs_review');note=f'자동 처리 중단: {stage} / {type(error).__name__}. HOMS 실제 불출내역 대조 필요.'
        try:update('review',note)
        except Exception:pass
        try:adapter.show_admin(refresh=False)
        except Exception:pass
        raise

def recover_interrupted(api):
    state=api.get('preview');blocked=state.get('blocked') or {}
    if blocked.get('status') not in ('claimed','submitting'):return 0
    item=api.get('items/'+blocked['id']);attempt=item.get('attempt_id')
    if not attempt:return 0
    api.post('items/'+item['id']+'/review',{'attempt_id':attempt,'note':'Worker 재실행 감지 - 이전 처리 건 자동 확인 필요 전환'})
    print('이전 중단 건을 확인 필요로 전환:',item['manager_name'],item['material_code'],item['quantity'],flush=True);return 1

def restore_catalog(api,cfg):
    try:
        from catalog_persistence import restore_persistent_catalog
        restore_persistent_catalog(api,cfg);return True
    except Exception as error:
        print('GitHub 영구 부자재 catalog 복원 실패:',type(error).__name__,str(error),flush=True)
        print('재고/불출 기능은 계속 동작하지만 신규 부자재 영구 보존에는 HOMSELF_BACKUP_GITHUB_TOKEN이 필요합니다.',flush=True);return False

def execute_catalog_persist(api,cfg):
    state=api.get('catalog-persist')
    if not state.get('pending'):return False
    revision=state.get('revision');catalog=state.get('catalog')
    if not revision or not catalog:raise RuntimeError('관리자 catalog 저장 요청 데이터가 없습니다.')
    from catalog_persistence import persist_admin_catalog
    commit=persist_admin_catalog(cfg,catalog)
    api.post('catalog-persist/complete',{'revision':revision})
    print('관리자 catalog GitHub 영구 저장 완료:',commit,flush=True)
    return True

def execute_inventory_sync(api, adapter, sync_state, cfg):
    request_id=sync_state.get('request_id')
    if not request_id:raise RuntimeError('재고 동기화 요청번호가 없습니다.')
    print('재고 동기화 시작: HOMS 전체 / 90개씩보기',flush=True)
    try:
        rows=adapter.sync_inventory()
        try:
            from catalog_persistence import persist_inventory_catalog, push_catalog_to_server
            catalog,added=persist_inventory_catalog(cfg,rows);push_catalog_to_server(api,catalog)
            if added:print('신규 부자재 영구 catalog 반영 완료:',len(added),'건',flush=True)
        except Exception as persistence_error:
            print('신규 부자재 GitHub 영구 저장 실패:',type(persistence_error).__name__,str(persistence_error),flush=True)
            print('재고 동기화는 계속 진행합니다. HOMSELF_BACKUP_GITHUB_TOKEN 설정을 확인하세요.',flush=True)
        result=api.post('inventory-sync',{'request_id':request_id,'items':rows});print('재고 동기화 완료:',result.get('count',len(rows)),'건',flush=True)
    except BaseException as error:
        try:api.post('inventory-sync/fail',{'request_id':request_id,'error':f'{type(error).__name__}: {error}'})
        except Exception:pass
        print('재고 동기화 실패:',type(error).__name__,str(error),flush=True)
    finally:
        try:adapter.show_admin(refresh=False)
        except Exception:pass

def run_loop(api, adapter, journal, cfg, poll_seconds=5, once=False, sleep=time.sleep, stop=lambda:False):
    previous=None;last_keepalive=0.0
    while not stop():
        try:
            api.post('heartbeat',{'mode':'live'});state=api.get('preview')
        except (ConnectionFailure, TimeoutError, OSError):
            print('대기 중 서버 연결 끊김. 불출 없이 연결을 재확인합니다.',flush=True)
            if once:raise
            sleep(min(30,poll_seconds*2));continue
        if state.get('worker_protocol')!=3:raise RuntimeError('서버/회사 PC 코드 버전이 맞지 않습니다. 최신 worker를 다시 받아주세요.')
        sync_state=state.get('inventory_sync') or {}
        if sync_state.get('status')=='requested' and not state.get('batch_active') and not state.get('blocked'):mode='재고 동기화 요청 처리 중'
        elif state.get('blocked'):mode='다른 처리기 작업 중'
        elif state.get('batch_active'):mode='일괄 불출 진행 중 / 남은 '+str(state.get('batch_remaining',0))+'건'
        else:mode='승인 누적 대기 / 관리자 불출 시작 대기'
        if mode!=previous:print(mode,flush=True);previous=mode

        if not state.get('batch_active') and not state.get('blocked') and sync_state.get('status')!='requested':
            try:
                if execute_catalog_persist(api,cfg):
                    previous=None
                    if once:return
                    sleep(poll_seconds);continue
            except Exception as error:
                print('관리자 catalog GitHub 영구 저장 실패:',type(error).__name__,str(error),flush=True)

        if sync_state.get('status')=='requested' and not state.get('batch_active') and not state.get('blocked'):
            execute_inventory_sync(api,adapter,sync_state,cfg);previous=None
            if once:return
            sleep(poll_seconds);continue

        now=time.monotonic()
        if not state.get('batch_active') and not state.get('blocked') and now-last_keepalive>=60:
            try:adapter.keep_alive()
            except Exception as error:print('HOMS 세션 유지 요청 실패:',type(error).__name__,flush=True)
            finally:last_keepalive=now

        if state.get('batch_active') and not state.get('blocked') and state['items']:
            adapter.ensure_session()
            try:item=api.post('claim',{})['item']
            except HTTPFailure as error:
                if error.status!=409:raise
                item=None
            if item:
                print('자동 처리 시작:',item['manager_name'],item['material_code'],item['quantity'],flush=True);execute_item(api,adapter,journal,item);previous=None
        elif state.get('batch_active') and not state.get('blocked') and not state['items'] and state.get('batch_remaining',0)==0:
            api.post('batch/finish',{});print('일괄 불출 완료. 이후 승인 건은 다음 불출 시작까지 대기합니다.',flush=True)
            try:adapter.show_admin(refresh=False)
            except Exception:pass
            previous=None
        if once:return
        sleep(poll_seconds)

def reconcile(api,item_id,journal):
    item=api.get('items/'+item_id)
    if item['status']!='pending' or item['attempt_id'] is not None or len(item['evidence'])<10:raise RuntimeError('관리자 화면에서 미불출 수동 판정을 먼저 완료해야 합니다.')
    if journal.db.execute('SELECT 1 FROM receipts WHERE item_id=?',(item_id,)).fetchone():raise RuntimeError('이 항목에는 기존 검증 거래 기록이 있습니다. 재불출하지 마세요.')
    if input('모든 처리기를 종료하고 HOMS 미불출을 확인했으면 항목 번호를 입력하세요: ').strip()!=item_id:raise RuntimeError('취소했습니다.')
    journal.record(item,'cleared_manual');print('로컬 차단 해제. 관리자 재승인 후 새 시도로 처리할 수 있습니다.')

def main():
    parser=argparse.ArgumentParser(description='HOMSelf — 기본은 연결 점검, --live는 관리자 일괄 불출 배치를 감시');parser.add_argument('--live',action='store_true',help='관리자가 시작한 일괄 불출 배치를 계속 감시');parser.add_argument('--once',action='store_true',help='--live와 함께 사용하면 감시 1회 후 종료');parser.add_argument('--reconcile',metavar='ITEM_ID',help='관리자 미불출 판정 이후 로컬 차단 해제');args=parser.parse_args();cfg=config();api=API(cfg);interval=cfg.get('poll_seconds',5)
    if type(interval) not in (int,float) or not 2<=interval<=60:raise RuntimeError('poll_seconds는 2~60초여야 합니다.')
    if args.reconcile and (args.live or args.once):raise RuntimeError('--reconcile은 다른 실행 모드와 함께 사용할 수 없습니다.')
    if args.once and not args.live:raise RuntimeError('--once는 --live와 함께 사용하세요.')
    if not args.live and not args.reconcile:
        api.post('heartbeat',{'mode':'check'});state=api.get('preview');print(json.dumps(state,ensure_ascii=False,indent=2));print('비불출 점검 완료. HOMS 접속/불출/요청 점유 없음.');return
    runtime=ROOT/'runtime';runtime.mkdir(exist_ok=True)
    with (runtime/'worker.lock').open('a+b') as lock:
        lock.seek(0);lock.write(b'0');lock.flush();lock.seek(0)
        if os.name=='nt':
            import msvcrt;msvcrt.locking(lock.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl;fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        journal=Journal(runtime/'journal.sqlite');adapter=None
        try:
            if args.reconcile:reconcile(api,args.reconcile,journal);return
            from homs_adapter import HomsAdapter
            profile=json.loads((ROOT/cfg['selectors_file']).read_text(encoding='utf-8-sig'));admin_url=cfg['server_url'].rstrip('/')+'/admin';adapter=HomsAdapter(profile,admin_url=admin_url,profile_dir=runtime/'chrome_profile');recover_interrupted(api);restore_catalog(api,cfg)
            print('일괄 불출/재고 동기화 감시 시작. 종료: Ctrl+C',flush=True);print('사용 순서: HOMS 로그인 -> 관리자 승인/재고 동기화 -> 회사 PC 자동 처리',flush=True);run_loop(api,adapter,journal,cfg,interval,once=args.once)
        finally:
            journal.db.close()
            if adapter:adapter.close()

if __name__=='__main__':
    try:main()
    except (Exception,KeyboardInterrupt) as error:
        print('중단:',str(error) if not isinstance(error,KeyboardInterrupt) else '사용자 중단',flush=True);print('처리 중인 항목은 관리자 화면과 HOMS 내역을 대조하세요. journal.sqlite를 삭제하지 마세요.');sys.exit(1)
