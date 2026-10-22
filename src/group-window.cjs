function selectRange(checked,ids,anchor,id,shift,value){
  const result=new Set(checked),a=ids.indexOf(anchor),b=ids.indexOf(id);
  if(shift&&a>=0&&b>=0){for(const item of ids.slice(Math.min(a,b),Math.max(a,b)+1))result.add(item);}
  else if(value)result.add(id);else result.delete(id);
  return {checked:result,anchor:shift&&a>=0?anchor:id};
}
function fit(box,width,height){const w=Math.min(Math.max(480,box.width),width-16),h=Math.min(Math.max(320,box.height),height-16);return {left:Math.max(8,Math.min(box.left,width-w-8)),top:Math.max(8,Math.min(box.top,height-h-8)),width:w,height:h};}
function installWindow(modal){
  const el=modal.modalEl,doc=el.ownerDocument,win=doc.defaultView;let cleanup=()=>{};
  const set=box=>{box=fit(box,win.innerWidth,win.innerHeight);Object.assign(el.style,{position:'fixed',left:box.left+'px',top:box.top+'px',width:box.width+'px',height:box.height+'px',margin:'0',maxWidth:'none',maxHeight:'none'});return box;};
  const rect=()=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};};
  if(modal.plugin.groupWindow?.box)set(modal.plugin.groupWindow.box);
  const save=()=>{modal.plugin.groupWindow={box:rect(),side:modal.sideWidth};modal.plugin.persist();};
  const down=e=>{
    if(e.button!==0)return;
    const edge=e.target.closest('.pm-window-edge')?.dataset.edge,divider=e.target.closest('.pm-group-divider');
    // Native scrollbars must retain pointer input instead of starting a window drag.
    if(!edge&&!divider&&e.target.scrollHeight>e.target.clientHeight&&e.clientX>=e.target.getBoundingClientRect().left+e.target.clientWidth)return;
    if(!edge&&!divider&&e.target.closest('button,input,select,textarea,a,.pm-group-plugin-row,.pm-group-nav-item,.pm-group-note,.pm-group-error,.pm-group-picker,.modal-close-button'))return;
    if(!edge&&!divider&&win.getSelection()?.toString())return;
    const start=rect(),x=e.clientX,y=e.clientY,side=modal.contentEl.querySelector('.pm-group-sidebar'),initial=side.getBoundingClientRect().width;
    cleanup();e.preventDefault();el.classList.add('pm-window-dragging');
    const move=v=>{const dx=v.clientX-x,dy=v.clientY-y;
      if(divider){modal.sideWidth=Math.max(130,Math.min(initial+dx,el.clientWidth-300));side.style.flexBasis=modal.sideWidth+'px';return;}
      const b={...start};if(!edge){b.left+=dx;b.top+=dy;}else{
        if(edge.includes('e'))b.width+=dx;if(edge.includes('s'))b.height+=dy;
        if(edge.includes('w')){b.width=Math.max(Math.min(480,win.innerWidth-16),start.width-dx);b.left=start.left+start.width-b.width;}
        if(edge.includes('n')){b.height=Math.max(Math.min(320,win.innerHeight-16),start.height-dy);b.top=start.top+start.height-b.height;}
      }set(b);
    };
    const end=()=>{cleanup();save();};
    cleanup=()=>{doc.removeEventListener('pointermove',move);doc.removeEventListener('pointerup',end);doc.removeEventListener('pointercancel',end);win.removeEventListener('blur',end);el.classList.remove('pm-window-dragging');};
    doc.addEventListener('pointermove',move);doc.addEventListener('pointerup',end);doc.addEventListener('pointercancel',end);win.addEventListener('blur',end);
  };
  for(const edge of ['n','s','e','w','ne','nw','se','sw'])el.createDiv({cls:'pm-window-edge pm-edge-'+edge,attr:{'data-edge':edge,'aria-hidden':'true'}});
  const resized=()=>{set(rect());const side=modal.contentEl.querySelector('.pm-group-sidebar');if(side)side.style.flexBasis=Math.min(modal.sideWidth,el.clientWidth-300)+'px';};
  el.addEventListener('pointerdown',down);win.addEventListener('resize',resized);
  return ()=>{cleanup();el.removeEventListener('pointerdown',down);win.removeEventListener('resize',resized);};
}
module.exports={selectRange,fit,installWindow};
