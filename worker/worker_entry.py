"""Worker entrypoint with safe Chrome profile recovery.

The normal persistent Worker Chrome profile is tried first. If ChromeDriver
reports a session-creation/profile-start failure, retry once with a fresh
Worker-only temporary profile so an old/locked profile cannot block startup.
"""
import shutil
import sys
import tempfile
from pathlib import Path

import homs_adapter
import worker


_ORIGINAL_ADAPTER = homs_adapter.HomsAdapter
_ORIGINAL_INVENTORY_SYNC = worker.execute_inventory_sync


def _error_text(error):
    parts = []
    seen = set()
    current = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        parts.append(f'{type(current).__name__}: {current}')
        current = current.__cause__ or current.__context__
    return ' / '.join(parts)


def _recoverable_chrome_start_error(error):
    text = _error_text(error).lower()
    return any(marker in text for marker in (
        'session not created',
        'chrome instance exited',
        'user data directory is already in use',
        'devtoolsactiveport',
        'cannot create default profile directory',
        'failed to create a chrome process',
    ))


class RecoveringHomsAdapter(_ORIGINAL_ADAPTER):
    PAGE_SIZE = 90
    PAGING_XPATH = '//*[@id="wrap"]/div[3]/div[2]/div[3]'

    def __init__(self, profile, admin_url=None, profile_dir=None):
        self._recovery_profile_dir = None
        try:
            super().__init__(profile, admin_url=admin_url, profile_dir=profile_dir)
            return
        except Exception as first_error:
            if not _recoverable_chrome_start_error(first_error):
                raise

            base_dir = Path(profile_dir).resolve().parent if profile_dir else Path.cwd() / 'runtime'
            base_dir.mkdir(parents=True, exist_ok=True)
            recovery_dir = Path(tempfile.mkdtemp(prefix='chrome_profile_recovery_', dir=str(base_dir)))
            self._recovery_profile_dir = recovery_dir

            print('Chrome 기본 Worker 프로필 시작 실패:', type(first_error).__name__, flush=True)
            print('프로필 충돌 가능성 감지. 새 임시 Worker 프로필로 자동 재시도합니다.', flush=True)
            print('임시 Chrome 프로필:', recovery_dir, flush=True)
            print('새 창에서는 HOMS 로그인을 다시 진행해 주세요.', flush=True)

            try:
                super().__init__(profile, admin_url=admin_url, profile_dir=recovery_dir)
            except Exception as second_error:
                shutil.rmtree(recovery_dir, ignore_errors=True)
                self._recovery_profile_dir = None
                raise RuntimeError(
                    'Chrome 자동 복구 재시도도 실패했습니다. '
                    '기본 오류: ' + _error_text(first_error) +
                    ' / 재시도 오류: ' + _error_text(second_error)
                ) from second_error

    def _inventory_page_rows(self, rows_xpath):
        """현재 HOMS 재고 페이지의 행을 브라우저 JS 한 번으로 모두 읽는다."""
        return self.driver.execute_script("""
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
        """, rows_xpath) or []

    def _inventory_page_signature(self, rows_xpath):
        """페이지 전환 완료를 빠르게 감지할 최소 시그니처."""
        return self.driver.execute_script("""
            const xp=arguments[0];
            const snap=document.evaluate(xp,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
            if(!snap.snapshotLength) return '';
            const sig=(row)=>{
              const cells=row.querySelectorAll('td');
              const stock=row.querySelector('[id^="stockCell_"]');
              return ((cells[3]&&cells[3].innerText)||'').trim()+'|'+(((stock&&(stock.value||stock.innerText))||'')+'').trim();
            };
            const first=snap.snapshotItem(0);
            const last=snap.snapshotItem(snap.snapshotLength-1);
            return String(snap.snapshotLength)+'#'+sig(first)+'#'+sig(last);
        """, rows_xpath) or ''

    def _inventory_click_page(self, target_page):
        """HOMS 페이징 영역에서 지정한 숫자 페이지를 직접 클릭한다."""
        target_page = int(target_page)
        if target_page < 2:
            return {'clicked': False}

        result = self.driver.execute_script("""
            const target=String(arguments[0]);
            const xp=arguments[1];
            const pager=document.evaluate(
              xp,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null
            ).singleNodeValue;
            if(!pager) return {clicked:false,reason:'pager-not-found'};

            const links=Array.from(pager.querySelectorAll('a'));
            let button=links.find(a=>(a.textContent||'').trim()===target);

            // 현장 확인 기준: 2페이지 버튼은 .../div[3]/a[3].
            // 숫자 텍스트 탐색이 실패할 경우 a[target+1] 위치를 보조로 사용한다.
            if(!button){
              const index=Number(target)+1;
              button=document.evaluate(
                xp+'/a['+index+']',document,null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,null
              ).singleNodeValue;
            }

            if(!button) return {clicked:false,reason:'page-link-not-found'};
            const label=(button.textContent||'').trim();
            button.click();
            return {clicked:true,label:label,target:Number(target)};
        """, target_page, self.PAGING_XPATH) or {'clicked': False}

        return result

    def sync_inventory(self):
        """HOMS 재고를 90개 단위로 읽고 필요한 만큼 숫자 페이지를 순서대로 누른다."""
        from selenium.webdriver.support.ui import WebDriverWait

        self.show_homs()
        self.driver.get(self.p['stock_url'])
        self.unique(self.p['stock_search_css'])

        rows_xpath='//*[@id="wrap"]/div[3]/div[2]/table/tbody/tr'
        header_xpath='//*[@id="wrap"]/div[3]/div[2]/table/thead/tr/th[1]'

        self._select_visible('//*[@id="srcDisplayYn"]','전체')
        self.unique('//*[@id="frm"]/div[1]/table/tbody/tr[1]/td[4]/a[1]',True).click()
        self.unique(header_xpath,True)
        WebDriverWait(self.driver,20,poll_frequency=0.1).until(
            lambda _: self._inventory_page_signature(rows_xpath)
        )

        self._select_page_size_90()

        stable={'signature':'','same':0}
        def page_stable(_):
            signature=self._inventory_page_signature(rows_xpath)
            if signature and signature==stable['signature']:
                stable['same']+=1
            else:
                stable['signature']=signature
                stable['same']=0
            return bool(signature) and stable['same']>=2

        WebDriverWait(self.driver,20,poll_frequency=0.15).until(page_stable)

        result=[]
        seen_codes=set()
        seen_pages=set()
        page_number=1

        while page_number<=50:
            signature=self._inventory_page_signature(rows_xpath)
            if not signature:
                raise RuntimeError('HOMS 재고조회 페이지가 비어 있습니다.')
            if signature in seen_pages:
                raise RuntimeError('HOMS 재고조회 페이지가 반복되어 전체 조회를 중단합니다.')
            seen_pages.add(signature)

            raw_rows=self._inventory_page_rows(rows_xpath)
            page_added=0
            for raw in raw_rows:
                code,name,specification=self._parse_material_cell(raw.get('material_text',''))
                if code in seen_codes:
                    raise RuntimeError('재고조회 결과에 상품코드가 중복됐습니다: '+code)
                seen_codes.add(code)
                result.append({
                    'material_code':code,
                    'material_name':name,
                    'specification':specification,
                    'stock_quantity':homs_adapter.parse_inventory_stock(raw.get('stock_text',''))
                })
                page_added+=1

            print(
                f'재고조회 {page_number}페이지: {page_added}건 / 누적 {len(result)}건',
                flush=True
            )

            if page_added < self.PAGE_SIZE:
                break

            next_page=page_number+1
            moved=self._inventory_click_page(next_page)
            if not moved.get('clicked'):
                print(f'재고조회 {next_page}페이지 없음 / 누적 {len(result)}건',flush=True)
                break

            previous=signature
            WebDriverWait(self.driver,10,poll_frequency=0.1).until(
                lambda _: self._inventory_page_signature(rows_xpath) not in ('',previous)
            )
            page_number=next_page

        if page_number>50:
            raise RuntimeError('HOMS 재고조회 페이지 수가 비정상적으로 많아 중단합니다.')
        if not result:
            raise RuntimeError('HOMS 재고조회 결과를 한 건도 읽지 못했습니다.')

        print(
            'HOMS 전체 재고조회 완료:',
            len(result),'건 /',page_number,'페이지',
            flush=True
        )
        return result

    def sync_inventory_codes(self, material_codes):
        """일괄불출 완료 후 실제 불출된 상품코드만 HOMS에서 다시 조회한다."""
        from selenium.webdriver.support.ui import WebDriverWait

        codes=[]
        for value in material_codes or []:
            code=str(value).strip()
            if code and code not in codes:
                codes.append(code)
        if not codes:
            return []

        self.show_homs()
        self.driver.get(self.p['stock_url'])
        self.unique(self.p['stock_search_css'])
        rows_xpath='//*[@id="wrap"]/div[3]/div[2]/table/tbody/tr'
        result=[]

        for index,code in enumerate(codes,1):
            self.fill(self.p['stock_search_css'],code)
            self.unique(self.p['stock_query_xpath'],True).click()

            def matching_row(_):
                for raw in self._inventory_page_rows(rows_xpath):
                    try:
                        parsed=self._parse_material_cell(raw.get('material_text',''))
                    except Exception:
                        continue
                    if parsed[0]==code:
                        return raw,parsed
                return False

            raw,(parsed_code,name,specification)=WebDriverWait(
                self.driver,10,poll_frequency=0.1
            ).until(matching_row)
            result.append({
                'material_code':parsed_code,
                'material_name':name,
                'specification':specification,
                'stock_quantity':homs_adapter.parse_inventory_stock(raw.get('stock_text',''))
            })
            print(
                f'배치 재고 확인 {index}/{len(codes)}: {parsed_code} = {result[-1]["stock_quantity"]}',
                flush=True
            )

        return result

    def close(self):
        recovery_dir = self._recovery_profile_dir
        try:
            super().close()
        finally:
            if recovery_dir:
                shutil.rmtree(recovery_dir, ignore_errors=True)


def _execute_inventory_sync(api,adapter,sync_state,cfg):
    if sync_state.get('scope')!='batch':
        return _ORIGINAL_INVENTORY_SYNC(api,adapter,sync_state,cfg)

    request_id=sync_state.get('request_id')
    if not request_id:
        raise RuntimeError('재고 동기화 요청번호가 없습니다.')
    codes=[]
    for value in sync_state.get('material_codes') or []:
        code=str(value).strip()
        if code and code not in codes:
            codes.append(code)
    if not codes:
        print('일괄불출 완료 후 재조회할 실제 불출 자재가 없습니다.',flush=True)
        try:
            result=api.post('inventory-sync',{'request_id':request_id,'items':[]})
            print('빈 배치 재고 동기화 완료 처리:',result.get('count',0),'건',flush=True)
            return True
        except worker.HTTPFailure as error:
            if error.status!=400:
                print('빈 배치 재고 동기화 완료 응답 확인 실패:',type(error).__name__,str(error),flush=True)
                return False
            try:
                api.post('inventory-sync/fail',{
                    'request_id':request_id,
                    'error':'실제 불출 자재 없음 - 재조회 없이 배치 동기화 종료'
                })
                print('구버전 서버 호환 처리: 빈 배치 동기화 반복을 종료했습니다.',flush=True)
                return True
            except Exception as fallback_error:
                print('빈 배치 동기화 종료 처리 실패:',type(fallback_error).__name__,str(fallback_error),flush=True)
                return False
        except Exception as error:
            print('빈 배치 재고 동기화 완료 처리 실패:',type(error).__name__,str(error),flush=True)
            return False

    print('일괄불출 재고 확인 시작:',len(codes),'개 자재만 HOMS 재조회',flush=True)
    try:
        rows=adapter.sync_inventory_codes(codes)
        result=api.post('inventory-sync',{'request_id':request_id,'items':rows})
        print('일괄불출 재고 반영 완료:',result.get('count',len(rows)),'건',flush=True)
        return True
    except BaseException as error:
        try:
            api.post('inventory-sync/fail',{
                'request_id':request_id,
                'error':f'{type(error).__name__}: {error}'
            })
        except Exception:
            pass
        print('일괄불출 재고 확인 실패:',type(error).__name__,str(error),flush=True)
        return False
    finally:
        try:
            adapter.show_admin(refresh=False)
        except Exception:
            pass


def main():
    homs_adapter.HomsAdapter = RecoveringHomsAdapter
    worker.execute_inventory_sync = _execute_inventory_sync
    try:
        worker.main()
    except (Exception, KeyboardInterrupt) as error:
        print(
            '중단:',
            str(error) if not isinstance(error, KeyboardInterrupt) else '사용자 중단',
            flush=True
        )
        print('처리 중인 항목은 관리자 화면과 HOMS 내역을 대조하세요. journal.sqlite를 삭제하지 마세요.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
