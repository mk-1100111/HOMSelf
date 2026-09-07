import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from worker import Journal, execute_item, run_loop
from common import ConnectionFailure
from homs_adapter import parse_stock, validate_profile

ITEM={'id':'test-item','attempt_id':'attempt-1','manager_name':'TEST','material_code':'123','quantity':2}

class FakeAPI:
    def __init__(self, fail=None, items=()):
        self.calls=[];self.fail=fail;self.items=list(items);self.finished=False
    def post(self,path,body):
        self.calls.append(path)
        if path.endswith('/'+str(self.fail)):raise RuntimeError('simulated lost response')
        if path=='claim':return {'item':self.items.pop(0)}
        if path=='batch/finish':self.finished=True;return {'paused':True,'batch_active':False}
        return {}
    def get(self,path):
        return {'paused':False,'batch_active':True,'batch_remaining':len(self.items),
                'worker_protocol':3,'blocked':None,'items':self.items[:]}

class FakeAdapter:
    def __init__(self):self.clicks=0
    def ensure_session(self):pass
    def prepare(self,item):pass
    def verify(self,item):pass
    def show_admin(self,refresh=False):pass
    def submit_once(self,item):
        self.clicks+=1
        return {'source':'homs-ui-return','manager_name':item['manager_name'],
                'material_code':item['material_code'],'quantity':item['quantity']}

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
    def test_lost_complete_never_resubmits(self):self.assertEqual(self.run_case('complete'),1)
    def test_success_without_input_never_resubmits(self):self.assertEqual(self.run_case(),1)
    def test_batch_processes_all_captured_items(self):
        api=FakeAPI(items=[ITEM,{**ITEM,'id':'second','attempt_id':'attempt-2'}]);adapter=FakeAdapter()
        with patch('builtins.input',side_effect=AssertionError('unexpected input')):
            run_loop(api,adapter,self.journal,sleep=lambda _:None,stop=lambda:adapter.clicks==2)
        self.assertEqual(self.journal.db.execute("SELECT count(*) FROM attempts WHERE phase='completed'").fetchone()[0],2)
    def test_idle_without_batch_never_claims(self):
        api=FakeAPI(items=[ITEM]);api.get=lambda _:{'paused':True,'batch_active':False,'batch_remaining':0,'worker_protocol':3,'blocked':None,'items':[]}
        adapter=FakeAdapter();ticks=[]
        run_loop(api,adapter,self.journal,sleep=lambda _:ticks.append(1),stop=lambda:len(ticks)==2)
        self.assertEqual(adapter.clicks,0);self.assertNotIn('claim',api.calls)
    def test_empty_active_batch_finishes(self):
        api=FakeAPI();adapter=FakeAdapter();ticks=[]
        run_loop(api,adapter,self.journal,sleep=lambda _:ticks.append(1),stop=lambda:api.finished)
        self.assertTrue(api.finished);self.assertIn('batch/finish',api.calls)
    def test_idle_disconnect_recovers(self):
        api=FakeAPI(items=[ITEM]);get=api.get;calls=[]
        def reconnect(path):
            calls.append(path)
            if len(calls)==1:raise ConnectionFailure('offline')
            return get(path)
        api.get=reconnect;adapter=FakeAdapter()
        run_loop(api,adapter,self.journal,sleep=lambda _:None,stop=lambda:adapter.clicks==1)
        self.assertEqual(adapter.clicks,1)
    def test_blocked_batch_waits_before_claim(self):
        api=FakeAPI(items=[ITEM]);states=iter([
            {'batch_active':True,'batch_remaining':1,'blocked':{'status':'needs_review'},'items':[ITEM]},
            {'batch_active':True,'batch_remaining':1,'blocked':None,'items':[ITEM]}])
        api.get=lambda _:dict(next(states),worker_protocol=3,paused=False)
        adapter=FakeAdapter();waits=[]
        run_loop(api,adapter,self.journal,sleep=lambda _:waits.append(adapter.clicks),stop=lambda:adapter.clicks==1)
        self.assertEqual(waits[:1],[0]);self.assertEqual(api.calls.count('claim'),1)
    def test_uncertain_claim_stops_without_click_or_retry(self):
        api=FakeAPI(items=[ITEM]);post=api.post
        def uncertain(path,body):
            if path=='claim':raise ConnectionFailure('response lost')
            return post(path,body)
        api.post=uncertain;adapter=FakeAdapter()
        with self.assertRaises(ConnectionFailure):run_loop(api,adapter,self.journal,sleep=lambda _:self.fail('must stop'))
        self.assertEqual(adapter.clicks,0)
    def test_submit_failure_stops_loop_and_marks_review(self):
        api=FakeAPI(items=[ITEM]);adapter=FakeAdapter()
        def bad(_):
            adapter.clicks+=1
            raise RuntimeError('HOMS submit failed')
        adapter.submit_once=bad
        with self.assertRaises(RuntimeError):run_loop(api,adapter,self.journal,sleep=lambda _:self.fail('must stop'))
        self.assertEqual(adapter.clicks,1);self.assertTrue(api.calls[-1].endswith('/review'))
        self.assertFalse(any(c.endswith('/complete') for c in api.calls))
    def test_legacy_server_protocol_stops(self):
        api=FakeAPI();api.get=lambda _:{'paused':False,'batch_active':True,'batch_remaining':1,'worker_protocol':2,'blocked':None,'items':[ITEM]}
        with self.assertRaises(RuntimeError):run_loop(api,FakeAdapter(),self.journal)
        self.assertNotIn('claim',api.calls)
    def test_unknown_stock_and_profile_block(self):
        self.assertEqual(parse_stock('1,000'),1000)
        for value in ['-1','stock(5)','N/A','1 2','1,0']:
            with self.assertRaises(RuntimeError):parse_stock(value)
        with self.assertRaises(RuntimeError):validate_profile({})
        good={
            'profile_version':2,'validated_on_company_pc':True,
            'stock_url':'https://homs.biz/stock/stockInquiry','stock_search_css':'#srcGoodId',
            'stock_query_xpath':'//*[@id="query"]','stock_checkbox_xpath':'//*[@id="check_0"]',
            'release_open_xpath':'//*[@id="release"]','receiver_search_css':'#srcReceiverName',
            'quantity_css':'#srcStockCnt_0','release_button_xpath':'//*[@id="submit"]',
            'first_confirm_css':'#_confirmModalOk','second_confirm_css':'#_alertModalOk'
        }
        validate_profile(good)
if __name__=='__main__':unittest.main()
