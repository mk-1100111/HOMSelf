const KEY='homself.admin.token';
let token=sessionStorage.getItem(KEY)||'';
if(!token)location.replace('/admin');
let rows=[];
let inventorySyncCompletedAt=null;
let inventorySyncWatchBusy=false;
const $=id=>document.getElementById(id);

function authLost(){
  token='';
  sessionStorage.removeItem(KEY);
  if(window.homselfAdminNavHide)window.homselfAdminNavHide();
  location.replace('/admin');
}

async function api(path,body){
  const isGet=body===undefined;
  const requestPath=isGet?path+(path.includes('?')?'&':'?')+'_='+Date.now():path;
  const r=await fetch('/api/admin/'+requestPath,{
    method:isGet?'GET':'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    cache:'no-store',
    ...(isGet?{}:{body:JSON.stringify(body)})
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok){
    if(r.status===401||r.status===429)authLost();
    throw Error(d.error||'요청 실패');
  }
  return d;
}

async function compress(file){
  if(!file)return null;
  if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw Error('JPEG/PNG/WebP 이미지만 가능합니다.');
  const bitmap=await createImageBitmap(file);
  const max=900;
  const scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
  let q=.82;
  let data;
  do{data=canvas.toDataURL('image/jpeg',q);q-=.08;}while(data.length>700000&&q>.42);
  if(data.length>800000)throw Error('이미지 용량을 충분히 줄이지 못했습니다. 더 작은 사진을 사용하세요.');
  return data;
}

function persistenceText(persistence,success='저장 완료'){
  if(!persistence)return success;
  if(persistence.pending)return persistence.error
    ?'서버 반영 완료 · GitHub 직접 저장 실패, Worker 재시도 대기: '+persistence.error
    :'서버 반영 완료 · GitHub 영구 저장 재시도 대기 중';
  return persistence.commit?success+' · GitHub 영구 저장 완료':success;
}

async function patch(code,patchData){
  $('status').textContent='저장 중...';
  const d=await api('catalog-management',{type:'material',key:code,patch:patchData});
  $('status').textContent=persistenceText(d.persistence);
  await load();
}

async function manualRelease(item){
  const label=item.display_name||item.material_name||item.material_code;
  const stock=Number.isFinite(item.stock_quantity)?item.stock_quantity:null;
  const guide=stock===null
    ?label+'\n임의불출 수량을 입력하세요.'
    :label+'\n현재 HOMS 재고 '+stock.toLocaleString('ko-KR')+'개\n임의불출 수량을 입력하세요.';
  const raw=prompt(guide,'1');
  if(raw===null)return false;
  const quantity=Number(String(raw).trim());
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>100000)throw Error('임의불출 수량은 1~100000 정수로 입력하세요.');
  if(stock!==null&&quantity>stock)throw Error('현재 HOMS 재고보다 많은 수량은 임의불출할 수 없습니다.');
  if(!confirm(label+' '+quantity.toLocaleString('ko-KR')+'개를 임의불출로 승인 시트에 올릴까요?\n실제 일괄불출 시 김무경으로 불출됩니다.'))return false;
  $('status').textContent='임의불출 등록 중...';
  const requestKey=(crypto&&typeof crypto.randomUUID==='function')?crypto.randomUUID():'manual-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  const d=await api('manual-release',{material_code:item.material_code,quantity,request_key:requestKey});
  $('status').textContent=(d.duplicate?'기존 임의불출 요청 확인 · ':'임의불출 등록 완료 · ')+label+' '+quantity.toLocaleString('ko-KR')+'개 · 승인 시트의 임의불출 그룹에 추가됨';
  await load();
  return true;
}

function materialImage(img,item,placeholder){
  if(item.image_data){img.src=item.image_data;return;}
  const base='/public/static/img/material_list/'+encodeURIComponent(item.material_code);
  const candidates=[base+'.jpg',base+'.png',base+'.jpeg',base+'.webp'];
  let index=0;
  img.onerror=()=>{
    index++;
    if(index<candidates.length)img.src=candidates[index];
    else{img.hidden=true;placeholder.hidden=false;}
  };
  img.src=candidates[0];
}

function stockBadge(item){
  if(!Number.isFinite(item.available_stock))return null;
  const badge=document.createElement('span');
  badge.className='manage-stock-badge';
  badge.textContent=item.available_stock.toLocaleString('ko-KR');
  badge.title='키오스크 사용 가능 재고';
  return badge;
}

function card(item){
  const el=document.createElement('article');
  el.className='manage-card';

  const imageWrap=document.createElement('div');
  imageWrap.className='manage-image-wrap';
  const badge=stockBadge(item);
  if(badge)imageWrap.appendChild(badge);

  const placeholder=Object.assign(document.createElement('div'),{className:'image-placeholder',textContent:'이미지 준비중'});
  placeholder.hidden=true;
  const img=document.createElement('img');
  img.alt=item.display_name||item.material_name;
  img.onload=()=>{placeholder.hidden=true;img.hidden=false;};
  materialImage(img,item,placeholder);
  imageWrap.append(img,placeholder);

  const h=document.createElement('h3');
  h.textContent=item.display_name||item.material_name;

  const meta=document.createElement('div');
  meta.className='manage-meta';
  meta.textContent=item.material_name+' · '+item.material_code+(item.specification?' · '+item.specification:'');

  const nameEditor=document.createElement('div');
  nameEditor.className='manage-name-editor';
  const nameLabel=document.createElement('label');
  nameLabel.textContent='키오스크 표시명';
  const nameInput=document.createElement('input');
  nameInput.type='text';
  nameInput.maxLength=80;
  nameInput.value=item.display_name||'';
  nameInput.placeholder=item.material_name;
  nameInput.setAttribute('aria-label',item.material_name+' 키오스크 표시명');
  const nameActions=document.createElement('div');
  nameActions.className='manage-row manage-name-actions';
  const nameSave=document.createElement('button');
  nameSave.className='primary';
  nameSave.textContent='표시명 저장';
  const saveName=()=>patch(item.material_code,{display_name:nameInput.value.trim()}).catch(e=>$('status').textContent=e.message);
  nameSave.onclick=saveName;
  nameInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();saveName();}};
  const nameReset=document.createElement('button');
  nameReset.className='secondary';
  nameReset.textContent='원본 이름 사용';
  nameReset.onclick=()=>patch(item.material_code,{display_name:null}).catch(e=>$('status').textContent=e.message);
  nameActions.append(nameSave,nameReset);
  nameEditor.append(nameLabel,nameInput,nameActions);

  const toggle=document.createElement('label');
  toggle.className='toggle';
  const cb=document.createElement('input');
  cb.type='checkbox';
  cb.checked=item.visible!==false;
  cb.onchange=()=>patch(item.material_code,{visible:cb.checked}).catch(e=>{$('status').textContent=e.message;cb.checked=!cb.checked;});
  toggle.append(cb,document.createTextNode(' 키오스크 노출'));

  const row1=document.createElement('div');
  row1.className='manage-row';
  const unit=document.createElement('input');
  unit.type='number';
  unit.min='1';
  unit.max='100000';
  unit.value=item.material_unit||1;
  const save=document.createElement('button');
  save.className='primary';
  save.textContent='불출단위 저장';
  save.onclick=()=>patch(item.material_code,{material_unit:Number(unit.value)}).catch(e=>$('status').textContent=e.message);
  row1.append(unit,save);

  const row2=document.createElement('div');
  row2.className='manage-row';
  const file=document.createElement('input');
  file.type='file';
  file.accept='image/jpeg,image/png,image/webp';
  const up=document.createElement('button');
  up.className='primary';
  up.textContent='사진 변경';
  up.onclick=async()=>{
    try{
      const data=await compress(file.files[0]);
      if(!data)return;
      $('status').textContent='이미지 처리 중...';
      await patch(item.material_code,{image_data:data});
    }catch(e){$('status').textContent=e.message;}
  };
  const del=document.createElement('button');
  del.className='danger';
  del.textContent='사진 초기화';
  del.onclick=()=>patch(item.material_code,{image_data:null}).catch(e=>$('status').textContent=e.message);
  row2.append(file,up,del);

  const row3=document.createElement('div');
  row3.className='manage-row';
  const manual=document.createElement('button');
  manual.className='danger';
  manual.textContent='임의불출';
  manual.title='재고 보정을 위해 승인 시트에 임의불출 건을 추가합니다. 실제 HOMS 불출 담당자는 김무경입니다.';
  manual.disabled=!Number.isFinite(item.stock_quantity)||item.stock_quantity<=0;
  if(manual.disabled)manual.title='HOMS 재고 동기화 후 재고가 있는 품목에서 사용할 수 있습니다.';
  manual.onclick=async()=>{
    manual.disabled=true;
    try{await manualRelease(item);}catch(e){$('status').textContent=e.message;}finally{manual.disabled=!Number.isFinite(item.stock_quantity)||item.stock_quantity<=0;}
  };
  row3.append(manual);

  el.append(imageWrap,h,meta,nameEditor,toggle,row1,row2,row3);
  return el;
}

function render(){
  const q=$('search').value.trim().toLowerCase();
  const filtered=rows.filter(x=>{
    if(!q)return true;
    return String(x.material_name||'').toLowerCase().includes(q)
      ||String(x.display_name||'').toLowerCase().includes(q)
      ||String(x.material_code||'').toLowerCase().includes(q);
  });
  filtered.sort((a,b)=>(a.visible===false)-(b.visible===false));
  $('list').replaceChildren(...filtered.map(card));
}

async function load(){
  const d=await api('catalog-management');
  rows=d.materials||[];
  if(window.homselfAdminNavShow)window.homselfAdminNavShow();
  $('count').textContent='총 '+rows.length+'개 부자재';
  if(d.persistence&&d.persistence.pending)$('status').textContent=persistenceText(d.persistence);
  render();
}

async function watchInventorySync(){
  if(inventorySyncWatchBusy||document.hidden||!token)return;
  inventorySyncWatchBusy=true;
  try{
    const overview=await api('overview');
    const state=overview.inventory_sync||{};
    const completedAt=Number(state.completed_at||0);
    if(inventorySyncCompletedAt===null){
      inventorySyncCompletedAt=completedAt;
      return;
    }
    if(completedAt!==inventorySyncCompletedAt){
      inventorySyncCompletedAt=completedAt;
      await load();
      $('status').textContent='재고 동기화 완료 · 뱃지 수량을 최신 재고로 갱신했습니다.';
    }
  }finally{
    inventorySyncWatchBusy=false;
  }
}

$('search').oninput=render;
$('logout').onclick=authLost;
load().catch(e=>$('status').textContent=e.message);
setInterval(()=>watchInventorySync().catch(()=>{}),1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)watchInventorySync().catch(()=>{});});