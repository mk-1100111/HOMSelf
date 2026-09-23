(()=>{
  const LIST_ID='list';

  function isTruncated(node){
    if(!node)return false;
    return node.scrollWidth>node.clientWidth+1 || node.scrollHeight>node.clientHeight+1;
  }

  function bindField(node,label){
    if(!node||node.dataset.expandBound==='1')return;
    node.dataset.expandBound='1';

    const wrap=document.createElement('div');
    wrap.className='manage-expand-line';
    node.parentNode.insertBefore(wrap,node);
    wrap.appendChild(node);

    const button=document.createElement('button');
    button.type='button';
    button.className='manage-expand-toggle';
    button.setAttribute('aria-expanded','false');
    button.setAttribute('aria-label',label+' 전체 보기');
    button.title=label+' 전체 보기';
    button.innerHTML='<span aria-hidden="true">⌄</span>';
    wrap.appendChild(button);

    button.addEventListener('click',()=>{
      const expanded=node.classList.toggle('is-expanded-text');
      button.setAttribute('aria-expanded',expanded?'true':'false');
      button.setAttribute('aria-label',expanded?label+' 접기':label+' 전체 보기');
      button.title=expanded?label+' 접기':label+' 전체 보기';
      button.innerHTML=expanded?'<span aria-hidden="true">⌃</span>':'<span aria-hidden="true">⌄</span>';
    });

    const refresh=()=>{
      if(node.classList.contains('is-expanded-text')){
        button.hidden=false;
        return;
      }
      button.hidden=!isTruncated(node);
    };

    requestAnimationFrame(refresh);
    if(typeof ResizeObserver==='function'){
      const observer=new ResizeObserver(refresh);
      observer.observe(wrap);
      observer.observe(node);
    }else{
      window.addEventListener('resize',refresh,{passive:true});
    }
  }

  function applyToggles(card){
    if(!card)return;
    bindField(card.querySelector('h3'),'자재명');
    bindField(card.querySelector('.manage-meta'),'상세정보');
  }

  function scan(){
    const list=document.getElementById(LIST_ID);
    if(!list)return;
    list.querySelectorAll('.manage-card').forEach(applyToggles);
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
