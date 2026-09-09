/* A lost response MUST retry the same key AND payload, never create a new request. */
const pendingKey='homself.pending.v1';
const kioskPinOk=token=>/^\d{4}$/.test(token)||token.length>=32;
const kioskMaterialLabel=material=>String(material&&(material.display_name||material.material_name)||'').trim();
const kioskMaterialByCode=code=>(material_list||[]).find(item=>String(item.material_code)===String(code));

function upgradeKioskNav(){
  if(typeof document==='undefined')return;
  const back=document.getElementById('backbtn');
  if(back&&back.dataset.listNavReady!=='1'){
    back.dataset.listNavReady='1';
    back.classList.add('kiosk-nav-action','kiosk-back-action');
    back.setAttribute('aria-label','매니저 선택으로 돌아가기');
    back.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/><path d="M9 12h10"/></svg>';
  }
  const listButton=document.querySelector('[data-bs-target="#offcanvasBottom"]');
  if(listButton&&listButton.dataset.listNavReady!=='1'){
    listButton.dataset.listNavReady='1';
    listButton.classList.add('kiosk-nav-action','kiosk-list-action');
    listButton.setAttribute('aria-label','List 열기');
    listButton.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h11M8 12h11M8 18h11"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg><span class="kiosk-list-label">List</span><span id="cart-badge" class="kiosk-list-badge"></span>';
  }
}

function ensurePremiumCartShell(){
  if(typeof document==='undefined')return;
  upgradeKioskNav();
  const drawer=document.getElementById('offcanvasBottom');
  if(!drawer||drawer.dataset.premiumCartReady==='1')return;
  drawer.dataset.premiumCartReady='1';
  drawer.classList.add('premium-cart-drawer');

  const header=drawer.querySelector('.offcanvas-header');
  if(header){
    header.innerHTML='<div class="premium-cart-heading"><span class="premium-cart-eyebrow">MATERIAL REQUEST</span><h4 class="offcanvas-title" id="offcanvasBottomLabel">List</h4><span class="premium-cart-head-summary" id="cart-head-summary">선택한 부자재가 없습니다</span></div><button type="button" class="btn-close" data-bs-dismiss="offcanvas" aria-label="List 닫기"></button>';
  }

  const body=drawer.querySelector('.offcanvas-body');
  if(body){
    body.innerHTML='<div class="premium-cart-scroll" id="premium-cart-scroll"><div class="premium-cart-empty" id="cart-empty"><div><div class="premium-cart-empty-icon">≡</div><strong>아직 선택한 부자재가 없습니다</strong><span>필요한 부자재 카드를 터치하면<br>List에 바로 추가됩니다.</span></div></div><div id="cart-items" class="cart-items"></div></div><div class="premium-cart-footer"><div class="premium-cart-footer-summary"><span>선택한 품목</span><strong id="cart-footer-summary">0종 · 0단위</strong></div><button type="button" id="cart-review-btn" class="premium-cart-review" data-bs-toggle="modal" data-bs-target="#staticBackdrop" disabled><span>선택 내용 확인</span><span class="premium-cart-review-count" id="cart-review-count">0</span></button></div>';
  }

  drawer.addEventListener('shown.bs.offcanvas',()=>document.body.classList.add('list-panel-open'));
  drawer.addEventListener('hidden.bs.offcanvas',()=>document.body.classList.remove('list-panel-open'));

  const modal=document.getElementById('staticBackdrop');
  if(modal){
    modal.classList.add('premium-confirm-modal');
    const cancel=modal.querySelector('.modal-footer .btn-secondary');
    const send=modal.querySelector('#send-request');
    if(cancel)cancel.textContent='계속 선택';
    if(send)send.textContent='불출 요청하기';
  }
}

function materialImageCandidates(material){
  if(material&&material.image_data)return [material.image_data];
  const code=encodeURIComponent(material&&material.material_code||'');
  const base='/public/static/img/material_list/'+code;
  return [base+'.jpg',base+'.png',base+'.jpeg',base+'.webp'];
}

function createCartThumbnail(material){
  const wrap=document.createElement('div');
  wrap.className='cart-product-thumb';
  const fallback=document.createElement('div');
  fallback.className='cart-product-thumb-fallback';
  fallback.textContent='이미지 준비중';
  fallback.hidden=true;
  const img=document.createElement('img');
  img.alt=kioskMaterialLabel(material)||'부자재';
  const candidates=materialImageCandidates(material);
  let index=0;
  img.onload=()=>{fallback.hidden=true;img.hidden=false;};
  img.onerror=()=>{
    index+=1;
    if(index<candidates.length)img.src=candidates[index];
    else{img.hidden=true;fallback.hidden=false;}
  };
  img.src=candidates[0];
  wrap.append(img,fallback);
  return wrap;
}

function adjustListQuantity(code,delta){
  const key=String(code);
  const next=Math.max(0,(cartQuantities[key]||0)+delta);
  if(next===0)delete cartQuantities[key];
  else cartQuantities[key]=next;
  updateCart({focusCode:'',highlight:false});
}

function createCartProduct(code,material,count){
  const article=document.createElement('article');
  article.className='cart-item cart-product';
  article.dataset.materialCode=String(material.material_code);

  const main=document.createElement('div');
  main.className='cart-product-main';
  main.appendChild(createCartThumbnail(material));

  const info=document.createElement('div');
  info.className='cart-product-info';
  const name=document.createElement('h5');
  name.className='cart-product-name';
  name.textContent=kioskMaterialLabel(material)||material.material_name||code;
  info.appendChild(name);

  const specification=String(material.specification||'').trim();
  if(specification){
    const spec=document.createElement('div');
    spec.className='cart-product-spec';
    spec.textContent=specification;
    info.appendChild(spec);
  }

  const meta=document.createElement('div');
  meta.className='cart-product-meta';
  const codeMeta=document.createElement('span');
  codeMeta.textContent='상품코드 '+material.material_code;
  const unitMeta=document.createElement('span');
  unitMeta.textContent='불출단위 '+material.material_unit.toLocaleString('ko-KR')+'개';
  meta.append(codeMeta,unitMeta);
  info.appendChild(meta);

  const total=document.createElement('div');
  total.className='cart-product-total';
  total.dataset.role='total';
  info.appendChild(total);
  main.appendChild(info);

  const actions=document.createElement('div');
  actions.className='cart-product-actions';
  const remove=document.createElement('button');
  remove.type='button';
  remove.className='cart-remove';
  remove.textContent='삭제';
  remove.onclick=event=>{event.stopPropagation();removeFromCart(code);};

  const stepper=document.createElement('div');
  stepper.className='cart-stepper';
  const minus=document.createElement('button');
  minus.type='button';minus.setAttribute('aria-label','수량 줄이기');minus.textContent='−';
  minus.onclick=event=>{event.stopPropagation();adjustListQuantity(code,-1);};
  const value=document.createElement('span');
  value.className='cart-stepper-value';
  const valueNumber=document.createElement('b');
  valueNumber.dataset.role='count';
  const valueLabel=document.createElement('small');valueLabel.textContent='단위';
  value.append(valueNumber,valueLabel);
  const plus=document.createElement('button');
  plus.type='button';plus.setAttribute('aria-label','수량 늘리기');plus.textContent='+';
  plus.onclick=event=>{event.stopPropagation();adjustListQuantity(code,1);};
  stepper.append(minus,value,plus);
  actions.append(remove,stepper);
  article.append(main,actions);
  updateCartProduct(article,material,count);
  return article;
}

function updateCartProduct(article,material,count){
  const total=article.querySelector('[data-role="total"]');
  const countNode=article.querySelector('[data-role="count"]');
  if(total)total.textContent='총 '+(count*material.material_unit).toLocaleString('ko-KR')+'개';
  if(countNode)countNode.textContent=String(count);
}

function createModalCartProduct(material,count){
  const row=document.createElement('div');
  row.className='modal-cart-product';
  row.dataset.materialCode=String(material.material_code);
  const text=document.createElement('div');
  text.style.minWidth='0';
  const name=document.createElement('div');
  name.className='modal-cart-product-name';
  name.textContent=kioskMaterialLabel(material)||material.material_name||material.material_code;
  const meta=document.createElement('div');
  meta.className='modal-cart-product-meta';
  const specification=String(material.specification||'').trim();
  meta.textContent=(specification?specification+' · ':'')+'불출단위 '+material.material_unit.toLocaleString('ko-KR')+'개';
  text.append(name,meta);
  const qty=document.createElement('strong');
  qty.className='modal-cart-product-qty';
  qty.dataset.role='modal-qty';
  row.append(text,qty);
  updateModalCartProduct(row,material,count);
  return row;
}

function updateModalCartProduct(row,material,count){
  const qty=row.querySelector('[data-role="modal-qty"]');
  if(qty)qty.textContent=(count*material.material_unit).toLocaleString('ko-KR')+'개';
}

function validListEntries(){
  const valid=[];
  for(const code of Object.keys(cartQuantities||{})){
    const material=kioskMaterialByCode(code);
    const count=cartQuantities[code];
    if(!material||!Number.isSafeInteger(count)||count<1){delete cartQuantities[code];continue;}
    valid.push({code,material,count});
  }
  return valid;
}

function reconcileListRows(container,entries,modal=false){
  const liveCodes=new Set(entries.map(entry=>String(entry.code)));
  for(const child of Array.from(container.children)){
    if(child.dataset&&child.dataset.materialCode&&!liveCodes.has(String(child.dataset.materialCode)))child.remove();
  }
  for(const entry of entries){
    let row=container.querySelector(`[data-material-code="${CSS.escape(String(entry.code))}"]`);
    if(!row){
      row=modal?createModalCartProduct(entry.material,entry.count):createCartProduct(entry.code,entry.material,entry.count);
      container.appendChild(row);
    }else if(modal)updateModalCartProduct(row,entry.material,entry.count);
    else updateCartProduct(row,entry.material,entry.count);
  }
}

function updateListSummary(entries){
  const kinds=entries.length;
  const units=entries.reduce((sum,entry)=>sum+entry.count,0);
  const empty=document.getElementById('cart-empty');
  const headSummary=document.getElementById('cart-head-summary');
  const footerSummary=document.getElementById('cart-footer-summary');
  const review=document.getElementById('cart-review-btn');
  const reviewCount=document.getElementById('cart-review-count');
  if(empty)empty.hidden=kinds>0;
  if(headSummary)headSummary.textContent=kinds?`${kinds}종 · 선택 ${units}단위`:'선택한 부자재가 없습니다';
  if(footerSummary)footerSummary.textContent=`${kinds}종 · ${units}단위`;
  if(review)review.disabled=kinds<1;
  if(reviewCount)reviewCount.textContent=String(kinds);
  if(typeof updateBadge==='function')updateBadge();
}

function focusListItem(code,highlight=true){
  if(!code)return;
  const run=()=>{
    const row=document.querySelector(`#cart-items [data-material-code="${CSS.escape(String(code))}"]`);
    if(!row)return;
    if(highlight){
      row.classList.remove('cart-product-added');
      void row.offsetWidth;
      row.classList.add('cart-product-added');
      setTimeout(()=>row.classList.remove('cart-product-added'),320);
    }
    row.scrollIntoView({behavior:'smooth',block:'nearest'});
  };
  const drawer=document.getElementById('offcanvasBottom');
  if(drawer&&drawer.classList.contains('show'))requestAnimationFrame(run);
  else if(drawer)drawer.addEventListener('shown.bs.offcanvas',run,{once:true});
}

if(typeof renderMaterialCard==='function'){
  const baseRenderMaterialCard=renderMaterialCard;
  renderMaterialCard=function(material){
    if(material.visible===false)return;
    if(Number.isFinite(material.available_stock)&&material.available_stock<=0)return;
    baseRenderMaterialCard(material);
    const last=document.getElementById('material-lists')?.lastElementChild;
    const card=last?.querySelector('.material-card');
    const label=kioskMaterialLabel(material);
    const title=last?.querySelector('.card-title');
    const img=last?.querySelector('.material-image');
    if(card){card.dataset.materialCode=String(material.material_code);card.onclick=()=>addToCart(material.material_code);}
    if(title&&label)title.textContent=label;
    if(img&&label)img.alt=label;
    if(material.image_data&&img)img.src=material.image_data;
  };
}

if(typeof addToCart==='function'){
  addToCart=function(code){
    const material=kioskMaterialByCode(code);
    if(!material)return;
    const key=String(material.material_code);
    cartQuantities[key]=(cartQuantities[key]||0)+1;
    updateCart({focusCode:key,highlight:true});
  };
}

if(typeof removeFromCart==='function'){
  removeFromCart=function(code){delete cartQuantities[String(code)];updateCart({focusCode:'',highlight:false});};
}

if(typeof updateCart==='function'){
  updateCart=function(options={}){
    ensurePremiumCartShell();
    const cartItemsElement=document.getElementById('cart-items');
    const modalCartListElement=document.getElementById('modal-cart-list');
    if(!cartItemsElement||!modalCartListElement)return;
    const entries=validListEntries();
    reconcileListRows(cartItemsElement,entries,false);
    reconcileListRows(modalCartListElement,entries,true);
    updateListSummary(entries);

    const drawer=document.getElementById('offcanvasBottom');
    if(typeof bootstrap!=='undefined'&&drawer&&!drawer.classList.contains('show'))bootstrap.Offcanvas.getOrCreateInstance(drawer).show();
    if(options.focusCode)focusListItem(options.focusCode,options.highlight!==false);
  };
}

function showRequestSuccess(){
  if(!document||typeof document.createElement!=='function'||!document.body||!document.head)return Promise.resolve();
  return new Promise(resolve=>{
    let style=document.getElementById('homself-success-style');
    if(!style){
      style=document.createElement('style');style.id='homself-success-style';style.textContent=`.homself-success-overlay{position:fixed;inset:0;z-index:20000;display:flex;align-items:center;justify-content:center;padding:24px;font-family:'Jua',sans-serif;overflow:hidden;background:#111}.homself-success-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center;filter:brightness(.72);transform:none;background:#111}.homself-success-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.12),rgba(0,0,0,.38))}.homself-success-card{position:relative;z-index:2;width:min(520px,94vw);background:rgba(255,255,255,.94);backdrop-filter:blur(5px);border-radius:24px;padding:42px 32px 30px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.35)}.homself-success-icon{width:72px;height:72px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;background:#d1e7dd;color:#198754;font-size:42px;line-height:1}.homself-success-title{margin:0;font-size:2.2rem;font-weight:400;color:#20242b}.homself-success-text{margin:16px 0 12px;color:#606b78;font-size:1.25rem;line-height:1.5}.homself-success-countdown{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;margin:0 0 18px;border-radius:999px;background:#eef2f6;color:#667180;font-family:system-ui,sans-serif;font-size:.8rem;font-weight:700;line-height:1}.homself-success-button{width:100%;border:0;border-radius:14px;padding:15px 20px;background:#0d6efd;color:#fff;font:inherit;font-size:1.3rem;cursor:pointer}@media(max-width:600px){.homself-success-card{padding:34px 22px 24px}.homself-success-title{font-size:1.9rem}.homself-success-text{font-size:1.1rem}}`;document.head.appendChild(style);
    }
    const imageNumber=Math.floor(Math.random()*11)+1,backgroundSrc='/public/static/img/main_img/main'+imageNumber+'.png';const overlay=document.createElement('div');overlay.className='homself-success-overlay';overlay.innerHTML=`<img class="homself-success-bg" src="${backgroundSrc}" alt=""><div class="homself-success-shade"></div><div class="homself-success-card" role="dialog" aria-modal="true" aria-labelledby="homself-success-title"><div class="homself-success-icon">✓</div><h2 class="homself-success-title" id="homself-success-title">요청 접수 완료</h2><p class="homself-success-text">관리자 승인 후 불출이 진행됩니다.</p><div class="homself-success-countdown" aria-label="자동 확인 카운트다운">3</div><button class="homself-success-button" type="button">확인</button></div>`;document.body.appendChild(overlay);
    const btn=overlay.querySelector('button'),countdown=overlay.querySelector('.homself-success-countdown');let remaining=3,done=false,timer=null,interval=null;const finish=()=>{if(done)return;done=true;clearTimeout(timer);clearInterval(interval);overlay.remove();resolve();};btn.focus();btn.onclick=finish;interval=setInterval(()=>{remaining-=1;if(remaining>0)countdown.textContent=String(remaining);},1000);timer=setTimeout(finish,3000);
  });
}

window.getHomselfCatalog=async function(){try{let token=sessionStorage.getItem('homself.kiosk.token');if(!token)token=prompt('지점 키오스크 PIN 4자리를 입력하세요.');if(!token)return null;token=token.trim();if(!kioskPinOk(token)){sessionStorage.removeItem('homself.kiosk.token');throw Error('키오스크 PIN은 숫자 4자리입니다. 기존 긴 키는 전환 기간에만 사용할 수 있습니다.');}const response=await fetch('/api/catalog',{headers:{Authorization:'Bearer '+token}});if(!response.ok){sessionStorage.removeItem('homself.kiosk.token');throw Error('기준정보 조회 실패. 키오스크 PIN과 서버 설정을 확인하세요.');}sessionStorage.setItem('homself.kiosk.token',token);return await response.json();}catch(error){alert(error.message);return null;}};

async function transmitPending(){const pending=JSON.parse(localStorage.getItem(pendingKey)||'null');if(!pending)return;let token=sessionStorage.getItem('homself.kiosk.token');if(!token){token=prompt('지점 키오스크 PIN 4자리를 입력하세요. 관리자 PIN이 아닙니다.');if(!token)return;}token=token.trim();if(!kioskPinOk(token)){sessionStorage.removeItem('homself.kiosk.token');throw new Error('키오스크 PIN은 숫자 4자리입니다.');}sessionStorage.setItem('homself.kiosk.token',token);const response=await fetch('/api/requests',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'Idempotency-Key':pending.key},body:JSON.stringify(pending.body)});const result=await response.json();if(!response.ok){if(response.status===401||response.status===429)sessionStorage.removeItem('homself.kiosk.token');if(response.status===400)localStorage.removeItem(pendingKey);throw new Error(result.error||'접수 결과를 확인하지 못했습니다.');}localStorage.removeItem(pendingKey);await showRequestSuccess();location.assign('/main');}

window.sendCart=async function(){if(window.homselfSending)return;try{if(!localStorage.getItem(pendingKey)){const items=Object.entries(cartQuantities).map(([code,count])=>{const m=kioskMaterialByCode(code);if(!m)throw new Error('List 자재코드를 기준정보에서 찾지 못했습니다: '+code);return {material_code:String(m.material_code),quantity:count*m.material_unit};});if(!items.length){alert('List가 비어 있습니다.');return;}if(items.some(i=>!Number.isSafeInteger(i.quantity)||i.quantity<1||i.quantity>100000)){alert('수량은 1~100000 범위여야 합니다.');return;}const manager_name=new URLSearchParams(location.search).get('managerName');if(!manager_name){alert('매니저를 다시 선택하세요.');return;}const pending={key:crypto.randomUUID(),body:{manager_name,items}};localStorage.setItem(pendingKey,JSON.stringify(pending));}else if(!confirm('접수 확인이 끝나지 않은 이전 요청을 같은 번호로 재확인합니다. 계속할까요?'))return;window.homselfSending=true;if(typeof timeoutId!=='undefined')clearTimeout(timeoutId);if(typeof countdownInterval!=='undefined')clearInterval(countdownInterval);await transmitPending();}catch(error){alert(error.message+'\n기존 요청은 보존했습니다. 새 요청을 만들지 말고 재확인하세요.');}finally{window.homselfSending=false;}};

ensurePremiumCartShell();
const notice=document.getElementById('pending-notice');if(notice&&localStorage.getItem(pendingKey)){notice.hidden=false;notice.textContent='접수 확인이 끝나지 않은 요청이 있습니다. 새 요청 전에 확인하세요. ';const button=document.createElement('button');button.textContent='같은 요청 재확인';button.onclick=async()=>{button.disabled=true;try{await transmitPending();}catch(e){alert(e.message);}finally{button.disabled=false;}};notice.append(button);const managerLists=document.getElementById('manager-lists');if(managerLists)managerLists.style.display='none';}