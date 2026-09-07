/* A lost response MUST retry the same key AND payload, never create a new request. */
const pendingKey = 'homself.pending.v1';
const kioskPinOk = token => /^\d{4}$/.test(token);
window.getHomselfCatalog=async function(){
  try {
    let token=sessionStorage.getItem('homself.kiosk.token');
    if(!token) token=prompt('지점 키오스크 PIN 4자리를 입력하세요.');
    if(!token)return null;
    token=token.trim();
    if(!kioskPinOk(token)){sessionStorage.removeItem('homself.kiosk.token');throw Error('키오스크 PIN은 숫자 4자리입니다.');}
    const response=await fetch('/api/catalog',{headers:{Authorization:'Bearer '+token}});
    if(!response.ok){sessionStorage.removeItem('homself.kiosk.token');throw Error('기준정보 조회 실패. 키오스크 PIN과 서버 설정을 확인하세요.');}
    sessionStorage.setItem('homself.kiosk.token',token);
    return await response.json();
  } catch(error){alert(error.message);return null;}
};
async function transmitPending() {
  const pending=JSON.parse(localStorage.getItem(pendingKey) || 'null');
  if(!pending) return;
  let token=sessionStorage.getItem('homself.kiosk.token');
  if(!token) {
    token=prompt('지점 키오스크 PIN 4자리를 입력하세요. 관리자 PIN이 아닙니다.');
    if(!token) return;
  }
  token=token.trim();
  if(!kioskPinOk(token)){sessionStorage.removeItem('homself.kiosk.token');throw new Error('키오스크 PIN은 숫자 4자리입니다.');}
  sessionStorage.setItem('homself.kiosk.token',token);
  const response=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json',
    Authorization:'Bearer '+token,'Idempotency-Key':pending.key},body:JSON.stringify(pending.body)});
  const result=await response.json();
  if(!response.ok) {
    if(response.status === 401 || response.status === 429) sessionStorage.removeItem('homself.kiosk.token');
    if(response.status === 400) localStorage.removeItem(pendingKey); // Validation failed before any DB write.
    throw new Error(result.error || '접수 결과를 확인하지 못했습니다.');
  }
  localStorage.removeItem(pendingKey);
  alert('요청 접수 완료\n접수번호: '+result.request_id+'\n관리자 승인 후 HOMS 불출이 진행됩니다.');
  location.assign('/main');
}
window.sendCart=async function() {
  if(window.homselfSending) return;
  try {
    if(!localStorage.getItem(pendingKey)) {
      const items=Object.entries(cartQuantities).map(([name,count]) => {
        const m=material_list.find(m=>m.material_name === name);
        return {material_code:m.material_code,quantity:count*m.material_unit};
      });
      if(!items.length) {alert('장바구니가 비어 있습니다.');return;}
      if(items.some(i=>!Number.isSafeInteger(i.quantity)||i.quantity<1||i.quantity>100000)){alert('수량은 1~100000 범위여야 합니다.');return;}
      const manager_name=new URLSearchParams(location.search).get('managerName');
      if(!manager_name) {alert('매니저를 다시 선택하세요.');return;}
      const pending={key:crypto.randomUUID(),body:{manager_name,items}};
      localStorage.setItem(pendingKey,JSON.stringify(pending));
    } else if(!confirm('접수 확인이 끝나지 않은 이전 요청을 같은 번호로 재확인합니다. 계속할까요?')) return;
    window.homselfSending=true;
    if(typeof timeoutId !== 'undefined') clearTimeout(timeoutId);
    if(typeof countdownInterval !== 'undefined') clearInterval(countdownInterval);
    await transmitPending();
  } catch(error) {
    alert(error.message+'\n기존 요청은 보존했습니다. 새 요청을 만들지 말고 재확인하세요.');
  } finally {window.homselfSending=false;}
};
const notice=document.getElementById('pending-notice');
if(notice && localStorage.getItem(pendingKey)) {
  notice.hidden=false;
  notice.textContent='접수 확인이 끝나지 않은 요청이 있습니다. 새 요청 전에 확인하세요. ';
  const button=document.createElement('button');button.textContent='같은 요청 재확인';
  button.onclick=async()=>{button.disabled=true;try{await transmitPending();}catch(e){alert(e.message);}finally{button.disabled=false;}};
  notice.append(button);
  document.getElementById('manager-lists').style.display='none';
}
