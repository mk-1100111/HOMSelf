let token='';
const $=id=>document.getElementById(id);
const labels={pending:'접수',approved:'승인',claimed:'준비 중',submitting:'불출 중',completed:'완료',needs_review:'확인 필요',cancelled:'취소'};
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
    note=prompt('확인 근거: 불출번호 또는 조회 시각·담당자·수량을 적으세요.') || '';
    if(note.trim().length<10)return;
  } else if(!confirm(item.manager_name+' / '+item.material_name+' / '+item.quantity+'개를 '+(operation==='approve'?'승인':'취소')+'할까요?'))return;
  await api('items/'+item.id,{action:operation,note});await refresh();
}
function button(text,fn){const b=document.createElement('button');b.textContent=text;b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){message(e.message);}finally{b.disabled=false;}};return b;}
let refreshing=false;
async function refresh(){
  if(refreshing || !token)return;
  refreshing=true;
  try{await refreshData();}finally{refreshing=false;}
}
async function refreshData(){
  const data=await (await api('overview')).json();$('controls').hidden=false;
  $('run-state').textContent=data.paused?'자동 불출 일시정지':'승인된 요청 처리 허용';
  $('worker-state').textContent=data.worker?'회사 PC 마지막 응답: '+new Date(data.worker.last_seen).toLocaleString()+' / '+data.worker.mode:'회사 PC 응답 기록 없음';
  $('items').replaceChildren();
  for(const item of data.items){
    const row=document.createElement('tr');
    for(const text of [new Date(item.created_at).toLocaleString()+'\n'+item.id,item.manager_name,item.material_name+'\n'+item.material_code,item.quantity,labels[item.status]]){
      const cell=document.createElement('td');cell.textContent=text;row.append(cell);
    }
    const cell=document.createElement('td');
    const actions=item.status==='pending'?[['승인','approve'],['취소','cancel']]:item.status==='approved'?[['취소','cancel']]:item.status==='needs_review'?[['실제 불출 완료 확인','confirm_completed'],['미불출 확인 → 재승인 대기','confirm_not_submitted']]:[];
    for(const [text,op]of actions)cell.append(button(text,()=>action(item,op)));
    cell.append(button('이력',async()=>{const data=await(await api('events/'+item.id)).json();$('db-panel').hidden=false;$('db-view').textContent=JSON.stringify(data,null,2);}));
    row.append(cell);$('items').append(row);
  }
  message('갱신: '+new Date().toLocaleTimeString());
}
$('login').onsubmit=async e=>{e.preventDefault();token=$('token').value.trim();$('token').value='';try{await refresh();}catch(e){message(e.message);}};
$('logout').onclick=()=>{token='';location.reload();};
$('refresh').onclick=()=>refresh().catch(e=>message(e.message));
setInterval(()=>{if(token && !document.hidden)refresh().catch(e=>message(e.message));},5000);
for(const [id,paused]of [['pause',true],['resume',false]])$(id).onclick=async()=>{
  if(!confirm(paused?'진행 중인 항목은 확인 필요로 바뀝니다. PC 프로그램도 종료하세요.':'승인된 요청의 처리를 허용할까요?'))return;
  try{await api('pause',{paused});await refresh();}catch(e){message(e.message);}
};
$('inspect').onclick=async()=>{try{const data=await(await api('database')).json();$('db-panel').hidden=false;$('db-view').textContent=JSON.stringify(data,null,2);}catch(e){message(e.message);}};
$('backup').onclick=async()=>{try{const blob=await(await api('backup')).blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='homself-'+new Date().toISOString().slice(0,10)+'.sqlite';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){message(e.message);}};
