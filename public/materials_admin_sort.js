(() => {
  const list=document.getElementById('list');
  if(!list)return;
  const sortVisibleFirst=()=>{
    const cards=[...list.children];
    const visible=cards.filter(card=>card.querySelector('.toggle input')?.checked!==false);
    const hidden=cards.filter(card=>card.querySelector('.toggle input')?.checked===false);
    const ordered=visible.concat(hidden);
    if(ordered.some((card,index)=>card!==cards[index]))list.append(...ordered);
  };
  new MutationObserver(sortVisibleFirst).observe(list,{childList:true});
  sortVisibleFirst();
})();