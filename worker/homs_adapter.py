"""Automatic HOMS UI adapter for the company PC browser workspace."""
import re
from pathlib import Path
from urllib.parse import urlparse


def parse_stock(value):
    value = str(value).strip()
    if not re.fullmatch(r'\d+|\d{1,3}(?:,\d{3})+', value):
        raise RuntimeError('수량 표시를 정확하게 해석할 수 없습니다.')
    return int(value.replace(',', ''))


def validate_profile(p):
    required = [
        'stock_url', 'stock_search_css', 'stock_query_xpath', 'stock_checkbox_xpath',
        'release_open_xpath', 'receiver_search_css', 'quantity_css',
        'release_button_xpath', 'first_confirm_css', 'second_confirm_css'
    ]
    if p.get('profile_version') != 2 or p.get('validated_on_company_pc') is not True:
        raise RuntimeError('자동 처리용 HOMS 프로필 v2의 현장 검증이 필요합니다. selectors.auto.example.json을 확인하세요.')
    missing = [k for k in required if not isinstance(p.get(k), str) or not p[k].strip()]
    if missing:
        raise RuntimeError('아직 확인되지 않은 HOMS 선택자: ' + ', '.join(missing))
    url = urlparse(p['stock_url'])
    if url.scheme != 'https' or url.hostname != 'homs.biz' or url.username or url.password:
        raise RuntimeError('HOMS 페이지는 https://homs.biz 안의 URL이어야 합니다.')


class HomsAdapter:
    def __init__(self, profile, admin_url=None, profile_dir=None):
        validate_profile(profile)
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait

        self.p = profile
        self.By = By
        self.admin_url = admin_url
        self.admin_handle = None
        self.homs_handle = None
        self.prepared_item_id = None
        self.ui_completed = False

        options = Options()
        if profile_dir:
            profile_path = Path(profile_dir).resolve()
            profile_path.mkdir(parents=True, exist_ok=True)
            options.add_argument('--user-data-dir=' + str(profile_path))
        options.add_experimental_option('excludeSwitches', ['enable-logging'])

        self.driver = webdriver.Chrome(options=options)
        self.driver.maximize_window()
        self.wait = WebDriverWait(self.driver, 20)
        self._open_workspace()

    def _open_workspace(self):
        """한 Chrome 창에 관리자 탭과 HOMS 탭을 준비한다."""
        if self.admin_url:
            self.driver.get(self.admin_url)
            self.admin_handle = self.driver.current_window_handle
            self.driver.switch_to.new_window('tab')
        self.homs_handle = self.driver.current_window_handle
        self.driver.get(self.p['stock_url'])
        print('Chrome 준비 완료: HOMSelf 관리자 탭 + HOMS 탭', flush=True)
        print('HOMS는 로그인 완료 상태로 사용합니다.', flush=True)

    def _switch_or_reopen(self, handle_name, url):
        handle = getattr(self, handle_name)
        handles = self.driver.window_handles
        if handle and handle in handles:
            self.driver.switch_to.window(handle)
            return
        self.driver.switch_to.new_window('tab')
        setattr(self, handle_name, self.driver.current_window_handle)
        self.driver.get(url)

    def show_homs(self):
        self._switch_or_reopen('homs_handle', self.p['stock_url'])

    def show_admin(self, refresh=False):
        if not self.admin_url:
            return
        self._switch_or_reopen('admin_handle', self.admin_url)
        if refresh:
            self.driver.refresh()

    def unique(self, selector, xpath=False, visible=True, root=None):
        by = self.By.XPATH if xpath else self.By.CSS_SELECTOR

        def find(_):
            nodes = (root or self.driver).find_elements(by, selector)
            nodes = [e for e in nodes if not visible or e.is_displayed()]
            if len(nodes) > 1:
                raise RuntimeError('동일 선택자 요소가 여러 개입니다. 중단: ' + selector)
            return nodes[0] if nodes and (not visible or nodes[0].is_enabled()) else False

        return self.wait.until(find)

    @staticmethod
    def value(e):
        return (e.get_attribute('value') or e.text or '').strip()

    def ensure_session(self):
        """HOMS가 로그인된 상태라고 가정하고 재고조회 화면만 확인한다."""
        self.show_homs()
        self.driver.get(self.p['stock_url'])
        try:
            self.unique(self.p['stock_search_css'])
        except Exception as error:
            current = self.driver.current_url
            raise RuntimeError(
                'HOMS 재고조회 화면을 확인할 수 없습니다. '
                f'현재 URL: {current} / 선택자: {self.p["stock_search_css"]}'
            ) from error

    def fill(self, selector, value):
        from selenium.webdriver.common.keys import Keys
        e = self.unique(selector)
        if e.get_attribute('readonly') or e.get_attribute('disabled'):
            raise RuntimeError('입력칸이 잠겨 있습니다. 강제 해제하지 않습니다.')
        e.clear()
        e.send_keys(str(value))
        e.send_keys(Keys.TAB)
        if self.value(self.unique(selector)) != str(value):
            raise RuntimeError('입력 값 검증 실패: ' + selector)

    def prepare(self, item):
        from selenium.webdriver.common.keys import Keys
        self.ui_completed = False
        self.prepared_item_id = None
        self.show_homs()
        self.driver.get(self.p['stock_url'])

        # 1) 상품코드 입력 -> 조회
        self.fill(self.p['stock_search_css'], item['material_code'])
        self.unique(self.p['stock_query_xpath'], True).click()

        # 2) 상품코드 조회 결과 한 건(check_0) 선택
        checkbox = self.unique(self.p['stock_checkbox_xpath'], True)
        row = checkbox.find_element(self.By.XPATH, './ancestor::tr[1]')
        if item['material_code'] not in (row.text or ''):
            raise RuntimeError('조회 결과가 요청 상품코드와 일치하지 않습니다.')
        if not checkbox.is_selected():
            checkbox.click()
        if not checkbox.is_selected():
            raise RuntimeError('조회 상품을 선택하지 못했습니다.')

        # 3) 자재별출고 팝업
        self.unique(self.p['release_open_xpath'], True).click()

        # 4) 작업자 이름 입력 후 Enter 확정
        receiver = self.unique(self.p['receiver_search_css'])
        receiver.clear()
        receiver.send_keys(item['manager_name'])
        receiver.send_keys(Keys.ENTER)
        self.wait.until(
            lambda _: self.value(self.unique(self.p['receiver_search_css'], visible=False)) == item['manager_name']
        )

        # 5) 승인 수량 입력
        self.fill(self.p['quantity_css'], item['quantity'])
        self.prepared_item_id = item['id']
        self.verify(item)

    def verify(self, item):
        if self.prepared_item_id != item['id']:
            raise RuntimeError('현재 불출 화면이 요청 항목과 연결되어 있지 않습니다.')
        receiver = self.value(self.unique(self.p['receiver_search_css'], visible=False))
        quantity = self.value(self.unique(self.p['quantity_css'], visible=False))
        if receiver != item['manager_name']:
            raise RuntimeError('불출 직전 작업자 이름 대조 실패.')
        if quantity != str(item['quantity']):
            raise RuntimeError('불출 직전 수량 대조 실패.')

    def submit_once(self, item):
        from selenium.webdriver.support import expected_conditions as EC
        self.verify(item)

        # 6) 출고 -> 확인 -> 완료 알림. 실제 출고 구간이므로 자동 재시도하지 않는다.
        self.unique(self.p['release_button_xpath'], True).click()
        self.unique(self.p['first_confirm_css']).click()
        self.unique(self.p['second_confirm_css']).click()

        # 7) 완료 알림이 닫힌 후 작업자 입력창으로 복귀했는지 확인한다.
        self.wait.until(EC.invisibility_of_element_located((self.By.CSS_SELECTOR, self.p['second_confirm_css'])))
        receiver = self.unique(self.p['receiver_search_css'])
        if not receiver.is_displayed() or not receiver.is_enabled():
            raise RuntimeError('출고 완료 후 작업자 입력 화면으로 복귀하지 않았습니다.')

        # 8) 자재별출고 팝업에서 취소를 눌러 재고조회 화면으로 복귀한다.
        close_xpath = self.p.get('release_close_xpath') or '//*[@id="stockSaveClose"]'
        self.unique(close_xpath, True).click()
        self.wait.until(EC.invisibility_of_element_located((self.By.CSS_SELECTOR, self.p['receiver_search_css'])))
        stock_search = self.unique(self.p['stock_search_css'])
        if not stock_search.is_displayed() or not stock_search.is_enabled():
            raise RuntimeError('출고 완료 후 재고조회 화면으로 복귀하지 않았습니다.')

        self.ui_completed = True
        self.prepared_item_id = None
        return {
            'source': 'homs-ui-return',
            'manager_name': item['manager_name'],
            'material_code': item['material_code'],
            'quantity': item['quantity']
        }

    def close(self):
        self.driver.quit()
