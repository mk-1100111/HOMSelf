"""UI preparation is fail-closed. Verify company selectors before enabling live use.

This module has no import-time browser activity and never stores login passwords.
"""
import re
from pathlib import Path
import json

def parse_stock(value):
    value = str(value).strip()
    # Unlike the old program, unknown/negative/ambiguous stock must not become zero.
    if not re.fullmatch(r'\d+|\d{1,3}(?:,\d{3})+', value):
        raise RuntimeError('현재재고 표시를 정확하게 해석할 수 없습니다: 현장 확인이 필요합니다.')
    return int(value.replace(',', ''))

def validate_profile(profile):
    required = ['stock_rows', 'release_open_xpath', 'receiver_search_css',
                'selected_receiver_id_css', 'selected_receiver_name_css', 'popup_material_code_css',
                'quantity_css', 'release_button_xpath', 'first_confirm_css', 'second_confirm_css']
    if profile.get('validated_on_company_pc') is not True:
        raise RuntimeError('회사 PC에서 HOMS 선택자 검증이 끝나지 않았습니다. selectors.json을 확인하세요.')
    if any(not isinstance(profile.get(key), str) or not profile[key].strip() for key in required):
        raise RuntimeError('HOMS 선택자가 비어 있습니다. 추정값으로 실제 불출하지 않습니다.')
    for key in ('code_cell_index', 'stock_cell_index'):
        if type(profile.get(key)) is not int or profile[key] < 1:
            raise RuntimeError('재고표 열 번호는 1부터 시작하는 정수여야 합니다.')
    if not profile.get('manager_ids') or not all(isinstance(v,str) and v.strip() for v in profile['manager_ids'].values()):
        raise RuntimeError('매니저 이름과 HOMS 담당자 고유 ID 매핑이 필요합니다.')

class HomsAdapter:
    def __init__(self, profile):
        validate_profile(profile)
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        self.p = profile
        self.By = By
        self.driver = webdriver.Chrome()
        self.driver.maximize_window()
        self.wait = WebDriverWait(self.driver, 20)

    def unique(self, selector, xpath=False):
        by = self.By.XPATH if xpath else self.By.CSS_SELECTOR
        def find(driver):
            found = [e for e in driver.find_elements(by, selector) if e.is_displayed()]
            if len(found) > 1:
                raise RuntimeError('같은 선택자의 요소가 여러 개입니다. 불출을 중단합니다.')
            return found[0] if found and found[0].is_enabled() else False
        return self.wait.until(find)

    @staticmethod
    def value(element):
        return (element.get_attribute('value') or element.text or '').strip()

    def login(self):
        self.driver.get('https://homs.biz/homeAndService.jsp')
        input('브라우저에서 직접 로그인하고 안내 팝업을 닫으세요. 완료 후 Enter: ')

    def prepare(self, item):
        from selenium.webdriver.common.keys import Keys
        expected = self.p['manager_ids'].get(item['manager_name'])
        if not expected:
            raise RuntimeError('이 매니저의 HOMS 고유 ID 매핑이 없습니다.')
        self.driver.get('https://homs.biz/stock/stockInquiry')
        input('재고 화면에서 요청 자재코드를 검색/조회하세요. 결과가 나온 뒤 Enter: ')
        rows = [r for r in self.driver.find_elements(self.By.CSS_SELECTOR, self.p['stock_rows']) if r.is_displayed()]
        matches = []
        for row in rows:
            cells = row.find_elements(self.By.CSS_SELECTOR, 'td')
            if len(cells) >= self.p['code_cell_index'] and cells[self.p['code_cell_index']-1].text.strip() == item['material_code']:
                matches.append((row,cells))
        if len(matches) != 1:
            raise RuntimeError('자재코드가 정확히 일치하는 행이 1개가 아닙니다. 페이지/검색 조건을 확인하세요.')
        row, cells = matches[0]
        if len(cells) < self.p['stock_cell_index'] or parse_stock(cells[self.p['stock_cell_index']-1].text) < item['quantity']:
            raise RuntimeError('현재재고 확인 실패 또는 재고 부족입니다. 일부 수량으로 임의 불출하지 않습니다.')
        boxes = self.driver.find_elements(self.By.CSS_SELECTOR, self.p['stock_rows'] + ' input[type=checkbox]')
        for box in boxes:
            if box.is_selected(): box.click()
        boxes = row.find_elements(self.By.CSS_SELECTOR, 'input[type=checkbox]')
        if len(boxes) != 1: raise RuntimeError('자재 선택 체크박스가 유일하지 않습니다.')
        boxes[0].click()
        self.unique(self.p['release_open_xpath'], True).click()
        receiver = self.unique(self.p['receiver_search_css'])
        receiver.clear(); receiver.send_keys(item['manager_name']); receiver.send_keys(Keys.ENTER)
        input('HOMS 검색 결과에서 해당 담당자를 선택하세요. 완료 후 Enter: ')
        if self.value(self.unique(self.p['selected_receiver_id_css'])) != expected:
            raise RuntimeError('선택된 HOMS 담당자 ID가 요청 매니저와 다릅니다.')
        if self.value(self.unique(self.p['selected_receiver_name_css'])) != item['manager_name']:
            raise RuntimeError('선택된 담당자 이름이 다릅니다.')
        if self.value(self.unique(self.p['popup_material_code_css'])) != item['material_code']:
            raise RuntimeError('불출창의 자재코드가 다릅니다.')
        quantity = self.unique(self.p['quantity_css'])
        if quantity.get_attribute('readonly') or quantity.get_attribute('disabled'):
            raise RuntimeError('수량 입력이 잠겨 있습니다. 강제로 해제하지 않습니다.')
        quantity.clear(); quantity.send_keys(str(item['quantity'])); quantity.send_keys(Keys.TAB)
        self.verify(item)

    def verify(self, item):
        checks = [('selected_receiver_id_css', self.p['manager_ids'][item['manager_name']]),
                  ('selected_receiver_name_css',item['manager_name']),
                  ('popup_material_code_css',item['material_code']), ('quantity_css',str(item['quantity']))]
        for key, expected in checks:
            if self.value(self.unique(self.p[key])) != expected:
                raise RuntimeError('불출 직전 매니저/자재/수량 대조가 실패했습니다.')

    def submit_once(self, item):
        self.verify(item)
        self.unique(self.p['release_button_xpath'], True).click()
        self.unique(self.p['first_confirm_css']).click()
        # Never send ENTER blindly: a missing/changed modal must stop the run.
        self.unique(self.p['second_confirm_css']).click()

    def close(self):
        self.driver.quit()
