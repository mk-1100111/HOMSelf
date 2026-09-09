"""Persist HOMSelf static catalog metadata to the authorized private HOMSelf-data repository.

Stock quantities are intentionally excluded. Images crawled by homs_catalog_crawler.py
are stored in HOMSelf/public/static/img/material_list and are not duplicated here.
"""
import base64
import json
import os
from urllib.parse import quote
from common import http

ALLOWED_REPOSITORY='mk-1100111/HOMSelf-data'
CATALOG_PATH='config/catalog.json'


def _settings(cfg):
    repository=cfg.get('backup_repository')
    branch=cfg.get('backup_branch','main')
    if repository!=ALLOWED_REPOSITORY:
        raise RuntimeError('영구 부자재 저장소는 mk-1100111/HOMSelf-data만 허용합니다.')
    token=os.environ.get('HOMSELF_BACKUP_GITHUB_TOKEN','')
    if not token:
        raise RuntimeError('HOMSELF_BACKUP_GITHUB_TOKEN 환경변수가 필요합니다.')
    return repository,branch,token


def _repo_base(repository):
    return 'https://api.github.com/repos/'+repository


def load_catalog(cfg):
    repository,branch,token=_settings(cfg)
    base=_repo_base(repository)
    metadata=http(base,token)
    if metadata.get('private') is not True or metadata.get('full_name')!=repository:
        raise RuntimeError('비공개 HOMSelf-data 저장소를 확인하지 못했습니다.')
    result=http(base+'/contents/'+quote(CATALOG_PATH)+'?ref='+quote(branch),token)
    encoded=result.get('content','').replace('\n','')
    if result.get('encoding')!='base64' or not encoded:
        raise RuntimeError('HOMSelf-data catalog.json을 읽지 못했습니다.')
    try:
        catalog=json.loads(base64.b64decode(encoded).decode('utf-8'))
    except Exception as error:
        raise RuntimeError('HOMSelf-data catalog.json 형식이 잘못됐습니다.') from error
    if not isinstance(catalog.get('managers'),list) or not isinstance(catalog.get('materials'),list):
        raise RuntimeError('HOMSelf-data catalog.json 구조가 잘못됐습니다.')
    if not isinstance(catalog.get('manager_settings'),dict):
        catalog['manager_settings']={}
    for name in catalog['managers']:
        catalog['manager_settings'].setdefault(name,{'visible':True})
    for item in catalog['materials']:
        if isinstance(item,dict) and 'visible' not in item:
            item['visible']=True
    return catalog,result.get('sha'),repository,branch,token


def merge_inventory(catalog,inventory_rows):
    materials=catalog['materials']
    by_code={str(item.get('material_code')):item for item in materials if isinstance(item,dict)}
    added=[]
    for row in inventory_rows:
        code=str(row.get('material_code','')).strip()
        if not code:
            continue
        name=str(row.get('material_name') or code).strip()
        specification=str(row.get('specification') or '').strip()
        item=by_code.get(code)
        if item is None:
            item={'material_code':code,'material_name':name,'material_unit':1,'visible':True}
            if specification:item['specification']=specification
            materials.append(item);by_code[code]=item;added.append(item)
            continue
        item['material_name']=name
        if specification:item['specification']=specification
        else:item.pop('specification',None)
    return added


def save_catalog(cfg,catalog,sha,repository=None,branch=None,token=None,message='Update HOMSelf catalog'):
    if repository is None or branch is None or token is None:
        repository,branch,token=_settings(cfg)
    base=_repo_base(repository)
    body={'message':message,'branch':branch,'content':base64.b64encode((json.dumps(catalog,ensure_ascii=False,indent=2)+'\n').encode('utf-8')).decode('ascii')}
    if sha:body['sha']=sha
    return http(base+'/contents/'+quote(CATALOG_PATH),token,'PUT',body)


def persist_inventory_catalog(cfg,inventory_rows):
    catalog,sha,repository,branch,token=load_catalog(cfg)
    before=json.dumps(catalog.get('materials',[]),ensure_ascii=False,sort_keys=True)
    added=merge_inventory(catalog,inventory_rows)
    after=json.dumps(catalog.get('materials',[]),ensure_ascii=False,sort_keys=True)
    if before!=after:
        result=save_catalog(cfg,catalog,sha,repository,branch,token,'Sync HOMSelf material metadata from HOMS')
        commit=result.get('commit',{}).get('sha','')
        print('부자재 GitHub 영구 catalog 갱신:',len(catalog.get('materials',[])),'건',commit,flush=True)
    else:
        print('부자재 기준정보 변경 없음: GitHub catalog 변경 없음',flush=True)
    return catalog,added


def _inline_material_image_codes(catalog):
    codes=[]
    for item in catalog.get('materials',[]):
        if not isinstance(item,dict):
            continue
        image=item.get('image_data')
        if isinstance(image,str) and image.lower().startswith('data:image/'):
            codes.append(str(item.get('material_code') or '?'))
    return codes


def persist_admin_catalog(cfg,catalog):
    if not isinstance(catalog,dict) or not isinstance(catalog.get('managers'),list) or not isinstance(catalog.get('materials'),list):
        raise RuntimeError('관리자 catalog 저장 데이터가 잘못됐습니다.')
    inline_images=_inline_material_image_codes(catalog)
    if inline_images:
        sample=', '.join(inline_images[:5])
        suffix='' if len(inline_images)<=5 else f' 외 {len(inline_images)-5}건'
        raise RuntimeError(
            '관리자 사진 정적 GitHub 저장이 아직 완료되지 않았습니다. '
            'Render의 HOMSELF_APP_GITHUB_TOKEN에 HOMSelf Contents Read/Write 권한을 확인하세요. '
            f'대기 상품코드: {sample}{suffix}'
        )
    _,sha,repository,branch,token=load_catalog(cfg)
    result=save_catalog(cfg,catalog,sha,repository,branch,token,'Update HOMSelf admin catalog settings')
    return result.get('commit',{}).get('sha','')


def push_catalog_to_server(api,catalog):
    return api.post('catalog-sync',{'catalog':catalog})


def restore_persistent_catalog(api,cfg):
    catalog,_,_,_,_=load_catalog(cfg)
    result=push_catalog_to_server(api,catalog)
    print('GitHub 영구 부자재 catalog 서버 반영:',result.get('materials',result.get('count',len(catalog.get('materials',[])))),'건',flush=True)
    return catalog
