"""Automatic HOMS UI adapter for the company PC browser workspace."""
import re
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class MissingStockResult(RuntimeError):
    """HOMS 조회 결과에 출고 대상 체크박스가 없는 경우."""


def parse_stock(value):
    value = str(value).strip()
    if not re.fullmatch(r'\d+|\d{1,3}(?:,\d{3})+', value):
        raise RuntimeError('수량 표시를 정확하게 해석할 수 없습니다.')
    return int(value.replace(',', ''))


def parse_inventory_stock(value):
    """10(1,000) 형태는 괄호 안 수량을 실제 재고로 사용한다."""
    value = str(value).strip()
    match = re.search(r'\(([\d,]+)\)', value)
    if match:
        return parse_stock(match.group(1))
    match = re.search(r'[\d,]+', value)
    if not match:
        raise RuntimeError('현재재고 표시를 해석할 수 없습니다: ' + value)
    return parse_stock(match.group(0))


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
        options.add_experimental_option('excludeSwitches', ['enable-automation', 'enable-logging'])
        options.add_experimental_option('useAutomationExtension', False)

        self.driver = webdriver.Chrome(options=options)
        self.driver.maximize_window()
        self.wait = WebDriverWait(self.driver, 20)
        self._open_workspace()

    def _open_workspace(self):
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

    def keep_alive(self):
        """현재 브라우저 탭을 건드리지 않고 HOMS 로그인 쿠키로 백그라운드 GET을 보낸다."""
        host = urlparse(self.p['stock_url']).hostname or 'homs.biz'
        try:
            raw = self.driver.execute_cdp_cmd('Network.getAllCookies', {})
            cookies = raw.get('cookies', [])
        except Exception as error:
            raise RuntimeError('Chrome HOMS 세션 쿠키를 읽지 못했습니다.') from error

        pairs = []
        for cookie in cookies:
            domain = str(cookie.get('domain') or '').lstrip('.')
            if host == domain or host.endswith('.' + domain):
                name = cookie.get('name')
                value = cookie.get('value')
                if name and value is not None:
                    pairs.append(f'{name}={value}')
        if not pairs:
            raise RuntimeError('HOMS 로그인 쿠키를 찾지 못했습니다.')

        request = Request(
            self.p['stock_url'],
            method='GET',
            headers={
                'Cookie': '; '.join(pairs),
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'User-Agent': 'Mozilla/5.0 HOMSelf-Session-KeepAlive'
            }
        )
        with urlopen(request, timeout=15) as response:
            final_url = response.geturl()
            return {'ok': 200 <= response.status < 400,'status': response.status,'url': final_url}

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
        self.show_homs()
        self.driver.get(self.p['stock_url'])
        try:
            self.unique(self.p['stock_search_css'])
        except Exception as error:
            current = self.driver.current_url
            raise RuntimeError('HOMS 재고조회 화면을 확인할 수 없습니다. '
                               f'현재 URL: {current} / 선택자: {self.p["stock_search_css"]}') from error

    def _select_visible(self, xpath, wanted):
        from selenium.webdriver.support.ui import Select
        element = self.unique(xpath, True)
        select = Select(element)
        try:
            select.select_by_visible_text(wanted)
        except Exception:
            option = next((o for o in select.options if wanted in (o.text or '').strip()), None)
            if not option:
                raise RuntimeError('선택값을 찾지 못했습니다: ' + wanted)
            select.select_by_value(option.get_attribute('value'))
        selected = (select.first_selected_option.text or '').strip()
        if wanted not in selected:
            raise RuntimeError('선택값 적용 실패: ' + wanted + ' / 현재값: ' + selected)

    def _select_page_size_90(self):
        """HOMS 표시건수를 option[3](90개씩보기)로 선택하고 실제 선택 상태까지 검증한다."""
        from selenium.webdriver.support.ui import Select
        from selenium.common.exceptions import StaleElementReferenceException
        select_xpath='//*[@id="frm"]/div[2]/div[2]/select'
        option_xpath='//*[@id="frm"]/div[2]/div[2]/select/option[3]'
        last=''
        for attempt in range(8):
            try:
                option=self.unique(option_xpath,True)
                value=option.get_attribute('value')
                text=(option.text or '').strip()
                if '90' not in text:
                    raise RuntimeError('option[3]이 90개씩보기가 아닙니다: '+text)
                select=Select(self.unique(select_xpath,True))
                if value:
                    select.select_by_value(value)
                else:
                    select.select_by_index(2)
                time.sleep(0.35)
                current=Select(self.unique(select_xpath,True))
                last=(current.first_selected_option.text or '').strip()
                if '90' in last:
                    print('재고조회 표시건수 확인:',last,flush=True)
                    return
            except StaleElementReferenceException:
                pass
            if attempt < 7:
                time.sleep(0.5)
        raise RuntimeError('90개씩보기 적용 실패 / 현재값: '+(last or '확인 불가'))

    @staticmethod
    def _parse_material_cell(text):
        lines=[line.strip() for line in str(text).splitlines() if line.strip()]
        if not lines:
            raise RuntimeError('상품코드/상품명/규격 셀이 비어 있습니다.')
        def clean_label(value):
            return re.sub(r'^(상품코드|상품명|규격)\s*[:：]?\s*','',value).strip()
        lines=[clean_label(line) for line in lines if clean_label(line)]
        if len(lines)>=2:
            code=lines[0]
            name=lines[1]
            specification=' / '.join(lines[2:])
        else:
            match=re.search(r'([A-Za-z0-9_-]{4,80})', lines[0])
            if not match:
                raise RuntimeError('상품코드를 해석할 수 없습니다: ' + lines[0])
            code=match.group(1)
            remainder=(lines[0][:match.start()]+lines[0][match.end():]).strip(' /|-')
            name=remainder or code
            specification=''
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',code):
            match=re.search(r'([A-Za-z0-9_-]{4,80})',code)
            if not match:
                raise RuntimeError('상품코드 형식이 잘못됐습니다: ' + code)
            code=match.group(1)
        return code,name,specification

    def sync_inventory(self):
        """HOMS 전체 재고를 읽어 서버 동기화용 목록으로 반환한다."""
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support.ui import Select
        self.show_homs()
        self.driver.get(self.p['stock_url'])
        self.unique(self.p['stock_search_css'])

        self._select_visible('//*[@id="srcDisplayYn"]','전체')
        time.sleep(0.8)
        self._select_page_size_90()
        page_size=(Select(self.unique('//*[@id="frm"]/div[2]/div[2]/select',True)).first_selected_option.text or '').strip()
        if '90' not in page_size:
            raise RuntimeError('조회 직전 표시건수가 90개가 아닙니다: '+page_size)

        self.unique('//*[@id="frm"]/div[1]/table/tbody/tr[1]/td[4]/a[1]',True).click()
        self.unique('//*[@id="wrap"]/div[3]/div[2]/table/thead/tr/th[1]',True)

        rows_xpath='//*[@id="wrap"]/div[3]/div[2]/table/tbody/tr'
        WebDriverWait(self.driver,20).until(
            lambda _: self.driver.execute_script(
                "return document.evaluate(arguments[0],document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength;",
                rows_xpath
            ) > 0
        )
        time.sleep(0.5)

        raw_rows=self.driver.execute_script("""
            const xp=arguments[0];
            const snap=document.evaluate(xp,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
            const out=[];
            for(let i=0;i<snap.snapshotLength;i++){
              const row=snap.snapshotItem(i);
              const cells=row.querySelectorAll('td');
              if(cells.length<4) continue;
              const stock=row.querySelector('[id^="stockCell_"]');
              if(!stock) continue;
              out.push({
                material_text:(cells[3].innerText||'').trim(),
                stock_text:((stock.value||stock.innerText||'')+'').trim()
              });
            }
            return out;
        """,rows_xpath)

        result=[]
        seen=set()
        for raw in raw_rows:
            code,name,specification=self._parse_material_cell(raw.get('material_text',''))
            if code in seen:
                raise RuntimeError('재고조회 결과에 상품코드가 중복됐습니다: '+code)
            seen.add(code)
            result.append({
                'material_code':code,
                'material_name':name,
                'specification':specification,
                'stock_quantity':parse_inventory_stock(raw.get('stock_text',''))
            })
        if not result:
            raise RuntimeError('HOMS 재고조회 결과를 한 건도 읽지 못했습니다.')
        return result

    def fill(self, selector, value):
        from selenium.webdriver.common.keys import Keys
        e = self.unique(selector)
        if e.get_attribute('readonly') or e.get_attribute('disabled'):
            raise RuntimeError('입력칸이 잠겨 있습니다. 강제 해제하지 않습니다.')
        e.clear();e.send_keys(str(value));e.send_keys(Keys.TAB)
        if self.value(self.unique(selector)) != str(value):
            raise RuntimeError('입력 값 검증 실패: ' + selector)

    def prepare(self, item):
        from selenium.webdriver.common.keys import Keys
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.common.exceptions import TimeoutException
        self.ui_completed = False
        self.prepared_item_id = None
        self.show_homs()
        self.driver.get(self.p['stock_url'])

        self.fill(self.p['stock_search_css'], item['material_code'])
        self.unique(self.p['stock_query_xpath'], True).click()

        try:
            checkbox = WebDriverWait(self.driver, 3).until(
                lambda _: next((e for e in self.driver.find_elements(self.By.XPATH, self.p['stock_checkbox_xpath'])
                                if e.is_displayed() and e.is_enabled()), False)
            )
        except TimeoutException as error:
            raise MissingStockResult(f'HOMS 조회 결과 없음: {item["material_code"]}') from error

        row = checkbox.find_element(self.By.XPATH, './ancestor::tr[1]')
        if item['material_code'] not in (row.text or ''):
            raise RuntimeError('조회 결과가 요청 상품코드와 일치하지 않습니다.')
        if not checkbox.is_selected():checkbox.click()
        if not checkbox.is_selected():raise RuntimeError('조회 상품을 선택하지 못했습니다.')

        self.unique(self.p['release_open_xpath'], True).click()
        receiver = self.unique(self.p['receiver_search_css'])
        receiver.clear();receiver.send_keys(item['manager_name']);receiver.send_keys(Keys.ENTER)
        self.wait.until(lambda _: self.value(self.unique(self.p['receiver_search_css'], visible=False)) == item['manager_name'])
        self.fill(self.p['quantity_css'], item['quantity'])
        self.prepared_item_id = item['id']
        self.verify(item)

    def verify(self, item):
        if self.prepared_item_id != item['id']:
            raise RuntimeError('현재 불출 화면이 요청 항목과 연결되어 있지 않습니다.')
        receiver = self.value(self.unique(self.p['receiver_search_css'], visible=False))
        quantity = self.value(self.unique(self.p['quantity_css'], visible=False))
        if receiver != item['manager_name']:raise RuntimeError('불출 직전 작업자 이름 대조 실패.')
        if quantity != str(item['quantity']):raise RuntimeError('불출 직전 수량 대조 실패.')

    def submit_once(self, item):
        from selenium.webdriver.support import expected_conditions as EC
        self.verify(item)
        self.unique(self.p['release_button_xpath'], True).click()
        self.unique(self.p['first_confirm_css']).click()
        self.unique(self.p['second_confirm_css']).click()
        self.wait.until(EC.invisibility_of_element_located((self.By.CSS_SELECTOR, self.p['second_confirm_css'])))
        receiver = self.unique(self.p['receiver_search_css'])
        if not receiver.is_displayed() or not receiver.is_enabled():
            raise RuntimeError('출고 완료 후 작업자 입력 화면으로 복귀하지 않았습니다.')
        close_xpath = self.p.get('release_close_xpath') or '//*[@id="stockSaveClose"]'
        self.unique(close_xpath, True).click()
        self.wait.until(EC.invisibility_of_element_located((self.By.CSS_SELECTOR, self.p['receiver_search_css'])))
        stock_search = self.unique(self.p['stock_search_css'])
        if not stock_search.is_displayed() or not stock_search.is_enabled():
            raise RuntimeError('출고 완료 후 재고조회 화면으로 복귀하지 않았습니다.')
        self.ui_completed = True
        self.prepared_item_id = None
        return {'source':'homs-ui-return','manager_name':item['manager_name'],
                'material_code':item['material_code'],'quantity':item['quantity']}

    def close(self):
        self.driver.quit()
