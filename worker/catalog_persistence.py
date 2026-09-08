"""Persist HOMSelf static catalog metadata to the authorized private HOMSelf-data repository.

Stock quantities are intentionally excluded. Manager/material visibility, images and
material units are long-lived catalog data; runtime HOMS stock stays on the server.
"""
import base64
import copy
import json
import os
from urllib.parse import quote
from common import http, HTTPFailure

ALLOWED_REPOSITORY='mk-1100111/HOMSelf-data'
CATALOG_PATH='config/catalog.json'
MATERIAL_IMAGE_DIR='images/materials'


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


def _contents_url(repository,path,branch=None):
    url=_repo_base(repository)+'/contents/'+quote(path)
    if branch:url+='?ref='+quote(branch)
    return url


def load_catalog(cfg):
    repository,branch,token=_settings(cfg)
    base=_repo_base(repository)
    metadata=http(base,token)
    if metadata.get('private') is not True or metadata.get('full_name')!=repository:
        raise RuntimeError('비공개 HOMSelf-data 저장소를 확인하지 못했습니다.')
    result=http(_contents_url(repository,CATALOG_PATH,branch),token)
    encoded=result.get('content','').replace('\n','')
    if result.get('encoding')!='base64' or not encoded:
        raise RuntimeError('HOMSelf-data catalog.json을 읽지 못했습니다.')
    try:
        catalog=json.loads(base64.b64decode(encoded).decode('utf-8'))
    except Exception as error:
        raise RuntimeError('HOMSelf-data catalog.json 형식이 잘못됐습니다.') from error
    if not isinstance(catalog.get('managers'),list) or not isinstance(catalog.get('materials'),list):
        raise RuntimeError('HOMSelf-data catalog.json 구조가 잘못됐습니다.')
    if not isinstance(catalog.get('manager_settings'),dict):catalog['manager_settings']={}
    for name in catalog['managers']:catalog['manager_settings'].setdefault(name,{'visible':True})
    for item in catalog['materials']:
        if isinstance(item,dict) and 'visible' not in item:item['visible']=True
    return catalog,result.get('sha'),repository,branch,token


def merge_inventory(catalog,inventory_rows):
    materials=catalog['materials']
    known={str(item.get('material_code')) for item in materials if isinstance(item,dict)}
    added=[]
    for row in inventory_rows:
        code=str(row.get('material_code','')).strip()
        if not code or code in known:continue
        item={'material_code':code,'material_name':str(row.get('material_name') or code).strip(),'material_unit':1,'visible':True}
        specification=str(row.get('specification') or '').strip()
        if specification:item['specification']=specification
        materials.append(item);known.add(code);added.append(item)
    return added


def save_catalog(cfg,catalog,sha,repository=None,branch=None,token=None,message='Update HOMSelf catalog'):
    if repository is None or branch is None or token is None:repository,branch,token=_settings(cfg)
    body={'message':message,'branch':branch,'content':base64.b64encode((json.dumps(catalog,ensure_ascii=False,indent=2)+'\n').encode('utf-8')).decode('ascii')}
    if sha:body['sha']=sha
    return http(_contents_url(repository,CATALOG_PATH),token,'PUT',body)


def save_material_image(cfg,material_code,image_bytes,extension='png'):
    repository,branch,token=_settings(cfg)
    code=str(material_code).strip()
    if not code or any(ch not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for ch in code):
        raise RuntimeError('이미지 저장 상품코드 형식이 잘못됐습니다.')
    if not isinstance(image_bytes,(bytes,bytearray)) or not image_bytes:
        raise RuntimeError('저장할 이미지 데이터가 없습니다.')
    ext='jpg' if extension.lower() in ('jpg','jpeg') else 'png'
    path=f'{MATERIAL_IMAGE_DIR}/{code}.{ext}'
    sha=None
    try:
        existing=http(_contents_url(repository,path,branch),token)
        sha=existing.get('sha')
    except HTTPFailure as error:
        if error.status!=404:raise
    body={'message':f'Update HOMSelf material image {code}','branch':branch,'content':base64.b64encode(bytes(image_bytes)).decode('ascii')}
    if sha:body['sha']=sha
    result=http(_contents_url(repository,path),token,'PUT',body)
    return path,result.get('commit',{}).get('sha','')


def load_repo_file_bytes(cfg,path):
    repository,branch,token=_settings(cfg)
    result=http(_contents_url(repository,path,branch),token)
    encoded=result.get('content','').replace('\n','')
    if result.get('encoding')!='base64' or not encoded:
        raise RuntimeError('GitHub 이미지 파일을 읽지 못했습니다: '+path)
    return base64.b64decode(encoded)


def hydrate_catalog_images(cfg,catalog,only_codes=None):
    hydrated=copy.deepcopy(catalog)
    wanted=set(str(x) for x in only_codes) if only_codes is not None else None
    for item in hydrated.get('materials',[]):
        code=str(item.get('material_code',''))
        if wanted is not None and code not in wanted:continue
        if item.get('image_data') or not item.get('image_path'):continue
        raw=load_repo_file_bytes(cfg,item['image_path'])
        mime='image/jpeg' if str(item['image_path']).lower().endswith(('.jpg','.jpeg')) else 'image/png'
        item['image_data']='data:'+mime+';base64,'+base64.b64encode(raw).decode('ascii')
    return hydrated


def persist_inventory_catalog(cfg,inventory_rows):
    catalog,sha,repository,branch,token=load_catalog(cfg)
    added=merge_inventory(catalog,inventory_rows)
    if added:
        result=save_catalog(cfg,catalog,sha,repository,branch,token,'Add HOMSelf materials from HOMS sync')
        commit=result.get('commit',{}).get('sha','')
        print('신규 부자재 GitHub 영구 저장:',len(added),'건',commit,flush=True)
    else:print('신규 부자재 없음: GitHub catalog 변경 없음',flush=True)
    return catalog,added


def persist_admin_catalog(cfg,incoming):
    if not isinstance(incoming,dict) or not isinstance(incoming.get('managers'),list) or not isinstance(incoming.get('materials'),list):
        raise RuntimeError('관리자 catalog 저장 데이터가 잘못됐습니다.')
    catalog,sha,repository,branch,token=load_catalog(cfg)
    catalog['managers']=list(incoming['managers'])
    catalog['manager_settings']=copy.deepcopy(incoming.get('manager_settings') or {})
    old_by_code={str(x.get('material_code')):x for x in catalog.get('materials',[]) if isinstance(x,dict)}
    merged=[]
    for row in incoming['materials']:
        item=copy.deepcopy(row)
        code=str(item.get('material_code',''))
        old=old_by_code.get(code) or {}
        if item.get('image_path'):
            item.pop('image_data',None)
        elif old.get('image_path') and item.get('image_data'):
            item.pop('image_path',None)
        elif old.get('image_path') and not item.get('image_data'):
            item['image_path']=old['image_path']
        merged.append(item)
    catalog['materials']=merged
    result=save_catalog(cfg,catalog,sha,repository,branch,token,'Update HOMSelf admin catalog settings')
    return result.get('commit',{}).get('sha','')


def push_catalog_to_server(api,catalog):
    return api.post('catalog-sync',{'catalog':catalog})


def restore_persistent_catalog(api,cfg):
    catalog,_,_,_,_=load_catalog(cfg)
    hydrated=hydrate_catalog_images(cfg,catalog)
    result=push_catalog_to_server(api,hydrated)
    print('GitHub 영구 부자재 catalog 서버 반영:',result.get('materials',result.get('count',len(catalog.get('materials',[])))),'건',flush=True)
    return catalog
