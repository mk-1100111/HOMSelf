"""Synchronize missing material images from HOMS into the private HOMSelf-data repository."""
import base64
import time
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import TimeoutException
from catalog_persistence import load_catalog, save_catalog, save_material_image

SEARCH_XPATH='//*[@id="_searchBar"]'
IMAGE_XPATH='//*[@id="spl_thum_0_0"]/img'


def _ready_image(adapter):
    nodes=adapter.driver.find_elements(adapter.By.XPATH,IMAGE_XPATH)
    if len(nodes)!=1:return False
    image=nodes[0]
    if not image.is_displayed():return False
    src=(image.get_attribute('src') or '').strip()
    if not src:return False
    try:
        width=adapter.driver.execute_script('return arguments[0].naturalWidth||arguments[0].width||0;',image)
        height=adapter.driver.execute_script('return arguments[0].naturalHeight||arguments[0].height||0;',image)
        if int(width or 0)<2 or int(height or 0)<2:return False
    except Exception:
        pass
    return image


def _capture_material_image(adapter,material_code):
    adapter.show_homs()
    search=adapter.unique(SEARCH_XPATH,xpath=True)
    search.clear();search.send_keys(str(material_code));search.send_keys(Keys.ENTER)
    wait=WebDriverWait(adapter.driver,15,poll_frequency=0.35)
    try:image=wait.until(lambda _: _ready_image(adapter))
    except TimeoutException:return None,''
    src=(image.get_attribute('src') or '').strip()
    if not src:return None,''
    time.sleep(0.25)
    png=image.screenshot_as_png
    return (png,src) if png else (None,src)


def execute_image_sync(api,adapter,cfg,state):
    request_id=str(state.get('request_id') or '')
    if not request_id:raise RuntimeError('이미지 동기화 요청번호가 없습니다.')
    api.post('material-image-sync/start',{'request_id':request_id})
    catalog,sha,repository,branch,token=load_catalog(cfg)
    server_targets={str(item.get('material_code')) for item in (state.get('materials') or []) if isinstance(item,dict)}
    targets=[item for item in catalog.get('materials',[]) if isinstance(item,dict) and str(item.get('material_code')) in server_targets and not item.get('image_data') and not item.get('image_path')]
    print('이미지 동기화 시작:',len(targets),'건',flush=True)
    updated=0;skipped=0
    try:
        for index,item in enumerate(targets,1):
            code=str(item.get('material_code','')).strip()
            print(f'이미지 조회 {index}/{len(targets)}:',code,flush=True)
            try:
                png,src=_capture_material_image(adapter,code)
                if not png:
                    skipped+=1;print('이미지 없음 - 건너뜀:',code,flush=True);continue
                path,commit=save_material_image(cfg,code,png,'png')
                item['image_path']=path
                data='data:image/png;base64,'+base64.b64encode(png).decode('ascii')
                api.post('catalog-image-apply',{'material_code':code,'image_path':path,'image_data':data})
                updated+=1
                print('이미지 GitHub/서버 반영:',code,path,commit,flush=True)
            except Exception as error:
                skipped+=1;print('이미지 처리 건너뜀:',code,type(error).__name__,str(error),flush=True)
            time.sleep(0.35)
        if updated:
            result=save_catalog(cfg,catalog,sha,repository,branch,token,'Update HOMSelf material image paths')
            print('이미지 catalog GitHub 저장 완료:',result.get('commit',{}).get('sha',''),flush=True)
        api.post('material-image-sync/complete',{'request_id':request_id,'updated':updated,'skipped':skipped})
        print('이미지 동기화 완료:',updated,'건 / 건너뜀',skipped,'건',flush=True)
        return {'updated':updated,'skipped':skipped}
    except BaseException as error:
        try:api.post('material-image-sync/fail',{'request_id':request_id,'error':f'{type(error).__name__}: {error}'})
        except Exception:pass
        raise
    finally:
        try:adapter.show_admin(refresh=False)
        except Exception:pass
