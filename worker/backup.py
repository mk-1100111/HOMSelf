"""Explicit private-repository backup. No scheduler and no automatic uploads."""
import base64
import hashlib
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from urllib.parse import quote
from common import ROOT, config, http

def main():
    cfg=config()
    repository=cfg['backup_repository']
    # Lock backups to the user-authorized destination. Never fall back to public HOMSelf.
    if repository!='mk-1100111/HOMSelf-data':
        raise RuntimeError('허용된 비공개 백업 저장소는 mk-1100111/HOMSelf-data입니다.')
    github_token=os.environ.get('HOMSELF_BACKUP_GITHUB_TOKEN','')
    admin_token=os.environ.get('HOMSELF_ADMIN_TOKEN','')
    if not github_token or len(admin_token)<32:
        raise RuntimeError('HOMSELF_BACKUP_GITHUB_TOKEN 및 HOMSELF_ADMIN_TOKEN 환경변수가 필요합니다.')
    base='https://api.github.com/repos/'+repository
    metadata=http(base,github_token)
    if metadata.get('private') is not True or metadata.get('full_name')!=repository:
        raise RuntimeError('비공개 여부를 확인하지 못해 업로드를 차단했습니다.')
    raw=http(cfg['server_url'].rstrip('/')+'/api/admin/backup',admin_token,binary=True)
    if not raw.startswith(b'SQLite format 3\x00'):
        raise RuntimeError('SQLite 백업이 아닙니다.')
    folder=ROOT/'runtime'/'backups';folder.mkdir(parents=True,exist_ok=True)
    name=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]+'.sqlite'
    file=folder/name
    file.write_bytes(raw)
    with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
            raise RuntimeError('DB 무결성 검사 실패. 로컬 파일을 남기고 업로드하지 않습니다.')
        if db.execute('PRAGMA user_version').fetchone()[0] not in (1,2):
            raise RuntimeError('지원되지 않는 DB 버전입니다.')
    # Check again immediately before writing; do not upload if permissions changed.
    if http(base,github_token).get('private') is not True:
        raise RuntimeError('저장소가 비공개가 아니므로 업로드하지 않습니다.')
    result=http(base+'/contents/snapshots/'+quote(name),github_token,'PUT',{
        'message':'Backup SQLite snapshot '+name,
        'branch':cfg.get('backup_branch','main'),
        'content':base64.b64encode(raw).decode('ascii')
    })
    print('비공개 백업 완료:',repository+'/snapshots/'+name)
    print('SHA256:',hashlib.sha256(raw).hexdigest())
    print('Git commit:',result.get('commit',{}).get('sha',''))
    print('로컬 백업:',file)
    print('백업 복구 시 자동 불출을 켜지 말고 HOMS 실제 내역과 대조하세요.')

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('백업 실패:',error);sys.exit(1)
