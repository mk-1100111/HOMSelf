"""Persist static material metadata to the authorized private HOMSelf-data repository.

Stock quantities are intentionally excluded. The private catalog is the long-lived
source for material code/name/unit metadata; runtime HOMS stock stays on the server.
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
    return catalog,result.get('sha'),repository,branch,token


def merge_inventory(catalog,inventory_rows):
    materials=catalog['materials']
    known={str(item.get('material_code')) for item in materials if isinstance(item,dict)}
    added=[]
    for row in inventory_rows:
        code=str(row.get('material_code','')).strip()
        if not code or code in known:
            continue
        item={
            'material_code':code,
            'material_name':str(row.get('material_name') or code).strip(),
            'material_unit':1
        }
        specification=str(row.get('specification') or '').strip()
        if specification:
            item['specification']=specification
        materials.append(item)
        known.add(code)
        added.append(item)
    return added


def save_catalog(cfg,catalog,sha,repository=None,branch=None,token=None):
    if repository is None or branch is None or token is None:
        repository,branch,token=_settings(cfg)
    base=_repo_base(repository)
    body={
        'message':'Update HOMSelf material catalog from HOMS sync',
        'branch':branch,
        'content':base64.b64encode((json.dumps(catalog,ensure_ascii=False,indent=2)+'\n').encode('utf-8')).decode('ascii')
    }
    if sha:
        body['sha']=sha
    return http(base+'/contents/'+quote(CATALOG_PATH),token,'PUT',body)


def persist_inventory_catalog(cfg,inventory_rows):
    catalog,sha,repository,branch,token=load_catalog(cfg)
    added=merge_inventory(catalog,inventory_rows)
    if added:
        result=save_catalog(cfg,catalog,sha,repository,branch,token)
        commit=result.get('commit',{}).get('sha','')
        print('신규 부자재 GitHub 영구 저장:',len(added),'건',commit,flush=True)
    else:
        print('신규 부자재 없음: GitHub catalog 변경 없음',flush=True)
    return catalog,added


def push_catalog_to_server(api,catalog):
    materials=[]
    for item in catalog.get('materials',[]):
        if not isinstance(item,dict):
            continue
        materials.append({
            'material_code':str(item.get('material_code','')).strip(),
            'material_name':str(item.get('material_name','')).strip(),
            'material_unit':item.get('material_unit',1),
            'specification':str(item.get('specification','')).strip()
        })
    return api.post('catalog-sync',{'materials':materials})


def restore_persistent_catalog(api,cfg):
    catalog,_,_,_,_=load_catalog(cfg)
    result=push_catalog_to_server(api,catalog)
    print('GitHub 영구 부자재 catalog 서버 반영:',result.get('count',len(catalog.get('materials',[]))),'건',flush=True)
    return catalog
