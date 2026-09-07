import tempfile
import unittest
from pathlib import Path
from worker import Journal, execute_item
from homs_adapter import parse_stock, validate_profile

ITEM={'id':'test-item','attempt_id':'attempt-1','manager_name':'TEST','material_code':'123','quantity':2}
class FakeAPI:
    def __init__(self, fail=None):self.calls=[];self.fail=fail
    def post(self,path,body):
        self.calls.append(path)
        if path.endswith('/'+str(self.fail)):raise RuntimeError('simulated lost response')
        return {}
class FakeAdapter:
    def __init__(self):self.clicks=0
    def prepare(self,item):pass
    def verify(self,item):pass
    def submit_once(self,item):self.clicks+=1
class SafetyTests(unittest.TestCase):
    def run_case(self,fail=None):
        with tempfile.TemporaryDirectory() as tmp:
            journal=Journal(Path(tmp)/'journal.sqlite');api=FakeAPI(fail);adapter=FakeAdapter()
            answers=iter(['TEST 123 2','HOMS record 123 verified'])
            try:
                if fail:
                    with self.assertRaises(RuntimeError):execute_item(api,adapter,journal,ITEM,lambda _:next(answers))
                else:execute_item(api,adapter,journal,ITEM,lambda _:next(answers))
                with self.assertRaises(RuntimeError):execute_item(api,adapter,journal,ITEM,lambda _:next(answers))
                return adapter.clicks
            finally:journal.db.close()
    def test_lost_begin_never_clicks(self):self.assertEqual(self.run_case('begin'),0)
    def test_lost_complete_never_resubmits(self):self.assertEqual(self.run_case('complete'),1)
    def test_success_never_resubmits(self):self.assertEqual(self.run_case(),1)
    def test_unknown_stock_and_profile_block(self):
        self.assertEqual(parse_stock('1,000'),1000)
        for text in ['-1','재고(5)','N/A','1 2','1,0']:
            with self.assertRaises(RuntimeError):parse_stock(text)
        with self.assertRaises(RuntimeError):validate_profile({})
if __name__=='__main__':unittest.main()
