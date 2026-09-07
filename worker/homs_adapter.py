"""Automatic HOMS UI adapter. Importing this module does not open a browser."""
import re
from urllib.parse import urlparse
from datetime import datetime, timezone

def parse_stock(value):
    value=str(value).strip()
    if not re.fullmatch(r'\d+|\d{1,3}(?:,\d{3})+',value):
        raise RuntimeError('수량 표시를 정확하게 해석할 수 없습니다.')
    return int(value.replace(',',''))

def validate_profile(p):
    required=['authenticated_css','stock_url','stock_rows','stock_query_xpath','stock_search_css',
              'release_open_xpath','receiver_search_css','receiver_result_rows_css',
              'receiver_result_id_css','receiver_result_name_css','receiver_result_select_css',
              'selected_receiver_id_css','selected_receiver_name_css','popup_material_code_css',
              'quantity_css','release_button_xpath','first_confirm_css','second_confirm_css',
              'receipt_id_css','history_url','history_search_css','history_query_css','history_rows_css',
              'history_transaction_css','history_receiver_id_css','history_manager_name_css',
              'history_material_code_css','history_quantity_css','history_status_css','history_completed_text']
    if p.get('profile_version')!=2 or p.get('validated_on_company_pc') is not True:
        raise RuntimeError('자동 처리용 HOMS 프로필 v2의 현장 검증이 필요합니다. selectors.auto.example.json을 확인하세요.')
    missing=[k for k in required if not isinstance(p.get(k),str) or not p[k].strip()]
    if missing:raise RuntimeError('아직 확인되지 않은 HOMS 선택자: '+', '.join(missing))
    for key in ('code_cell_index','stock_cell_index'):
        if type(p.get(key)) is not int or p[key]<1:raise RuntimeError('재고표 열 번호는 1부터 시작하는 정수여야 합니다.')
    for key in ('stock_url','history_url'):
        url=urlparse(p[key])
        if url.scheme!='https' or url.hostname!='homs.biz' or url.username or url.password:
            raise RuntimeError('HOMS 페이지는 https://homs.biz 안의 URL이어야 합니다.')
    if not isinstance(p.get('manager_ids'),dict) or not p['manager_ids'] or not all(isinstance(v,str) and v.strip() for v in p['manager_ids'].values()):
        raise RuntimeError('매니저 이름과 HOMS 담당자 고유 ID 매핑이 필요합니다.')
    ids=list(p['manager_ids'].values())
    if len(set(ids))!=len(ids):raise RuntimeError('서로 다른 매니저가 같은 HOMS ID에 매핑되어 있습니다.')

def verify_history_record(record,item,receiver_id,receipt_id,completed_text):
    """A receipt from THIS submission must match one complete history record."""
    expected={'transaction_id':receipt_id,'receiver_id':receiver_id,
              'manager_name':item['manager_name'],'material_code':item['material_code'],'status':completed_text}
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',receipt_id):
        raise RuntimeError('성공 거래번호 형식을 확인할 수 없습니다.')
    for field,value in expected.items():
        if record.get(field)!=value:raise RuntimeError('HOMS 결과 불일치: '+field)
    if parse_stock(record.get('quantity',''))!=item['quantity']:
        raise RuntimeError('HOMS 결과 불일치: quantity')
    return {'source':'homs-history','transaction_id':receipt_id,'receiver_id':receiver_id,
            'manager_name':item['manager_name'],'material_code':item['material_code'],
            'quantity':item['quantity'],'status':'completed',
            'verified_at':datetime.now(timezone.utc).isoformat()}

class HomsAdapter:
    def __init__(self,profile):
        validate_profile(profile)
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        self.p=profile;self.By=By
        self.driver=webdriver.Chrome()
        self.driver.maximize_window()
        self.wait=WebDriverWait(self.driver,20)
        self.receipt=None

    def unique(self,selector,xpath=False,visible=True,root=None):
        by=self.By.XPATH if xpath else self.By.CSS_SELECTOR
        def find(_):
            nodes=(root or self.driver).find_elements(by,selector)
            nodes=[e for e in nodes if not visible or e.is_displayed()]
            if len(nodes)>1:raise RuntimeError('동일 선택자 요소가 여러 개입니다. 중단: '+selector)
            return nodes[0] if nodes and (not visible or nodes[0].is_enabled()) else False
        return self.wait.until(find)

    @staticmethod
    def value(e):
        return (e.get_attribute('value') or e.text or '').strip()

    def rows(self,selector):
        return [r for r in self.driver.find_elements(self.By.CSS_SELECTOR,selector) if r.is_displayed()]

    def field(self,row,selector):
        return self.value(self.unique(selector,visible=False,root=row))

    def authenticated(self):
        return any(e.is_displayed() for e in self.driver.find_elements(self.By.CSS_SELECTOR,self.p['authenticated_css']))

    def ensure_session(self):
        from selenium.webdriver.support.ui import WebDriverWait
        if not self.authenticated():
            self.driver.get('https://homs.biz/homeAndService.jsp')
            print('HOMS 브라우저에서 로그인하세요. 로그인 완료를 자동 감지합니다.',flush=True)
            WebDriverWait(self.driver,300).until(lambda _:self.authenticated())
        # This is before claim, so login failure has no claimed release.

    def require_session(self):
        if not self.authenticated():raise RuntimeError('HOMS 로그인 세션이 만료됐습니다.')

    def fill(self,selector,value):
        from selenium.webdriver.common.keys import Keys
        e=self.unique(selector)
        if e.get_attribute('readonly') or e.get_attribute('disabled'):
            raise RuntimeError('입력칸이 잠겨 있습니다. 강제 해제하지 않습니다.')
        e.clear();e.send_keys(str(value));e.send_keys(Keys.TAB)
        if self.value(self.unique(selector))!=str(value):raise RuntimeError('입력 값 검증 실패: '+selector)

    def prepare(self,item):
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.support import expected_conditions as EC
        self.receipt=None
        expected=self.p['manager_ids'].get(item['manager_name'])
        if not expected:raise RuntimeError('요청 매니저의 HOMS 고유 ID가 없습니다.')
        self.driver.get(self.p['stock_url']);self.require_session()
        self.fill(self.p['stock_search_css'],item['material_code'])
        old=self.rows(self.p['stock_rows'])
        self.unique(self.p['stock_query_xpath'],True).click()
        # Do not use pre-query stock rows. If HOMS updates nodes in place, calibrate this wait.
        if old:self.wait.until(EC.staleness_of(old[0]))
        self.wait.until(lambda _:len(self.rows(self.p['stock_rows']))>0)
        matches=[]
        for row in self.rows(self.p['stock_rows']):
            cells=row.find_elements(self.By.CSS_SELECTOR,'td')
            if len(cells)>=self.p['code_cell_index'] and cells[self.p['code_cell_index']-1].text.strip()==item['material_code']:
                matches.append((row,cells))
        if len(matches)!=1:raise RuntimeError('자재코드가 정확히 일치하는 재고 행이 1개가 아닙니다.')
        row,cells=matches[0]
        if len(cells)<self.p['stock_cell_index'] or parse_stock(cells[self.p['stock_cell_index']-1].text)<item['quantity']:
            raise RuntimeError('현재재고가 부족하거나 확인할 수 없습니다.')
        for box in self.driver.find_elements(self.By.CSS_SELECTOR,self.p['stock_rows']+' input[type=checkbox]'):
            if box.is_selected():box.click()
        boxes=row.find_elements(self.By.CSS_SELECTOR,'input[type=checkbox]')
        if len(boxes)!=1:raise RuntimeError('자재 선택 체크박스가 유일하지 않습니다.')
        boxes[0].click()
        self.unique(self.p['release_open_xpath'],True).click()
        receiver=self.unique(self.p['receiver_search_css'])
        receiver.clear();receiver.send_keys(item['manager_name']);receiver.send_keys(Keys.ENTER)
        self.wait.until(lambda _:len(self.rows(self.p['receiver_result_rows_css']))>0)
        matches=[r for r in self.rows(self.p['receiver_result_rows_css'])
                 if self.field(r,self.p['receiver_result_id_css'])==expected and
                 self.field(r,self.p['receiver_result_name_css'])==item['manager_name']]
        if len(matches)!=1:raise RuntimeError('담당자 검색 결과의 이름/고유 ID가 유일하게 일치하지 않습니다.')
        self.unique(self.p['receiver_result_select_css'],root=matches[0]).click()
        self.wait.until(lambda _:self.value(self.unique(self.p['selected_receiver_id_css'],visible=False))==expected)
        self.fill(self.p['quantity_css'],item['quantity'])
        self.verify(item)

    def verify(self,item):
        self.require_session()
        for key,expected in [('selected_receiver_id_css',self.p['manager_ids'][item['manager_name']]),
                             ('selected_receiver_name_css',item['manager_name']),
                             ('popup_material_code_css',item['material_code']),
                             ('quantity_css',str(item['quantity']))]:
            if self.value(self.unique(self.p[key],visible=False))!=expected:
                raise RuntimeError('불출 직전 매니저/자재/수량 대조 실패: '+key)

    def submit_once(self,item):
        self.verify(item)
        old=[self.value(e) for e in self.driver.find_elements(self.By.CSS_SELECTOR,self.p['receipt_id_css'])]
        self.unique(self.p['release_button_xpath'],True).click()
        self.unique(self.p['first_confirm_css']).click()
        self.unique(self.p['second_confirm_css']).click()
        # A generic success popup is NOT enough. Capture the new transaction ID.
        def new_receipt(_):
            nodes=[e for e in self.driver.find_elements(self.By.CSS_SELECTOR,self.p['receipt_id_css']) if e.is_displayed()]
            if len(nodes)>1:raise RuntimeError('성공 거래번호가 여러 개입니다.')
            value=self.value(nodes[0]) if nodes else ''
            return value if value and value not in old else False
        self.receipt=self.wait.until(new_receipt)
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',self.receipt):
            raise RuntimeError('불출 후 새 거래번호를 확인할 수 없습니다.')

    def verify_result(self,item):
        if not self.receipt:raise RuntimeError('이번 불출의 거래번호가 없습니다.')
        receipt=self.receipt
        self.driver.get(self.p['history_url']);self.require_session()
        self.fill(self.p['history_search_css'],receipt)
        self.unique(self.p['history_query_css']).click()
        def find(_):
            matched=[r for r in self.rows(self.p['history_rows_css'])
                     if self.field(r,self.p['history_transaction_css'])==receipt]
            if len(matched)>1:raise RuntimeError('같은 거래번호의 불출내역이 여러 개입니다.')
            return matched[0] if matched else False
        row=self.wait.until(find)
        fields={'transaction_id':'history_transaction_css','receiver_id':'history_receiver_id_css',
                'manager_name':'history_manager_name_css','material_code':'history_material_code_css',
                'quantity':'history_quantity_css','status':'history_status_css'}
        record={k:self.field(row,self.p[v]) for k,v in fields.items()}
        return verify_history_record(record,item,self.p['manager_ids'][item['manager_name']],
                                     receipt,self.p['history_completed_text'])

    def close(self):
        self.driver.quit()
