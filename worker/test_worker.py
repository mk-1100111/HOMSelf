import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from worker import Journal, execute_item, run_loop
from common import ConnectionFailure
from homs_adapter import parse_stock, validate_profile, verify_history_record

ITEM={'id':'test-item','attempt_id':'attempt-1','manager_name':'TEST','material_code':'123','quantity':2}
def proof(item):
    return {'source':'homs-history','transaction_id':'tx-'+item['id'],'receiver_id':'staff-test',
            'manager_name':item['manager_name'],'material_code':item['material_code'],
            'quantity':item['quantity'],'status':'completed'}
class FakeAPI:
    def __init__(self, fail=None, items=()):self.calls=[];self.fail=fail;self.items=list(items)
    def post(self,path,body):
        self.calls.append(path)
        if path.endswith('/'+str(self.fail)):raise RuntimeError('simulated lost response')
        if path=='claim':return {'item':self.items.pop(0)}
        return {}
    def get(self,path):
        return {'paused':False,'worker_protocol':2,'blocked':None,'items':self.items[:]}
class FakeAdapter:
    def __init__(self):self.clicks=0
    def ensure_session(self):pass
    def prepare(self,item):pass
    def verify(self,item):pass
    def submit_once(self,item):self.clicks+=1
    def verify_result(self,item):return proof(item)
class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.journal=Journal(Path(self.tmp.name)/'journal.sqlite')
    def tearDown(self):self.journal.db.close();self.tmp.cleanup()
    def run_case(self,fail=None):
        api=FakeAPI(fail);adapter=FakeAdapter()
        with patch('builtins.input',side_effect=AssertionError('normal flow must not prompt')):
            if fail:
                with self.assertRaises(RuntimeError):execute_item(api,adapter,self.journal,ITEM)
            else:execute_item(api,adapter,self.journal,ITEM)
            with self.assertRaises(RuntimeError):execute_item(api,adapter,self.journal,ITEM)
        return adapter.clicks
    def test_lost_begin_never_clicks(self):self.assertEqual(self.run_case('begin'),0)
    def test_lost_complete_never_resubmits(self):self.assertEqual(self.run_case('auto_complete'),1)
    def test_success_without_input_never_resubmits(self):self.assertEqual(self.run_case(),1)
    def test_continuous_processing_two_items_without_input(self):
        api=FakeAPI(items=[ITEM,{**ITEM,'id':'second','attempt_id':'attempt-2'}]);adapter=FakeAdapter()
        with patch('builtins.input',side_effect=AssertionError('unexpected input')):
            run_loop(api,adapter,self.journal,sleep=lambda _:None,stop=lambda:adapter.clicks==2)
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM attempts WHERE phase='completed'").fetchone()[0],2)
    def test_idle_disconnect_recovers(self):
        api=FakeAPI(items=[ITEM]);get=api.get;calls=[]
        def reconnect(path):
            calls.append(path)
            if len(calls)==1:raise ConnectionFailure('offline')
            return get(path)
        api.get=reconnect;adapter=FakeAdapter()
        run_loop(api,adapter,self.journal,sleep=lambda _:None,stop=lambda:adapter.clicks==1)
        self.assertEqual(adapter.clicks,1)
    def test_paused_and_blocked_wait_before_claim(self):
        api=FakeAPI(items=[ITEM]);states=iter([
            {'paused':True,'blocked':None},{'paused':False,'blocked':{'status':'needs_review'}},
            {'paused':False,'blocked':None}])
        api.get=lambda _:dict(next(states),worker_protocol=2,items=[ITEM])
        adapter=FakeAdapter();waits=[]
        run_loop(api,adapter,self.journal,sleep=lambda _:waits.append(adapter.clicks),stop=lambda:adapter.clicks==1)
        self.assertEqual(waits[:2],[0,0]);self.assertEqual(api.calls.count('claim'),1)
    def test_uncertain_claim_stops_without_click_or_retry(self):
        api=FakeAPI(items=[ITEM]);post=api.post
        def uncertain(path,body):
            if path=='claim':raise ConnectionFailure('response lost')
            return post(path,body)
        api.post=uncertain;adapter=FakeAdapter()
        with self.assertRaises(ConnectionFailure):run_loop(api,adapter,self.journal,sleep=lambda _:self.fail('must stop'))
        self.assertEqual(adapter.clicks,0)
    def test_bad_result_stops_loop_and_marks_review(self):
        api=FakeAPI(items=[ITEM]);adapter=FakeAdapter()
        def bad(_):raise RuntimeError('history mismatch')
        adapter.verify_result=bad
        with self.assertRaises(RuntimeError):run_loop(api,adapter,self.journal,sleep=lambda _:self.fail('must stop'))
        self.assertEqual(adapter.clicks,1);self.assertTrue(api.calls[-1].endswith('/review'))
        self.assertFalse(any(c.endswith('/auto_complete') for c in api.calls))
    def test_legacy_server_protocol_stops(self):
        api=FakeAPI();api.get=lambda _:{'paused':False,'items':[ITEM]}
        with self.assertRaises(RuntimeError):run_loop(api,FakeAdapter(),self.journal)
        self.assertNotIn('claim',api.calls)
    def test_local_receipt_cannot_be_reused(self):
        self.journal.save_proof(ITEM,proof(ITEM))
        import sqlite3
        with self.assertRaises(sqlite3.IntegrityError):self.journal.save_proof({**ITEM,'id':'other'},proof(ITEM))
    def test_history_requires_every_exact_field(self):
        record={'transaction_id':'txn-123','receiver_id':'staff-test','manager_name':'TEST',
                'material_code':'123','quantity':'2','status':'DONE'}
        result=verify_history_record(record,ITEM,'staff-test','txn-123','DONE')
        self.assertEqual(result['status'],'completed')
        for key in record:
            with self.subTest(field=key),self.assertRaises(RuntimeError):
                verify_history_record({**record,key:'wrong'},ITEM,'staff-test','txn-123','DONE')
    def test_unknown_stock_and_profile_block(self):
        self.assertEqual(parse_stock('1,000'),1000)
        for value in ['-1','stock(5)','N/A','1 2','1,0']:
            with self.assertRaises(RuntimeError):parse_stock(value)
        with self.assertRaises(RuntimeError):validate_profile({})
if __name__=='__main__':unittest.main()
