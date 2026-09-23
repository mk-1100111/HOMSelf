(()=>{
  const LIST_ID='list';

  function isTruncated(node){
    if(!node)return false;
    return node.scrollWidth>node.clientWidth+1 || node.scrollHeight>node.clientHeight+1;
  }

  function applyToggle(card){
    if(!card||card.dataset.expandBound==='1')return;
    card.dataset.expandBound='1';

    const title=card.querySelector('h3');
    const meta=card.querySelector('.manage-meta');
    if(!title&&!meta)return;

    const button=document.createElement('button');
    button.type='button';
    button.className='manage-expand-toggle';
    button.setAttribute('aria-expanded','false');
    button.setAttribute('aria-label','잘린 항목 전체 보기');
    button.title='잘린 항목 전체 보기';
    button.innerHTML='<span aria-hidden="true">⌄</span>';

    button.addEventListener('click',()=>{
      const expanded=card.classList.toggle('is-expanded');
      button.setAttribute('aria-expanded',expanded?'true':'false');
      button.setAttribute('aria-label',expanded?'항목 접기':'잘린 항목 전체 보기');
      button.title=expanded?'항목 접기':'잘린 항목 전체 보기';
      button.innerHTML=expanded?'<span aria-hidden="true">⌃</span>':'<span aria-hidden="true">⌄</span>';
    });

    card.appendChild(button);

    const refresh=()=>{
      if(card.classList.contains('is-expanded')){
        button.hidden=false;
        return;
      }
      button.hidden=!(isTruncated(title)||isTruncated(meta));
    };

    requestAnimationFrame(refresh);
    if(typeof ResizeObserver==='function'){
      const observer=new ResizeObserver(refresh);
      observer.observe(card);
      if(title)observer.observe(title);
      if(meta)observer.observe(meta);
    }else{
      window.addEventListener('resize',refresh,{passive:true});
    }
  }

  function scan(){
    const list=document.getElementById(LIST_ID);
    if(!list)return;
    list.querySelectorAll('.manage-card').forEach(applyToggle);
  }

  function start(){
    const list=document.getElementById(LIST_ID);
    if(!list)return;
    scan();
    const observer=new MutationObserver(scan);
    observer.observe(list,{childList:true,subtree:false});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
