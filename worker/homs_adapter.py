"""Automatic HOMS UI adapter for the company PC browser workspace."""
import re
import time
from pathlib import Path
from urllib.parse import urlparse


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
        """현재 화면 탭을 바꾸지 않고 Chrome 브라우저 컨텍스트에서 HOMS 세션을 갱신한다."""
        current_handle = self.driver.current_window_handle
        if not self.homs_handle or self.homs_handle not in self.driver.window_handles:
            return {'ok': False, 'status': 0, 'url': ''}
        try:
            self.driver.switch_to.window(self.homs_handle)
            result = self.driver.execute_async_script("""
                const url = arguments[0];
                const done = arguments[arguments.length - 1];
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 12000);
                fetch(url, {
                    method: 'GET',
                    credentials: 'include',
                    cache: 'no-store',
                    signal: controller.signal,
                    headers: {'X-Requested-With': 'XMLHttpRequest'}
                }).then(response => {
                    clearTimeout(timer);
                    done({ok: response.ok, status: response.status, url: response.url || url});
                }).catch(error => {
                    clearTimeout(timer);
                    done({ok: false, status: 0, url: url, error: String(error)});
                });
            """, self.p['stock_url'])
            if not result or not result.get('ok'):
                raise RuntimeError('Chrome HOMS 세션 유지 실패: ' + str((result or {}).get('error') or (result or {}).get('status') or 'unknown'))
            return result
        finally:
            if current_handle in self.driver.window_handles:
                self.driver.switch_to.window(current_handle)

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
        from selenium.common.exceptions import StaleElementReferenceException
        last=''
        for attempt in range(8):
            try:
                element = self.unique(xpath, True)
                select = Select(element)
                try:
                    select.select_by_visible_text(wanted)
                except Exception:
                    option = next((o for o in select.options if wanted in (o.text or '').strip()), None)
                    if not option:
                        raise RuntimeError('선택값을 찾지 못했습니다: ' + wanted)
                    select.select_by_value(option.get_attribute('value'))
                time.sleep(0.2)
                current = Select(self.unique(xpath, True))
                last = (current.first_selected_option.text or '').strip()
                if wanted in last:
                    return
            except StaleElementReferenceException:
                pass
            if attempt < 7:
                time.sleep(0.35)
        raise RuntimeError('선택값 적용 실패: ' + wanted + ' / 현재값: ' + (last or '확인 불가'))

    def _select_page_size_90(self):
        """조회 결과가 생성된 뒤 option[3](90개씩보기)을 선택한다."""
        script = """
            const xp = arguments[0];
            const node = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (!node) return {ok:false,error:'select not found'};
            const options = Array.from(node.options || []);
            if (options.length < 3) return {ok:false,error:'option[3] not found'};
            const option = options[2];
            const text = (option.textContent || '').trim();
            if (!text.includes('90')) return {ok:false,error:'option[3] text='+text};
            node.selectedIndex = 2;
            option.selected = true;
            node.dispatchEvent(new Event('input',{bubbles:true}));
            node.dispatchEvent(new Event('change',{bubbles:true}));
            return {ok:true,text:text,value:node.value};
        """
        select_xpath='//*[@id="frm"]/div[2]/div[2]/select'
        last=''
        for attempt in range(10):
            result=self.driver.execute_script(script,select_xpath) or {}
            if result.get('ok'):
                time.sleep(0.5)
                current=self.driver.execute_script("""
                    const xp=arguments[0];
                    const node=document.evaluate(xp,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
                    return node && node.options && node.selectedIndex >= 0 ? (node.options[node.selectedIndex].textContent||'').trim() : '';
                """,select_xpath)
                last=str(current or '').strip()
                if '90' in last:
                    print('재고조회 표시건수 확인:',last,flush=True)
                    return
            else:
                last=str(result.get('error') or '')
            if attempt < 9:
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
        self.show_homs()
        self.driver.get(self.p['stock_url'])
        self.unique(self.p['stock_search_css'])

        rows_xpath='//*[@id="wrap"]/div[3]/div[2]/table/tbody/tr'
        header_xpath='//*[@id="wrap"]/div[3]/div[2]/table/thead/tr/th[1]'

        self._select_visible('//*[@id="srcDisplayYn"]','전체')
        time.sleep(0.5)
        self.unique('//*[@id="frm"]/div[1]/table/tbody/tr[1]/td[4]/a[1]',True).click()
        self.unique(header_xpath,True)
        WebDriverWait(self.driver,20).until(
            lambda _: self.driver.execute_script(
                "return document.evaluate(arguments[0],document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength;",
                rows_xpath
            ) > 0
        )
        initial_count=self.driver.execute_script(
            "return document.evaluate(arguments[0],document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength;",
            rows_xpath
        )
        print('재고조회 1차 결과:',initial_count,'건 / 90개 보기 적용',flush=True)

        self._select_page_size_90()
        stable={'count':-1,'same':0}
        def rows_stable(_):
            count=self.driver.execute_script(
                "return document.evaluate(arguments[0],document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength;",
                rows_xpath
            )
            if count > 0 and count == stable['count']:
                stable['same'] += 1
            else:
                stable['count'] = count
                stable['same'] = 0
            return count > 0 and stable['same'] >= 2
        WebDriverWait(self.driver,20,poll_frequency=0.4).until(rows_stable)
        time.sleep(0.4)
        print('재고조회 최종 결과:',stable['count'],'건',flush=True)

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
        row_text = row.text or ''
        code_pattern = r'(?<![A-Za-z0-9_-])' + re.escape(str(item['material_code'])) + r'(?![A-Za-z0-9_-])'
        if not re.search(code_pattern, row_text):
            raise RuntimeError('조회 결과가 요청 상품코드와 정확히 일치하지 않습니다.')
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
