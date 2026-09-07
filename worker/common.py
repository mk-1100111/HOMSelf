"""No HOMS credentials are stored. HTTP writes are never automatically retried."""
import json
import os
from pathlib import Path
import urllib.request
import urllib.error
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent

class HTTPFailure(RuntimeError):
    def __init__(self, status):
        self.status = status
        super().__init__(f'서버 HTTP {status}: 상태/인증을 확인하세요. 불출은 자동 재시도하지 않습니다.')

class ConnectionFailure(RuntimeError):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('인증정보 보호: HTTP 리다이렉트를 허용하지 않습니다.')

def config():
    target = ROOT / 'config.json'
    if not target.exists():
        raise RuntimeError('config.example.json을 config.json으로 복사하고 서버 주소를 설정하세요.')
    data = json.loads(target.read_text(encoding='utf-8-sig'))
    parsed = urlparse(data['server_url'])
    allowed_local = data.get('allow_local_http') is True and parsed.hostname in ('127.0.0.1', 'localhost')
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise RuntimeError('server_url에는 경로/인증정보 없이 서버 기본 주소만 지정하세요.')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and allowed_local):
        raise RuntimeError('운영 서버는 HTTPS가 필수입니다.')
    return data

def http(url, token, method='GET', body=None, binary=False):
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': 'HOMSelf-Worker/1.0'}
    data = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as response:
            raw = response.read(25 * 1024 * 1024 + 1)
            if len(raw) > 25 * 1024 * 1024:
                raise RuntimeError('응답이 25MB 한도를 넘었습니다. 수동 백업이 필요합니다.')
            return raw if binary else json.loads(raw)
    except urllib.error.HTTPError as error:
        # Do not echo response bodies or request headers containing private data.
        raise HTTPFailure(error.code) from None
    except urllib.error.URLError:
        raise ConnectionFailure('통신 실패: 반영 여부가 불명확합니다. 불출은 자동 재시도하지 않습니다.') from None

class API:
    def __init__(self, cfg, token=None):
        self.base = cfg['server_url'].rstrip('/')
        self.token = token or os.environ.get('HOMSELF_WORKER_TOKEN', '')
        if len(self.token) < 32:
            raise RuntimeError('HOMSELF_WORKER_TOKEN 환경변수를 설정하세요(32자 이상).')

    def get(self, route):
        return http(self.base + '/api/worker/' + route, self.token)

    def post(self, route, body):
        return http(self.base + '/api/worker/' + route, self.token, 'POST', body)
