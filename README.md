# HOMSelf — 불출 요청 및 HOMS 처리 연동

키오스크 요청 → 관리자 승인 → 회사 PC Selenium 자동 불출을 연결합니다.
v2는 승인 큐를 계속 감시하며 자재 검색·담당자 선택·불출·거래 내역 대조를 자동 수행합니다. 정상 처리마다 콘솔 입력이나 재실행이 필요하지 않습니다.
**실제 HOMS 화면 선택자와 거래번호 표시 방식은 아직 현장 검증 전입니다.** 검증되지 않은 설정에서는 실제 처리를 차단합니다.

## 구성

- Express/EJS 웹: `/main`, `/material_list`, `/admin`
- Node 24 내장 SQLite: Render Persistent Disk에 요청/승인/완료/이력 저장
- 회사 PC Python: 승인 항목 상시 감시, HOMS 자동 조작·거래 결과 대조, 중복 방지 journal
- private `HOMSelf-data`: `config/catalog.json`과 마지막 HOMS 재고 `runtime/stock_snapshot.json` 저장
- 관리자 자재/매니저 설정은 Render가 `HOMSelf-data`에 즉시 저장하고, 실패한 경우에만 Worker가 재시도합니다.
- HOMS 재고는 전체 동기화가 성공할 때 한 번만 GitHub snapshot을 갱신합니다. 개별 요청/승인마다 GitHub commit하지 않습니다.
- Google Drive/Sheets 미사용. 요청 큐의 운영 원본은 GitHub가 아니라 영구 SQLite입니다.

## 서버 설치 (기존 운영 배포에 바로 덮어쓰지 마세요)

1. Node 24 LTS 환경에서 `npm ci --ignore-scripts`.
2. `.env.example`을 `.env`로 복사하고 값을 지정합니다. `.env`는 Git에 올리지 않습니다.
3. `ADMIN_TOKEN`, `KIOSK_TOKEN`은 서로 다른 4자리 PIN, `WORKER_TOKEN`은 32자 이상 내부 통신키로 설정합니다.
4. 로컬 점검은 `NODE_ENV=development`, `DB_PATH`를 로컬 전용 폴더 절대 경로로 설정한 뒤 `npm run start:local`.
5. 운영은 Render Persistent Disk 확인 후 `NODE_ENV=production`, `PERSISTENT_STORAGE_CONFIRMED=yes`.
6. private `HOMSelf-data` 전용 fine-grained token은 `Contents: Read and write` 권한이 필요합니다. 실제 토큰 값은 Git에 올리지 않습니다.
7. 서버 시작 시 항상 전체 일시정지. 관리자 `/admin`에서 확인 후 해제합니다.

### Render 기존 서비스에 적용

- 배포 대상 브랜치는 `master`입니다. 배포 전 운영 DB를 백업하고 회사 PC 처리기를 종료하세요.
- Node 24, Build `npm ci --ignore-scripts`, Start `npm start`, Health Check `/healthz`.
- Render Persistent Disk를 `/var/data`에 연결합니다.
- 권장 환경변수:
  - `HOMSELF_PERSISTENT_DATA_DIR=/var/data`
  - `DB_PATH=/var/data/homself.sqlite`
  - `PERSISTENT_STORAGE_CONFIRMED=yes`
  - `HOMSELF_CATALOG_GITHUB_TOKEN=<HOMSelf-data Contents: Read and write 토큰>`
- `CATALOG_PATH`는 GitHub startup catalog 조회 실패 시 사용할 비상 fallback 파일 경로입니다.
- 서버 시작 시 private `HOMSelf-data/config/catalog.json`을 우선 읽습니다.
- 마지막 HOMS 재고 snapshot이 있으면 Worker가 꺼져 있어도 `runtime/stock_snapshot.json`에서 재고를 복원합니다.
- Worker가 꺼져 있어도 키오스크 요청은 Persistent SQLite에 계속 누적되고, 나중에 관리자 승인/일괄 불출할 수 있습니다.
- Render 서비스는 1개 인스턴스로 운영합니다. 여러 복제본이 서로 다른 SQLite 파일을 사용하면 안 됩니다.
- Persistent Disk는 Render 요금/조건 확인 및 사용자의 설정이 필요합니다. 코드만 배포해서 디스크가 자동 생성되지는 않습니다.

## 사용

키오스크: 매니저·자재·수량 선택 → 요청 버튼 → 최초 지점 KIOSK_TOKEN 입력 → 접수 확인.
관리자: ADMIN_TOKEN으로 `/admin` 연결 → 요청 항목 승인 → 일괄 불출 시작.
회사 PC: [worker/README_KO.md](worker/README_KO.md) 안내에 따라 설치·점검·현장 선택자 검증 후 `start_auto.cmd`를 실행합니다.
Worker가 꺼진 동안에도 요청과 승인은 서버 영구 DB에 남습니다. Worker를 다시 켠 뒤 승인된 항목을 순서대로 처리합니다.
한 장바구니의 일부 항목만 완료돼도 완료 항목은 다시 불출하지 않습니다.
완료 응답을 잃으면 같은 요청번호로 접수를 재확인합니다. 브라우저의 미확인 요청 캐시를 임의 삭제하면 중복 요청을 만들 수 있습니다.

## 데이터 영속화 원칙

- 요청/승인/완료/이력: `DB_PATH` SQLite가 운영 원본입니다. 반드시 Render Persistent Disk에 둡니다.
- 자재/매니저 기준정보: private `HOMSelf-data/config/catalog.json`.
- 마지막 HOMS 재고: private `HOMSelf-data/runtime/stock_snapshot.json`.
- 재고 snapshot은 HOMS 전체 동기화 완료 시에만 저장하므로 GitHub 쓰기 부하는 매우 낮습니다.
- `/tmp/homself.sqlite`는 개발/임시 운영용입니다. 재배포 후 요청 보존을 보장하지 않습니다.

## DB를 직접 확인하려면

`/admin` → DB 구조·데이터 보기 또는 SQLite 백업 다운로드.
테이블·상태·복구 주의사항: [docs/DATABASE.md](docs/DATABASE.md).

## 검증

`npm test` — 실제 HOMS/Render/운영 DB 미접속. 임시 SQLite 및 로컬 HTTP 테스트.
GitHub Actions의 `HOMSelf Tests`가 `master` push마다 같은 테스트를 실행합니다.
`cd worker` 후 `python -m unittest -v test_worker.py` — Selenium을 열지 않는 모의 테스트.

## 현재 한계

- 자동 결과 확인/연속처리 코드는 구현되어 있으며 모의 검증 중심입니다. HOMS 실제 DOM과 성공 거래번호·내역 조회 선택자는 회사 PC 환경에서 확인해야 합니다.
- Persistent Disk 연결과 Render 환경변수 입력은 Render 서비스 설정에서 사용자가 수행해야 합니다.
- GitHub 토큰이 읽기 전용이면 startup 복원은 되지만 관리자 설정/재고 snapshot 직접 저장은 실패하고 Worker fallback 대기로 남습니다.
- 공유 키오스크 인증은 개별 매니저 본인 인증이 아닙니다. 관리자 승인을 유지하세요.
