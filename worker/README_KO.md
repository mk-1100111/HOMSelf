# 회사 PC 실행 안내 — 자동 처리 v2

키오스크에서 매니저·부자재·수량을 선택해 접수하면 관리자 화면에 표시됩니다. 관리자가 승인한 항목만 회사 PC가 자동 처리합니다.

## 기존 설치에서 업데이트

1. 실행 중인 회사 PC 처리기를 종료하고 서버 DB를 백업합니다.
2. GitHub master 최신 코드를 다운로드하여 기존 worker 폴더의 프로그램 파일을 갱신합니다.
3. 기존 config.json, selectors.json, runtime 폴더와 .venv를 보존하세요. 특히 runtime/journal.sqlite를 삭제하거나 다른 PC와 번갈아 쓰지 마세요.
4. setup.cmd를 다시 실행해도 기존 설정과 처리 기록은 보존됩니다.
5. 기존 selectors.json이 v1이면 selectors.auto.example.json을 참고하여 v2 필드를 추가해야 합니다. 검증되지 않은 예제로 덮어쓰거나 validated_on_company_pc만 true로 바꾸면 안 됩니다.
6. Render에 master를 배포하고 check.cmd로 서버 연결을 확인합니다. 서버는 재시작할 때 전체 일시정지 상태입니다.

## 처음 설치하는 경우

- Python 3.11 이상과 Chrome이 필요합니다.
- 전용 폴더에 압축을 풀고 setup.cmd를 실행합니다.
- config.json의 server_url에 실제 Render 서비스 주소를 넣습니다.
- Windows 사용자 환경변수 HOMSELF_WORKER_TOKEN을 서버 WORKER_TOKEN과 같게 설정한 후 새 터미널을 엽니다.
- config.json의 poll_seconds는 기본 5초입니다.
- check.cmd는 서버 조회만 수행합니다. HOMS 브라우저를 열거나 불출하지 않습니다.

## HOMS 현장 설정 — 실사용 전 필요한 단계

실제 HOMS의 거래번호 표시 및 불출내역 화면을 아직 확인하지 못했습니다. 따라서 제공된 예제는 바로 실불출 가능한 완성 설정이 아닙니다. 아래 선택자를 실제 화면에서 확인하고 모의 화면 또는 승인된 첫 실거래로 대조해야 합니다. 로그인 비밀번호나 인증키를 공유할 필요는 없습니다.

| 설정 그룹 | 확인할 내용 |
|---|---|
| authenticated_css | 로그인 완료를 나타내는 요소 |
| stock_search_css, stock_query_xpath, stock_rows | 자재코드 입력창, 조회 버튼, 결과 행 |
| code_cell_index, stock_cell_index | 자재코드·현재재고 열 번호(1부터) |
| receiver_result_* | 담당자 검색 결과 행, 고유 ID, 이름, 선택 버튼 |
| selected_receiver_*, popup_material_code_css, quantity_css | 실제 선택된 담당자·자재·수량 |
| manager_ids | 매니저 이름과 실제 HOMS 담당자 ID의 일대일 매핑 |
| release_button_xpath, first_confirm_css, second_confirm_css | 실제 불출 버튼과 확인 버튼 |
| receipt_id_css | 이번 불출 성공 시 새로 표시되는 고유 거래번호 |
| history_url, history_search_css, history_query_css, history_rows_css | 거래번호로 불출내역을 조회하는 화면 |
| history_transaction_css 등 history_* | 내역의 거래번호·담당자 ID·이름·자재코드·수량·완료 상태 |
| history_completed_text | 실제 완료 상태 문구 |

선택자 CSS/XPath는 서로 구분합니다. 고유 ID는 hidden input도 읽을 수 있습니다.
현재 코드는 재고 조회 후 기존 행이 교체되는 DOM을 전제로 대기합니다. HOMS가 행을 유지한 채 값만 갱신한다면 실제 완료 신호에 맞게 어댑터를 수정해야 합니다.
동일 자재코드가 여러 창고/로트에 걸쳐 여러 행이면 임의 선택하지 않고 중단합니다.
HOMS가 성공 시 거래번호를 표시하지 않거나 두 번째 확인 버튼이 없다면 실제 흐름에 맞춘 코드 보완이 필요합니다. 화면을 보지 않고 선택자를 추정해 채우지 마세요.
매핑과 선택자 검증이 모두 끝난 뒤 profile_version=2, validated_on_company_pc=true를 설정합니다. 실제 직원 매핑은 공개 GitHub에 올리지 않습니다.

## 매일 사용하는 방법

1. 회사 PC에서 start_auto.cmd를 한 번 실행하고 켜 둡니다.
2. 관리자 화면에서 처리 허용을 누릅니다.
3. 키오스크 요청을 관리자 화면에서 확인하고 승인합니다.
4. 첫 승인 건이 있으면 열린 Chrome에서 HOMS에 로그인합니다. 프로그램이 로그인 완료를 자동 감지합니다.
5. 이후 자재 검색 → 담당자 선택 → 수량 대조 → 불출 → 거래번호로 내역 대조 → 서버 완료 기록 → 다음 승인 건 처리가 자동으로 이어집니다.

정상 처리마다 콘솔 입력, 수동 검색, 결과 근거 입력, 프로그램 재실행이 필요하지 않습니다.
회사의 로그인 절차는 직접 수행합니다. 세션 만료는 새 항목을 점유하기 전에 재로그인 대기하며, 처리 도중 만료되면 확인 필요로 중단합니다.
live_one.cmd는 현장 첫 건 검증용으로 감시를 한 번만 수행합니다. 일상 실행에는 start_auto.cmd를 사용하세요.
종료하려면 Ctrl+C. 완료 응답이나 불출 결과가 불명확한 항목은 자동으로 재불출하지 않습니다.

## 오류가 발생했을 때

대기 중 서버 통신 장애는 재연결을 시도합니다. 요청 점유 또는 실제 처리 중 응답 유실은 자동 재시도하지 않고 중단합니다.
관리자에서 전체 일시정지 → 모든 회사 PC 처리기 종료 → HOMS 실제 내역 확인 순서로 진행합니다.
완료가 확인되면 실제 불출 완료 확인, 미불출이 확실하면 미불출 확인 → 재승인 대기를 선택하고 근거를 남깁니다.
미불출 판정 후 로컬 차단이 남으면 다음 명령으로 예외 복구합니다.

    .venv\Scripts\python.exe worker.py --reconcile 항목번호

복구 시에만 확인 입력을 요구합니다. 이미 검증된 거래번호가 로컬에 남은 항목은 재불출 해제를 거부합니다.
결과가 불명확하면 확인 필요 상태를 유지하세요. 처리 기록을 삭제하여 재시도하면 안 됩니다.
일시정지는 이미 HOMS에 전송된 거래를 취소하지 않습니다.

## DB 확인과 비공개 GitHub 백업

관리자 화면의 DB 구조·데이터 보기에서 요청, 상태 이력, homs_receipts 거래 근거를 확인합니다.
SQLite 백업 다운로드로 전체 데이터를 받을 수 있습니다. 서버는 DB v2이며 기존 v1 DB는 자동 확장됩니다.

backup.cmd는 실행할 때 서버의 일관된 스냅샷을 받고 무결성과 저장소 비공개 여부를 확인하여 HOMSelf-data에 업로드합니다.
Windows 사용자 환경변수 HOMSELF_ADMIN_TOKEN과 HOMSELF_BACKUP_GITHUB_TOKEN이 필요합니다.
GitHub 토큰은 HOMSelf-data 저장소의 Contents 읽기/쓰기 권한으로 제한하세요.
자동 백업 일정은 등록하지 않았으며 GitHub는 실시간 처리 큐가 아닙니다.

## 모의 검증

    .venv\Scripts\python.exe -m unittest -v test_worker.py

실제 HOMS나 Chrome을 실행하지 않고 연속 처리, 무입력 처리, 거래 근거 불일치, 응답 유실과 중복 차단을 검증합니다.
