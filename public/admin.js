const adminTokenKey='homself.admin.token';
let token=sessionStorage.getItem(adminTokenKey) || '';
const $=id=>document.getElementById(id);
const labels={pending:'접수',approved:'승인',claimed:'준비 중',submitting:'불출 중',needs_review:'확인 필요',cancelled:'반려',completed:'완료'};
function message(text){$('message').textContent=text;}
async function api(path,body){
  const response=await fetch('/api/admin/'+path,{method:body!==undefined?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  if(!response.ok){const data=await response.json();throw Error(data.error);}
  return response;
}
async function action(item,operation){
  await api('items/'+item.id,{action:operation,note:''});await refresh();
}
function decisionButton(text,type,active,fn,disabled=false){
  const b=document.createElement('button');
  b.type='button';b.textContent=text;b.className='decision-button '+type+(active?' active':'');b.disabled=disabled;
  b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){message(e.message);}finally{b.disabled=false;}};
  return b;
}
let refreshing=false;
async function refresh(){
  if(refreshing || !token)return;
  refreshing=true;
  try{await refreshData();}finally{refreshing=false;}
}
function sheetStatus(item,data){
  if(item.status==='claimed')return '준비 중';
  if(item.status==='submitting')return '불출 중';
  if(data.batch_active && item.current_batch)return '이번 배치 대기';
  if(data.batch_active)return '다음 배치';
  return '승인 대기';
}
function renderApprovalSheet(data){
  const sheet=$('approval-sheet');sheet.replaceChildren();
  const list=data.approval_sheet || [];
  $('approval-count').textContent=list.length+'건';
  $('approval-empty').hidden=list.length>0;
  for(const item of list){
    const card=document.createElement('article');card.className='approval-item'+(item.current_batch?' current-batch':'');
    const head=document.createElement('div');head.className='approval-item-head';
    const manager=document.createElement('strong');manager.textContent=item.manager_name;
    const state=document.createElement('span');state.className='sheet-state sheet-'+item.status;state.textContent=sheetStatus(item,data);
    head.append(manager,state);
    const material=document.createElement('div');material.className='approval-material';material.textContent=item.material_name;
    const meta=document.createElement('div');meta.className='approval-meta';
    const code=document.createElement('span');code.textContent=item.material_code;
    const qty=document.createElement('b');qty.textContent=item.quantity+'개';
    meta.append(code,qty);
    card.append(head,material,meta);sheet.append(card);
  }
}
async function refreshData(){
  const data=await (await api('overview')).json();
  $('controls').hidden=false;
  if(data.batch_active){
    $('run-state').textContent='일괄 불출 진행 중';
    $('queue-state').textContent='현재 배치 남은 '+data.batch_remaining+'건 · 다음 배치 승인 '+data.approved_waiting+'건';
  }else{
    $('run-state').textContent='승인 선택 대기';
    $('queue-state').textContent='접수 '+data.pending_waiting+'건 · 승인 시트 '+(data.approval_sheet||[]).length+'건';
  }
  $('bulk-approve').disabled=data.pending_waiting<1;
  $('bulk-approve').textContent=data.pending_waiting>0?'접수 '+data.pending_waiting+'건 일괄승인':'일괄승인';
  $('start-batch').disabled=data.batch_active || data.approved_waiting<1;
  $('start-batch').textContent=data.batch_active?'불출 진행 중':'승인 '+data.approved_waiting+'건 일괄불출';
  $('worker-state').textContent=data.worker?'회사 PC 마지막 응답 '+new Date(data.worker.last_seen).toLocaleTimeString():'회사 PC 응답 기록 없음';

  renderApprovalSheet(data);
  const currentBatchIds=new Set((data.approval_sheet||[]).filter(item=>item.current_batch).map(item=>item.id));
  $('items').replaceChildren();
  for(const item of data.items){
    const row=document.createElement('tr');row.className='request-row status-row-'+item.status;
    const values=[new Date(item.created_at).toLocaleString(),item.manager_name,item.material_name+'\n'+item.material_code,item.quantity];
    for(const text of values){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}
    const statusCell=document.createElement('td');
    const pill=document.createElement('span');pill.className='status-pill status-'+item.status;pill.textContent=labels[item.status]||item.status;statusCell.append(pill);row.append(statusCell);
    const cell=document.createElement('td');cell.className='decision-cell';
    if(['pending','approved','cancelled'].includes(item.status)){
      const locked=currentBatchIds.has(item.id);
      cell.append(
        decisionButton('승인','approve',item.status==='approved',()=>action(item,'toggle_approve'),locked),
        decisionButton('반려','reject',item.status==='cancelled',()=>action(item,'toggle_reject'),locked)
      );
    }else if(item.status!=='completed' && item.status!=='needs_review'){
      const working=document.createElement('span');working.className='locked-text';working.textContent='처리 중';cell.append(working);
    }
    row.append(cell);$('items').append(row);
  }
  message('마지막 갱신 '+new Date().toLocaleTimeString());
}
$('login').onsubmit=async e=>{
  e.preventDefault();
  const candidate=$('token').value.trim();$('token').value='';
  if(!/^\d{4}$/.test(candidate)){message('관리자 PIN은 숫자 4자리입니다.');return;}
  token=candidate;
  try{
    await refresh();
    sessionStorage.setItem(adminTokenKey,token);
  }catch(e){
    message(e.message);token='';sessionStorage.removeItem(adminTokenKey);
  }
};
$('logout').onclick=()=>{token='';sessionStorage.removeItem(adminTokenKey);location.reload();};
$('bulk-approve').onclick=async()=>{
  const count=parseInt(($('bulk-approve').textContent.match(/\d+/)||['0'])[0],10);
  if(count<1)return;
  if(!confirm('현재 접수 상태 '+count+'건을 모두 승인 시트에 올릴까요?\n이미 반려한 항목은 변경하지 않습니다.'))return;
  try{const result=await(await api('approve-all',{})).json();message(result.count+'건을 일괄 승인했습니다.');await refresh();}catch(e){message(e.message);}
};
$('start-batch').onclick=async()=>{
  const count=parseInt(($('start-batch').textContent.match(/\d+/)||['0'])[0],10);
  if(count<1)return;
  if(!confirm('승인 시트의 '+count+'건을 일괄 불출할까요?\n시작 후 새로 승인한 요청은 다음 배치로 넘어갑니다.'))return;
  try{const result=await(await api('batch/start',{})).json();message(result.count+'건 일괄 불출을 시작했습니다.');await refresh();}catch(e){message(e.message);}
};
setInterval(()=>{if(token && !document.hidden)refresh().catch(e=>message(e.message));},2000);
if(token) refresh().catch(e=>{message(e.message);token='';sessionStorage.removeItem(adminTokenKey);});
