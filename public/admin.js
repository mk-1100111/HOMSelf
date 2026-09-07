let token='';
const $=id=>document.getElementById(id);
const labels={pending:'접수',approved:'승인 대기',claimed:'준비 중',submitting:'불출 중',completed:'완료',needs_review:'확인 필요',cancelled:'취소'};
function message(text){$('message').textContent=text;}
async function api(path,body){
  const response=await fetch('/api/admin/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!response.ok){const data=await response.json();throw Error(data.error);}
  return response;
}
async function action(item,operation){
  let note='';
  if(operation.startsWith('confirm_')){
    if(!confirm('회사 PC 프로그램을 종료했으며 실제 HOMS 불출내역을 확인했습니까?'))return;
    note=prompt('확인 근거: 조회 시각·담당자·자재·수량 등을 적으세요.') || '';
    if(note.trim().length<10)return;
  } else if(!confirm(item.manager_name+' / '+item.material_name+' / '+item.quantity+'개를 '+(operation==='approve'?'승인':'취소')+'할까요?'))return;
  await api('items/'+item.id,{action:operation,note});await refresh();
}
function button(text,fn,className=''){
  const b=document.createElement('button');b.textContent=text;b.className='action-button '+className;
  b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){message(e.message);}finally{b.disabled=false;}};
  return b;
}
let refreshing=false;
async function refresh(){
  if(refreshing || !token)return;
  refreshing=true;
  try{await refreshData();}finally{refreshing=false;}
}
async function refreshData(){
  const data=await (await api('overview')).json();
  $('controls').hidden=false;
  if(data.batch_active){
    $('run-state').textContent='일괄 불출 진행 중';
    $('queue-state').textContent='현재 배치 남은 '+data.batch_remaining+'건 · 다음 배치 대기 '+data.approved_waiting+'건';
  }else{
    $('run-state').textContent='승인건 누적 대기';
    $('queue-state').textContent='불출 대기 '+data.approved_waiting+'건';
  }
  $('start-batch').disabled=data.batch_active || data.approved_waiting<1;
  $('start-batch').textContent=data.batch_active?'불출 진행 중':'승인건 '+data.approved_waiting+'건 일괄 불출';
  $('pause').disabled=!data.batch_active;
  $('worker-state').textContent=data.worker?'회사 PC 마지막 응답 '+new Date(data.worker.last_seen).toLocaleTimeString():'회사 PC 응답 기록 없음';
  $('items').replaceChildren();
  for(const item of data.items){
    const row=document.createElement('tr');
    const values=[new Date(item.created_at).toLocaleString(),item.manager_name,item.material_name+'\n'+item.material_code,item.quantity];
    for(const text of values){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}
    const statusCell=document.createElement('td');
    const pill=document.createElement('span');pill.className='status-pill status-'+item.status;pill.textContent=labels[item.status];statusCell.append(pill);row.append(statusCell);
    const cell=document.createElement('td');
    const actions=item.status==='pending'?[['승인','approve','approve'],['취소','cancel','']]:item.status==='approved'?[['취소','cancel','']]:item.status==='needs_review'?[['불출 완료 확인','confirm_completed','approve'],['미불출 확인','confirm_not_submitted','']]:[];
    for(const [text,op,cls]of actions)cell.append(button(text,()=>action(item,op),cls));
    cell.append(button('이력',async()=>{const history=await(await api('events/'+item.id)).json();$('db-panel').hidden=false;$('db-view').textContent=JSON.stringify(history,null,2);}));
    row.append(cell);$('items').append(row);
  }
  message('마지막 갱신 '+new Date().toLocaleTimeString());
}
$('login').onsubmit=async e=>{
  e.preventDefault();
  token=$('token').value.trim();$('token').value='';
  if(!/^\d{4}$/.test(token)){message('관리자 PIN은 숫자 4자리입니다.');token='';return;}
  try{await refresh();}catch(e){message(e.message);token='';}
};
$('logout').onclick=()=>{token='';location.reload();};
$('refresh').onclick=()=>refresh().catch(e=>message(e.message));
$('start-batch').onclick=async()=>{
  const label=$('queue-state').textContent;
  if(!confirm(label+'\n\n현재 승인된 요청을 한 번에 불출할까요?\n시작 후 새 승인건은 다음 배치로 넘어갑니다.'))return;
  try{const result=await(await api('batch/start',{})).json();message(result.count+'건 일괄 불출을 시작했습니다.');await refresh();}catch(e){message(e.message);}
};
$('pause').onclick=async()=>{
  if(!confirm('현재 일괄 불출을 중지할까요?\n처리 중이던 항목은 HOMS 실제 내역 확인이 필요할 수 있습니다.'))return;
  try{await api('pause',{paused:true});await refresh();}catch(e){message(e.message);}
};
setInterval(()=>{if(token && !document.hidden)refresh().catch(e=>message(e.message));},3000);
$('inspect').onclick=async()=>{try{const data=await(await api('database')).json();$('db-panel').hidden=false;$('db-view').textContent=JSON.stringify(data,null,2);}catch(e){message(e.message);}};
$('backup').onclick=async()=>{try{const blob=await(await api('backup')).blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='homself-'+new Date().toISOString().slice(0,10)+'.sqlite';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){message(e.message);}};
