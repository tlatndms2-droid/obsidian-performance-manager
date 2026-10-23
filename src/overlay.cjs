const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
function fitBox(box={},width,height){
  const maxW=Math.max(1,width-16),maxH=Math.max(1,height-16);
  const w=clamp(Number.isFinite(box.w)?box.w:260,Math.min(160,maxW),maxW);
  const h=clamp(Number.isFinite(box.h)?box.h:230,Math.min(95,maxH),maxH);
  return {w,h,x:clamp(Number.isFinite(box.x)?box.x:width-w-58,8,Math.max(8,width-w-8)),y:clamp(Number.isFinite(box.y)?box.y:12,8,Math.max(8,height-h-8))};
}
function dragBox(box,dx,dy,width,height){return fitBox({...box,x:box.x+dx,y:box.y+dy},width,height);}
function resizeBox(box,dx,dy,width,height){
  const right=box.x+box.w,minW=Math.min(160,right-8);
  const x=clamp(box.x+dx,8,right-minW);
  return fitBox({...box,x,w:right-x,h:box.h+dy},width,height);
}

class WindowOverlay {
  constructor(plugin,doc){
    Object.assign(this,{plugin,doc,wrapper:doc.documentElement});this.cleanups=[];
    this.root=doc.body.createDiv({cls:'pm-window-overlay',attr:{'aria-label':'성능 오버레이'}});
    this.handle=this.root.createEl('button',{cls:'pm-overlay-drag',attr:{'aria-label':'성능 오버레이 위치 이동','title':'드래그로 이동 · 방향키로 이동'}});this.handle.createSpan();
    this.list=this.root.createDiv({cls:'pm-overlay-list'});
    this.footer=this.root.createDiv({cls:'pm-overlay-footer'});
    this.resize=this.footer.createEl('button',{cls:'pm-overlay-resize',attr:{'aria-label':'성능 오버레이 크기 조절','title':'왼쪽 아래로 드래그해 확대 · 방향키로 조절'}});
    this.measure=this.footer.createEl('button',{cls:'pm-overlay-measure'});
    this.measure.onclick=()=>plugin.recorder.state==='idle'?plugin.start(false):plugin.stop();
    for(const name of ['pointerdown','click','dblclick','wheel','keydown']){
      const stop=e=>e.stopPropagation();this.root.addEventListener(name,stop);this.cleanups.push(()=>this.root.removeEventListener(name,stop));
    }
    this.bindDrag(this.handle,false);this.bindDrag(this.resize,true);
    this.observer=new doc.defaultView.ResizeObserver(()=>{if(!this.gesture)this.layout();});this.observer.observe(this.wrapper);
    this.render();
  }
  layout(){
    this.box=fitBox(this.plugin.overlaySettings.box,this.wrapper.clientWidth,this.wrapper.clientHeight);
    for(const [key,value] of Object.entries({left:this.box.x,top:this.box.y,width:this.box.w,height:this.box.h}))this.root.style[key]=value+'px';
  }
  bindDrag(element,resizing){
    const down=e=>{
      if(e.button!==0)return;e.preventDefault();this.layout();
      this.gesture={id:e.pointerId,x:e.clientX,y:e.clientY,box:{...this.box}};element.setPointerCapture(e.pointerId);
    };
    const move=e=>{
      const g=this.gesture;if(!g||g.id!==e.pointerId)return;
      const fn=resizing?resizeBox:dragBox;this.box=fn(g.box,e.clientX-g.x,e.clientY-g.y,this.wrapper.clientWidth,this.wrapper.clientHeight);
      this.plugin.overlaySettings.box={...this.box};this.layout();
    };
    const end=e=>{
      if(!this.gesture||e.pointerId!==this.gesture.id)return;this.gesture=null;
      if(element.hasPointerCapture(e.pointerId))element.releasePointerCapture(e.pointerId);
      this.plugin.overlaySettings.box={...this.box};this.plugin.refreshOverlays();this.plugin.persist();
    };
    const key=e=>{
      if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();
      const dx=e.key==='ArrowLeft'?-10:e.key==='ArrowRight'?10:0,dy=e.key==='ArrowUp'?-10:e.key==='ArrowDown'?10:0;
      this.layout();this.plugin.overlaySettings.box=(resizing?resizeBox:dragBox)(this.box,dx,dy,this.wrapper.clientWidth,this.wrapper.clientHeight);
      this.layout();this.plugin.persist();
    };
    for(const [name,fn] of [['pointerdown',down],['pointermove',move],['pointerup',end],['pointercancel',end],['lostpointercapture',end],['keydown',key]]){element.addEventListener(name,fn);this.cleanups.push(()=>element.removeEventListener(name,fn));}
  }
  render(){
    const shown=!!this.plugin.overlaySettings.shown;this.root.hidden=!shown;this.layout();if(!shown)return;
    const r=this.plugin.recorder,live=r.state!=='idle';const result=live?r.snapshot():this.plugin.last;
    const total=result?.total;const entries=new Map(this.plugin.catalog().map(p=>[p.id,p]));for(const p of result?.catalog||[])entries.set(p.id,p);
    const rows=[...entries.values()].sort((a,b)=>(total?.plugins[b.id]?.ms||0)-(total?.plugins[a.id]?.ms||0)||a.name.localeCompare(b.name,'ko'));
    const maximum=Math.max(1,...Object.values(total?.plugins||{}).map(p=>p.ms));const scroll=this.list.scrollTop;this.list.empty();
    for(const p of rows){
      const group=total?.plugins[p.id];const row=this.list.createDiv({cls:'pm-overlay-row'});const line=row.createDiv({cls:'pm-overlay-line'});
      line.createSpan({cls:'pm-overlay-name',text:p.name,attr:{title:p.name}});
      line.createSpan({cls:'pm-overlay-value',text:group?.samples?new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(group.ms)+' ms':!p.enabled?'꺼짐':result?'미확인':'측정 전'});
      if(group?.samples){const track=row.createDiv({cls:'pm-overlay-track'});track.createDiv({cls:'pm-overlay-fill'}).style.width=group.ms/maximum*100+'%';}
    }
    this.list.scrollTop=scroll;
    const busy=r.state==='starting'||r.state==='stopping';this.measure.disabled=busy;
    this.measure.textContent=busy?'처리 중':live?'■ 측정 종료':'● 측정 시작';
    const error=r.error||this.plugin.saveError;
    if(error)this.list.createDiv({cls:'pm-overlay-error',text:error,attr:{role:'alert'}});
    this.root.setAttribute('title','처리 시간 추정치 · 약 10초마다 갱신 · 숨겨도 측정은 유지');
  }
  destroy(){this.observer.disconnect();for(const fn of this.cleanups)fn();this.root.remove();}
}

class OverlayManager {
  constructor(plugin){this.plugin=plugin;this.item=null;}
  sync(){
    // Attach to the app document, never to a leaf: splits and tab changes share one overlay.
    const doc=this.plugin.app.workspace.containerEl.ownerDocument;
    if(this.item&&(!this.item.root.isConnected||this.item.doc!==doc)){this.item.destroy();this.item=null;}
    if(!this.item&&doc.body)this.item=new WindowOverlay(this.plugin,doc);
    this.render();
  }
  render(){
    this.item?.render();
    this.plugin.overlayRibbon?.setAttribute('aria-pressed',String(!!this.plugin.overlaySettings.shown));
    this.plugin.overlayRibbon?.classList.toggle('is-active',!!this.plugin.overlaySettings.shown);
  }
  destroy(){this.item?.destroy();this.item=null;}
}
module.exports={OverlayManager,fitBox,dragBox,resizeBox};
