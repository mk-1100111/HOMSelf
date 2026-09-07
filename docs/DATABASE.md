# HOMSelf DB 구조 (schema version 1)

## 저장 위치와 역할

- 운영 원본: Node 서버의 `DB_PATH` SQLite 파일. Render 영구 디스크 `/var/data/homself.sqlite` 권장.
- 회사 PC: `worker/runtime/journal.sqlite`는 중복 불출 차단용 로컬 기록이며 운영 DB가 아닙니다.
- GitHub `mk-1100111/HOMSelf-data`: 비공개 스냅샷 백업. 실시간 DB/작업 큐가 아닙니다.
- Google Drive/Sheets 연동은 제거했습니다. 외부 폰트와 기존 jQuery CDN은 저장 서비스가 아닙니다.

## 테이블

| 테이블 | 내용 | 주요 필드 |
|---|---|---|
| requests | 장바구니 요청 1건 | id, idempotency_key(유일), payload_hash, manager_name, created_at |
| request_items | 요청의 자재별 처리 | id, request_id, material_code, material_name, quantity, status, attempt_id, updated_at, evidence |
| events | 상태 변경 감사 이력 | item_id, event_type, actor, note, created_at |
| settings | DB 버전·전체 일시정지 | key, value |
| worker_status | 회사 PC 마지막 응답 | last_seen, mode |

스키마 원본: `db/schema.sql`. 시각은 UTC Unix 밀리초이며 화면에서 현지 시각으로 표시합니다.
비공개 `HOMSelf-data/config/catalog.json`은 매니저·자재·불출 단위의 기준 목록입니다. 기존 HOMSelf 목록을 가져왔으며 HOMS 코드의 정확성은 현장에서 대조해야 합니다.
공개 코드에는 샘플만 있습니다. 운영 서버의 CATALOG_PATH가 실제 기준정보를 가리켜야 합니다.
요청에는 수량 최종값을 저장합니다. 예: 단위가 10인 자재를 2번 선택하면 quantity=20. 회사 PC에서 단위를 다시 곱하지 않습니다.
전체 매니저 계정 인증이 아니라 지점 키오스크 공유키 방식입니다. 이름 선택만으로 본인 확인이 되지 않으므로 관리자 승인이 필수입니다.

## 상태 규칙

접수(pending) → 승인(approved) → 준비 중(claimed) → 불출 중(submitting) → 완료(completed).

- 진행 중 오류, 프로그램 중단, 서버 재시작, 전체 정지: 확인 필요(needs_review). 자동 재시도/시간 만료 후 재배정 없음.
- 확인 필요가 1건이라도 있으면 새 항목 점유를 차단합니다.
- 준비/불출 중 항목은 DB 유일 인덱스로 전체 1건만 허용합니다. 단일 서버/단일 처리기 운영이 원칙입니다.
- 불출 시작 권한(begin)은 1회만 발급합니다. 응답을 잃으면 HOMS 버튼을 누르지 않습니다.
- 완료 응답을 잃었을 때 동일 근거의 완료 기록은 재확인할 수 있지만 HOMS 불출 자체는 재실행하지 않습니다.
- 관리자 수동 판정은 전체 일시정지 및 회사 PC 종료 후 합니다. 미불출 판정은 승인 상태가 아니라 접수로 돌립니다.
- PC 로컬 차단이 남으면 `worker.py --reconcile 항목번호`로 별도 확인 후 해제합니다. 로그/DB 파일을 삭제하지 마세요.
- 이미 HOMS에 보낸 클릭/거래는 일시정지로 취소되지 않습니다. 강제 취소·수량 역거래는 구현하지 않습니다.

## 직접 확인

`/admin`에서 관리자 인증키로 연결 → **DB 구조·데이터 보기**. 테이블별 개수와 최대 100행, 스키마를 표시합니다.
요청 목록은 최근 1,000항목, 각 항목의 이력 버튼은 해당 항목의 전체 이력입니다.
전체 자료가 필요하면 **SQLite 백업 다운로드**. SQLite 지원 도구나 Python sqlite3로 읽을 수 있습니다.

읽기 예시(SQL):

```sql
SELECT r.manager_name, i.material_name, i.quantity, i.status, i.evidence
FROM request_items i JOIN requests r ON r.id=i.request_id
ORDER BY r.created_at DESC;
```

## 백업과 복구

백업 API는 실행 중 DB 파일 복사 대신 SQLite `VACUUM INTO`로 일관된 스냅샷을 만듭니다.
PC 백업 도구는 무결성 검사와 저장소 비공개 확인 후 `snapshots/날짜-난수.sqlite`로 올립니다.
25MiB 초과 백업은 도구가 거부합니다. 관리자 다운로드로 별도 보관하고 백업 정책을 재설계하세요.
스냅샷은 누적되고 자동 삭제하지 않습니다. 주기적 실행은 아직 등록하지 않았습니다.

복구는 자동화하지 않았습니다. 반드시 서버/회사 PC를 모두 중지하고 현재 DB를 따로 백업하세요.
복구본의 pending/approved/claimed/submitting은 HOMS 실제 내역과 대조해야 합니다. 백업 이후 완료된 불출이 옛 DB에는 승인 대기로 남을 수 있습니다.
운영 경로에 복구하기 **전**, 별도 복사본에서 모든 미완료 항목을 needs_review로 바꾸고 paused=1로 설정하세요.
서버 재시작만으로는 오래된 approved를 판별하지 못합니다. 단순 파일 덮어쓰기 후 재개는 금지입니다.
완료 근거·로컬 journal·HOMS 이력 대조 후 항목별 수동 판정하세요. DB 백업만으로 HOMS 외부 거래를 되돌릴 수 없습니다.
