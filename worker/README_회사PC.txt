HOMSelf 회사 PC 사용법
======================

목표
- 회사 PC에서 HOMSelf_회사PC.cmd를 한 번 실행합니다.
- Chrome에 HOMSelf 관리자 탭과 HOMS 탭이 같이 열립니다.
- HOMS 로그인은 직접 합니다.
- 이후 HOMSelf 관리자에서 요청을 승인하면 승인 건을 자동으로 불출합니다.

1회 준비
1. Python 3.11 이상과 Chrome이 설치되어 있어야 합니다.
2. setup.cmd를 한 번 실행합니다.
3. Windows 환경변수 HOMSELF_WORKER_TOKEN을 Render의 WORKER_TOKEN과 같은 값으로 설정합니다.
   예: setx HOMSELF_WORKER_TOKEN "Render의 WORKER_TOKEN 값"
4. 환경변수를 새로 설정했다면 CMD/탐색기를 새로 열거나 로그아웃/로그인 후 실행합니다.

평소 사용
1. HOMSelf_회사PC.cmd 실행
2. 열린 HOMS 탭에서 직접 로그인
3. HOMSelf 관리자 탭에서 ADMIN_TOKEN 입력
4. 서버가 일시정지 상태면 '처리 허용'을 한 번 클릭
5. 키오스크 요청을 확인하고 '승인' 클릭
6. 프로그램이 HOMS 탭으로 전환하여 아래 순서로 자동 처리
   상품코드 입력 -> 조회 -> check_0 선택 -> 자재별출고 -> 작업자명 입력+Enter -> 수량 입력 -> 출고 -> 확인 -> 완료 확인
7. 완료 후 관리자 탭으로 돌아오고 다음 승인 건을 기다립니다.

현재 확인된 HOMS 선택자
- 상품코드: #srcGoodId
- 조회: //*[@id="frm"]/div[1]/table/tbody/tr[1]/td[4]/a[1]
- 선택: //*[@id="check_0"]
- 자재별출고: //*[@id="frm"]/div[2]/div[3]/a[4]
- 작업자명: #srcReceiverName (입력 후 Enter)
- 수량: #srcStockCnt_0
- 출고: //*[@id="_popup0"]/div[2]/div/div/div/div[2]/a[2]
- 첫 확인: #_confirmModalOk
- 완료 확인: #_alertModalOk

주의
- 실제 출고 버튼을 누른 뒤 통신/화면 오류가 발생하면 프로그램은 자동 재불출하지 않고 '확인 필요'로 중단합니다.
- 이 경우 HOMS 실제 불출내역을 먼저 확인하세요.
- runtime/journal.sqlite를 삭제하지 마세요.
- 같은 worker 폴더를 여러 PC에서 동시에 실행하지 마세요.
- Chrome 창 전체를 닫으면 자동처리도 중단됩니다.
