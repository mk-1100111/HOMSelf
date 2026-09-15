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

    def _inventory_click_next_page(self):
        """HOMS 페이징 UI에서 다음 페이지를 찾아 JS 클릭한다."""
        return self.driver.execute_script("""
            const scope=document.querySelector('#wrap > div:nth-child(3)') || document.querySelector('#wrap') || document;
            const visible=(el)=>{
              if(!el) return false;
              const s=getComputedStyle(el);
              const r=el.getBoundingClientRect();
              if(s.display==='none'||s.visibility==='hidden'||r.width===0||r.height===0) return false;
              const cls=((el.className||'')+' '+((el.parentElement&&el.parentElement.className)||'')).toLowerCase();
              return !el.disabled && el.getAttribute('aria-disabled')!=='true' && !/disabled|disable/.test(cls);
            };
            const label=(el)=>((el.textContent||el.value||el.getAttribute('title')||el.getAttribute('aria-label')||'')+'').trim();
            const meta=(el)=>[
              el.id||'', el.className||'', el.getAttribute('href')||'', el.getAttribute('onclick')||'',
              (el.parentElement&&el.parentElement.id)||'', (el.parentElement&&el.parentElement.className)||''
            ].join(' ');
            const controls=Array.from(scope.querySelectorAll('a,button,input[type="button"],input[type="submit"]')).filter(visible);
            const pager=controls.filter(el=>{
              const text=label(el);
              const info=meta(el);
              const ancestry=[];
              let p=el.parentElement;
              for(let i=0;p&&i<4;i++,p=p.parentElement) ancestry.push((p.id||'')+' '+(p.className||''));
              return /page|paging|pager|paginate/i.test(info+' '+ancestry.join(' ')) || /^(다음|next|>|›|»|\d+)$/i.test(text);
            });

            let next=pager.find(el=>/^(다음|next|>|›|»)$/i.test(label(el)));
            if(!next) next=pager.find(el=>/next|goNext|nextPage/i.test(meta(el)));

            if(!next){
              let current=0;
              const pageFields=Array.from(document.querySelectorAll('input,select')).filter(el=>/page|paging|pager/i.test((el.id||'')+' '+(el.name||'')));
              for(const el of pageFields){
                const n=parseInt(el.value,10);
                if(Number.isFinite(n)&&n>0){current=n;break;}
              }
              if(!current){
                const currentNodes=Array.from(scope.querySelectorAll('[aria-current="page"],.active,.on,.current,strong,b'));
                for(const el of currentNodes){
                  const n=parseInt((el.textContent||'').trim(),10);
                  if(Number.isFinite(n)&&n>0){current=n;break;}
                }
              }
              if(!current) current=1;
              const numbered=pager.map(el=>({el,n:parseInt(label(el),10)}))
                .filter(x=>Number.isFinite(x.n)&&x.n>current)
                .sort((a,b)=>a.n-b.n);
              if(numbered.length) next=numbered[0].el;
            }

            if(!next) return {clicked:false};
            const text=label(next);
            const info=meta(next);
            next.click();
            return {clicked:true,label:text,meta:info.slice(0,200)};
        """) or {'clicked': False}

    def sync_inventory(self):
        """90개 단위로 HOMS 모든 재고 페이지를 빠르게 순회해 전체 목록을 반환한다."""
        from selenium.webdriver.support.ui import WebDriverWait

        self.show_homs()
        self.driver.get(self.p['stock_url'])
        self.unique(self.p['stock_search_css'])

        rows_xpath='//*[@id="wrap"]/div[3]/div[2]/table/tbody/tr'
        header_xpath='//*[@id="wrap"]/div[3]/div[2]/table/thead/tr/th[1]'

        self._select_visible('//*[@id="srcDisplayYn"]','전체')
        self.unique('//*[@id="frm"]/div[1]/table/tbody/tr[1]/td[4]/a[1]',True).click()
        self.unique(header_xpath,True)
        WebDriverWait(self.driver,20,poll_frequency=0.1).until(lambda _: self._inventory_page_signature(rows_xpath))

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
            print(f'재고조회 {page_number}페이지: {page_added}건 / 누적 {len(result)}건',flush=True)

            moved=self._inventory_click_next_page()
            if not moved.get('clicked'):
                break
            previous=signature
            WebDriverWait(self.driver,10,poll_frequency=0.1).until(
                lambda _: self._inventory_page_signature(rows_xpath) not in ('',previous)
            )
            page_number+=1

        if page_number>50:
            raise RuntimeError('HOMS 재고조회 페이지 수가 비정상적으로 많아 중단합니다.')
        if not result:
            raise RuntimeError('HOMS 재고조회 결과를 한 건도 읽지 못했습니다.')
        print('HOMS 전체 재고조회 완료:',len(result),'건 /',page_number,'페이지',flush=True)
        return result

    def close(self):
        recovery_dir = self._recovery_profile_dir
        try:
            super().close()
        finally:
            if recovery_dir:
                shutil.rmtree(recovery_dir, ignore_errors=True)


def main():
    # worker.main() imports HomsAdapter at runtime, so replacing the module
    # attribute here keeps all worker business logic unchanged.
    homs_adapter.HomsAdapter = RecoveringHomsAdapter
    try:
        worker.main()
    except (Exception, KeyboardInterrupt) as error:
        print('중단:', str(error) if not isinstance(error, KeyboardInterrupt) else '사용자 중단', flush=True)
        print('처리 중인 항목은 관리자 화면과 HOMS 내역을 대조하세요. journal.sqlite를 삭제하지 마세요.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())