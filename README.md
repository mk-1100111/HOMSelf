# HOMSelf — 불출 요청 및 HOMS 처리 연동

기존 매니저/자재 선택 화면에 DB 접수·관리자 승인·회사 PC 처리기를 연결하는 1차 버전입니다.
**현재 HOMS 현장 검증 전이며 기본 실행은 비불출 점검 모드입니다.** 실제 모드는 1항목씩 사람이 확인하는 반자동 처리입니다.

## 구성

- Express/EJS 웹: `/main`, `/material_list`, `/admin`
- Node 24 내장 SQLite: 단일 서버 영구 디스크에 요청/항목/이력 저장
- 회사 PC Python: 승인 항목 조회, 검증된 선택자로 HOMS 조작, 결과 수동 확인, 중복 방지 journal
- `HOMSelf-data` 비공개 저장소: 실행 시점의 일관된 SQLite 스냅샷 백업
- Google Drive/Sheets 미사용. GitHub는 실시간 큐가 아닙니다.

## 서버 설치 (기존 운영 배포에 바로 덮어쓰지 마세요)

1. Node 24 LTS 환경에서 `npm ci --ignore-scripts`.
2. `.env.example`을 `.env`로 복사하고 값을 지정합니다. `.env`는 Git에 올리지 않습니다.
3. 서로 다른 32자 이상 난수로 ADMIN_TOKEN, KIOSK_TOKEN, WORKER_TOKEN 설정. 생성 예: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`를 각각 실행.
4. 로컬 점검은 NODE_ENV=development, DB_PATH를 로컬 전용 폴더 절대 경로로 설정한 뒤 `npm run start:local`.
   로컬 CATALOG_PATH에는 config/catalog.example.json의 절대 경로를 지정합니다.
5. 운영은 영구 디스크 확인 후 `NODE_ENV=production`, `PERSISTENT_STORAGE_CONFIRMED=yes`. 영구 디스크 없는 무료 Render 인스턴스에 SQLite를 운영하지 마세요.
6. 서버 시작 시 항상 전체 일시정지. 관리자 `/admin`에서 확인 후 해제합니다.

### Render 기존 서비스에 적용

- 이 변경은 별도 브랜치/PR로 제공하며 기존 master 자동 배포는 건드리지 않습니다.
- Node 버전 24, Build `npm ci --ignore-scripts`, Start `npm start`, Health Check `/healthz`.
- `/var/data`에 영구 디스크 연결, `DB_PATH=/var/data/homself.sqlite`.
- 비공개 `HOMSelf-data/config/catalog.json`을 운영 서버의 `/var/data/catalog.json`으로 배치하고 `CATALOG_PATH=/var/data/catalog.json` 설정.
- 공개 저장소에는 직원·자재 실데이터 대신 `config/catalog.example.json`만 제공합니다. 운영 모드는 샘플 데이터로 시작할 수 없습니다.
- Render 서비스는 1개 인스턴스로 운영합니다. 여러 서비스/복제본이 서로 다른 SQLite 파일을 사용하면 안 됩니다.
- 영구 디스크는 서비스 요금/조건 확인 및 사용자의 설정이 필요합니다. 이 작업에서 유료 자원 생성이나 Render 배포를 실행하지 않았습니다.
- 서버 환경변수는 Render 설정 화면에 넣습니다. GitHub 연결 권한이 있어도 여기서 Render 환경변수를 설정할 수 있는 것은 아닙니다.
- 원래 Git 기록에 노출된 Google 서비스 계정 키와 첨부 Python 로그인 비밀번호는 재사용하지 말고 별도로 교체하세요. 이 코드에는 넣지 않았습니다.

## 사용

키오스크: 매니저·자재·수량 선택 → 요청 버튼 → 최초 지점 KIOSK_TOKEN 입력 → 접수번호 확인.
관리자: ADMIN_TOKEN으로 `/admin` 연결 → 요청 항목 승인 → 처리 허용.
회사 PC: [worker/README_KO.md](worker/README_KO.md) 안내에 따라 설치·점검·현장 선택자 검증.
한 장바구니의 일부 항목만 완료돼도 완료 항목은 다시 불출하지 않습니다.
완료 응답을 잃으면 같은 요청번호로 접수를 재확인합니다. 브라우저의 미확인 요청 캐시를 임의 삭제하면 중복 요청을 만들 수 있습니다.

## DB를 직접 확인하려면

`/admin` → DB 구조·데이터 보기 또는 SQLite 백업 다운로드.
테이블·상태·복구 주의사항: [docs/DATABASE.md](docs/DATABASE.md).

## 검증

`npm test` — 실제 HOMS/Render/운영 DB 미접속. 임시 SQLite 및 로컬 HTTP 테스트.
`cd worker` 후 `python -m unittest -v test_worker.py` — Selenium을 열지 않는 모의 테스트.

## 현재 한계

- HOMS 공식 API나 실제 DOM 검증 없이 저장 완료를 추정하지 않습니다. 자동 결과 확인/무인 연속처리는 아직 구현하지 않았습니다.
- 실제 저장 버튼/선택자와 담당자 ID 매핑이 확정되기 전 --live는 차단됩니다.
- 요청 상태 알림은 관리자 수동 새로고침 방식이며, 별도 문자/메신저 발송은 없습니다.
- 공유 키오스크 인증은 개별 매니저 본인 인증이 아닙니다. 관리자 승인과 PC 확인을 유지하세요.
- 최신 코드에서 Sheets 연동을 제거했지만 과거 Git 기록의 유출 키를 지우거나 폐기한 것은 아닙니다.
- 기존 추적된 node_modules/대용량 이미지 정리는 이번 기능 변경과 분리했습니다. 배포는 lockfile 기반 npm ci를 사용합니다.
