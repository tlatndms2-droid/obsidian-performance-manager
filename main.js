/* Performance Manager 0.2.4 */
(function(nativeRequire){
const factories={"./profile.cjs": function(module,exports,require){
const SYSTEM = new Set(['(idle)', '(program)', '(root)', '(garbage collector)']);

function pluginId(url, ids) {
  if (typeof url !== 'string' || !url.startsWith('plugin:')) return null;
  const value = url.slice(7);
  // Obsidian sourceURL is plugin:<manifest id>, sometimes followed by a query.
  return ids.find(id => value === id || value.startsWith(id+'?') || value.startsWith(id+'/')) || null;
}

function emptyTotals() { return { durationMs: 0, pluginMs: 0, coreMs: 0, idleMs: 0, unknownMs: 0, samples: 0, segments: 0, plugins: {} }; }

function summarize(profile, catalog, scriptMap = {}) {
  const out = emptyTotals();
  const nodes = new Map(profile.nodes.map(n => [n.id,n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const child of n.children || []) parent.set(child,n.id);
  const ids = catalog.map(p=>p.id).sort((a,b)=>b.length-a.length);
  const resolved = new Map();
  function owner(id) {
    if (resolved.has(id)) return resolved.get(id);
    let n = nodes.get(id), seen = new Set();
    while(n && !seen.has(n.id)) {
      seen.add(n.id);
      const frame=n.callFrame;
      if (SYSTEM.has(frame.functionName)) break;
      const url=frame.url || scriptMap[String(frame.scriptId)] || '';
      const found=pluginId(url,ids);
      if(found) { const answer={id:found,frame,url};resolved.set(id,answer);return answer; }
      n=nodes.get(parent.get(n.id));
    }
    resolved.set(id,null);return null;
  }
  out.durationMs=Math.max(0,(profile.endTime-profile.startTime)/1000);
  let remaining=out.durationMs;
  for(let i=0;i<(profile.samples||[]).length;i++) {
    const delta=profile.timeDeltas?.[i];
    if(!Number.isFinite(delta)||delta<0) continue;
    const ms=Math.min(delta/1000,remaining);remaining-=ms;out.samples++;
    const node=nodes.get(profile.samples[i]);
    if(!node){out.unknownMs+=ms;continue;}
    const frame=node.callFrame;
    if(frame.functionName==='(idle)'){out.idleMs+=ms;continue;}
    const found=owner(node.id);
    if(found) {
      const p=out.plugins[found.id] ||= {ms:0,samples:0,functions:{}};
      p.ms+=ms;p.samples++;out.pluginMs+=ms;
      const f=found.frame;
      const key=JSON.stringify([f.functionName||'(이름 없는 함수)',found.url,f.lineNumber,f.columnNumber]);
      const fun=p.functions[key] ||= {name:f.functionName||'(이름 없는 함수)',url:found.url,line:(f.lineNumber??-1)+1,column:(f.columnNumber??-1)+1,ms:0,samples:0};
      fun.ms+=ms;fun.samples++;
    } else if(SYSTEM.has(frame.functionName) || (frame.url && !frame.url.startsWith('plugin:'))) {
      out.coreMs+=ms;
    } else {out.unknownMs+=ms;}
  }
  // Unsampled time remains explicitly unassigned, never billed to a plugin.
  out.unknownMs+=remaining;out.segments=1;
  return out;
}

function merge(total, piece) {
  for(const key of ['durationMs','pluginMs','coreMs','idleMs','unknownMs','samples','segments']) total[key]+=piece[key];
  for(const [id,group] of Object.entries(piece.plugins)) {
    const p=total.plugins[id] ||= {ms:0,samples:0,functions:{}};
    p.ms+=group.ms;p.samples+=group.samples;
    for(const [key,fn] of Object.entries(group.functions)) {
      const f=p.functions[key] ||= {...fn,ms:0,samples:0};f.ms+=fn.ms;f.samples+=fn.samples;
    }
    // Bound retained summaries even during long sessions.
    const entries=Object.entries(p.functions).sort((a,b)=>b[1].ms-a[1].ms);
    if(entries.length>200) {
      const dropped=entries.slice(199);const other={name:'그 밖의 함수',url:'',line:0,column:0,ms:0,samples:0};
      for(const [,fn] of dropped){other.ms+=fn.ms;other.samples+=fn.samples;}
      p.functions=Object.fromEntries(entries.slice(0,199));
      const prior=p.functions.__other;if(prior){other.ms+=prior.ms;other.samples+=prior.samples;}
      p.functions.__other=other;
    }
  }
  return total;
}
module.exports={pluginId,emptyTotals,summarize,merge};

},
"./recorder.cjs": function(module,exports,require){
const {emptyTotals,summarize,merge}=require('./profile.cjs');
const INTERVAL_US=2000;
const CHUNK_MS=10000;
const MAX_MS=10*60*1000;

class Recorder {
  constructor({getDebugger,catalog,onUpdate,onFinish,now=()=>Date.now(),chunkMs=CHUNK_MS,maxMs=MAX_MS}) {
    Object.assign(this,{getDebugger,catalog,onUpdate,onFinish,now,chunkMs,maxMs});
    this.state='idle';this.owned=false;this.queue=Promise.resolve();this.disposed=false;
  }
  enqueue(fn){const operation=this.queue.then(fn);this.queue=operation.catch(()=>{});return operation;}
  start(){return this.enqueue(()=>this.begin());}
  stop(reason='manual'){return this.enqueue(()=>this.finish(reason));}
  async begin(){
    if(this.disposed)throw new Error('측정기가 종료되었습니다.');
    if(this.state!=='idle')return;
    this.debug=this.getDebugger();
    if(this.debug.isAttached())throw new Error('개발자 도구 또는 다른 측정기가 사용 중입니다. 해당 측정을 종료하고 다시 시도하세요.');
    this.catalogAtStart=this.catalog();this.scriptMap={};this.total=emptyTotals();this.finished=false;this.startedAt=this.now();this.state='starting';this.onUpdate(this);
    this.onMessage=(_event,method,params)=>{
      if(method==='Debugger.scriptParsed'&&typeof params.url==='string'&&params.url.startsWith('plugin:'))this.scriptMap[params.scriptId]=params.url;
    };
    this.onDetach=(_event,reason)=>{
      if(!this.owned)return;
      this.owned=false;this.clearTimers();this.removeListeners();this.state='idle';
      this.error='측정 연결이 중단되었습니다: '+reason;this.reason='interrupted';
      this.onUpdate(this);this.notifyFinish();
    };
    try {
      this.debug.attach('1.3');this.owned=true;
      this.debug.on('message',this.onMessage);this.debug.on('detach',this.onDetach);
      await this.debug.sendCommand('Debugger.enable');
      // Source IDs are required for eval-loaded plugins whose profile URL is blank.
      await this.debug.sendCommand('Debugger.setSkipAllPauses',{skip:true});
      await this.debug.sendCommand('Profiler.enable');
      await this.debug.sendCommand('Profiler.setSamplingInterval',{interval:INTERVAL_US});
      if(this.disposed||!this.owned)throw new Error('측정 시작이 취소되었습니다.');
      await this.debug.sendCommand('Profiler.start');
      if(this.disposed||!this.owned)throw new Error('측정 시작이 취소되었습니다.');
      this.state='recording';this.error=null;this.reason=null;
      this.tick=setInterval(()=>this.enqueue(()=>this.rotate()).catch(e=>this.fail(e)),this.chunkMs);
      this.limit=setTimeout(()=>this.stop('limit').catch(e=>this.fail(e)),this.maxMs);
      this.onUpdate(this);
    }catch(e){this.release();this.state='idle';this.error=String(e.message||e);this.onUpdate(this);throw e;}
  }
  async rotate(){
    if(this.state!=='recording'||!this.owned)return;
    try {
      const {profile}=await this.debug.sendCommand('Profiler.stop');
      // Electron remote can expose nested arrays through costly bridge accessors.
      // Materialize once; never repeatedly traverse bridge-backed sample arrays.
      const localProfile=JSON.parse(JSON.stringify(profile));
      const summary=summarize(localProfile,this.catalogAtStart,this.scriptMap);
      merge(this.total,summary);
      if(!this.owned||this.disposed)return;
      await this.debug.sendCommand('Profiler.start');
      this.onUpdate(this);
    }catch(e){this.fail(e);}
  }
  async finish(reason){
    if(this.state!=='recording'||!this.owned)return;
    this.state='stopping';this.clearTimers();this.onUpdate(this);
    try {
      const {profile}=await this.debug.sendCommand('Profiler.stop');
      merge(this.total,summarize(JSON.parse(JSON.stringify(profile)),this.catalogAtStart,this.scriptMap));
      await this.debug.sendCommand('Profiler.disable');
    }catch(e){this.error='일부 구간을 저장하지 못했습니다: '+String(e.message||e);}
    finally {
      const interrupted=!this.owned;
      this.release();this.state='idle';if(!interrupted)this.reason=reason;this.onUpdate(this);await this.notifyFinish();
    }
  }
  fail(e){if(this.disposed)return;this.error='측정 오류: '+String(e.message||e);this.reason='error';this.release();this.state='idle';this.onUpdate(this);this.notifyFinish();}
  notifyFinish(){if(this.finished||this.disposed)return Promise.resolve();this.finished=true;return Promise.resolve(this.onFinish?.(this.snapshot())).catch(()=>{});}
  snapshot(){return {schema:1,at:new Date(this.startedAt||this.now()).toISOString(),wallMs:Math.max(0,this.now()-(this.startedAt||this.now())),intervalUs:INTERVAL_US,reason:this.reason,error:this.error,catalog:this.catalogAtStart||[],total:this.total||emptyTotals()};}
  clearTimers(){clearInterval(this.tick);clearTimeout(this.limit);}
  removeListeners(){if(this.debug&&this.onMessage)this.debug.removeListener('message',this.onMessage);if(this.debug&&this.onDetach)this.debug.removeListener('detach',this.onDetach);}
  release(){this.clearTimers();this.removeListeners();if(this.owned){this.owned=false;try{this.debug.detach();}catch{}}}
  dispose(){this.disposed=true;this.release();this.state='idle';}
}
module.exports={Recorder,INTERVAL_US,CHUNK_MS,MAX_MS};

},
"./overlay.cjs": function(module,exports,require){
const {setIcon}=require('obsidian');
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

class CanvasOverlay {
  constructor(plugin,view,wrapper,controls){
    Object.assign(this,{plugin,view,wrapper});this.cleanups=[];
    this.group=controls.createDiv({cls:'canvas-control-group mod-raised pm-overlay-control'});
    this.toggle=this.group.createEl('button',{cls:'canvas-control-item pm-overlay-toggle',attr:{'aria-label':'성능 오버레이 열기 / 숨기기','aria-pressed':'false'}});
    setIcon(this.toggle,'gauge');this.toggle.onclick=()=>{plugin.overlaySettings.shown=!plugin.overlaySettings.shown;plugin.refreshOverlays();plugin.persist();};
    this.root=wrapper.createDiv({cls:'pm-canvas-overlay',attr:{'aria-label':'성능 오버레이'}});
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
    this.observer=new ResizeObserver(()=>{if(!this.gesture)this.layout();});this.observer.observe(wrapper);
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
    const shown=!!this.plugin.overlaySettings.shown;this.root.hidden=!shown;this.toggle.setAttribute('aria-pressed',String(shown));
    this.toggle.classList.toggle('is-active',shown);this.layout();if(!shown)return;
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
  destroy(){this.observer.disconnect();for(const fn of this.cleanups)fn();this.group.remove();this.root.remove();}
}

class OverlayManager {
  constructor(plugin){this.plugin=plugin;this.items=new Map();this.pending=new Map();}
  sync(){
    const views=new Set(this.plugin.app.workspace.getLeavesOfType('canvas').map(l=>l.view));
    for(const [view,item] of this.items)if(!views.has(view)||!item.wrapper.isConnected||!item.group.isConnected){item.destroy();this.items.delete(view);}
    for(const [view,observer] of this.pending)if(!views.has(view)){observer.disconnect();this.pending.delete(view);}
    for(const view of views){
      if(this.items.has(view))continue;
      const attach=()=>{const wrapper=view.containerEl.querySelector('.canvas-wrapper'),controls=wrapper?.querySelector('.canvas-controls');if(!controls)return false;this.pending.get(view)?.disconnect();this.pending.delete(view);this.items.set(view,new CanvasOverlay(this.plugin,view,wrapper,controls));return true;};
      if(!attach()&&!this.pending.has(view)){const observer=new MutationObserver(()=>attach());observer.observe(view.containerEl,{childList:true,subtree:true});this.pending.set(view,observer);}
    }
  }
  render(){for(const item of this.items.values())item.render();}
  destroy(){for(const item of this.items.values())item.destroy();for(const observer of this.pending.values())observer.disconnect();this.items.clear();this.pending.clear();}
}
module.exports={OverlayManager,fitBox,dragBox,resizeBox};

},
"./groups.cjs": function(module,exports,require){
class GroupStore {
  constructor(plugin,data={}){
    this.plugin=plugin;this.busy=false;this.error='';this.collapsed=data.collapsed||{};
    const assigned=new Set(),ids=new Set();
    this.groups=(Array.isArray(data.groups)?data.groups:[]).filter(g=>g&&typeof g.id==='string'&&typeof g.name==='string'&&!ids.has(g.id)&&ids.add(g.id)).map(g=>{const pluginIds=(Array.isArray(g.pluginIds)?g.pluginIds:[]).filter(id=>typeof id==='string'&&!assigned.has(id)&&assigned.add(id));return {id:g.id,name:g.name,pluginIds,rememberedEnabled:Object.fromEntries(pluginIds.filter(id=>typeof g.rememberedEnabled?.[id]==='boolean').map(id=>[id,g.rememberedEnabled[id]]))};});
  }
  snapshot(){return JSON.parse(JSON.stringify({groups:this.groups,collapsed:this.collapsed}));}
  async save(){await this.plugin.persist();if(this.plugin.saveError)throw new Error(this.plugin.saveError);}
  changed(){this.plugin.groupChanged?.();}
  memory(){return Object.fromEntries(this.groups.map(g=>[g.id,{...g.rememberedEnabled}]));}
  restoreMemory(memory){for(const g of this.groups)if(memory?.[g.id])g.rememberedEnabled={...memory[g.id]};}
  fillMemory(){let changed=false;for(const g of this.groups)for(const id of g.pluginIds)if(!Object.hasOwn(g.rememberedEnabled,id)&&this.plugin.app.plugins.manifests[id]){g.rememberedEnabled[id]=this.plugin.app.plugins.enabledPlugins.has(id);changed=true;}return changed;}
  async initializeMemory(){if(this.busy||this.plugin.groupTransaction?.before)return;const previous=this.memory();if(!this.fillMemory())return;this.busy=true;try{await this.save();}catch(e){this.restoreMemory(previous);throw e;}finally{this.busy=false;this.changed();}}
  isVisible(view,id){const manager=this.plugin.app.plugins;if(!manager.manifests[id])return false;const group=this.groupFor(id),active=!!manager.plugins[id];if(view==='none')return !group&&active;if(view==='disabled')return !group&&!active;return group?.id===view;}
  async edit(fn){
    if(this.busy)throw new Error('플러그인 전환이 끝난 후 수정하세요.');
    if(this.plugin.groupTransaction?.before)throw new Error('이전 전환 복구를 먼저 완료해야 합니다.');
    const previous=JSON.parse(JSON.stringify(this.groups));this.busy=true;
    try{fn();await this.save();}catch(e){this.groups=previous;throw e;}finally{this.busy=false;this.changed();}
  }
  async create(name){
    name=name.trim();if(!name)throw new Error('그룹 이름을 입력하세요.');
    if(this.groups.some(g=>g.name===name))throw new Error('같은 이름의 그룹이 있습니다.');
    const id=globalThis.crypto?.randomUUID?.()||'group-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    await this.edit(()=>this.groups.push({id,name,pluginIds:[],rememberedEnabled:{}}));return id;
  }
  async rename(id,name){name=name.trim();if(!name)throw new Error('그룹 이름을 입력하세요.');if(this.groups.some(g=>g.id!==id&&g.name===name))throw new Error('같은 이름의 그룹이 있습니다.');await this.edit(()=>{const g=this.find(id);g.name=name;});}
  find(id){const g=this.groups.find(g=>g.id===id);if(!g)throw new Error('그룹을 찾을 수 없습니다.');return g;}
  async remove(id){await this.edit(()=>{this.groups=this.groups.filter(g=>g.id!==id);});}
  async assign(ids,target){
    const selected=new Set(ids.filter(id=>this.plugin.app.plugins.manifests[id]));
    if(target)this.find(target);
    await this.edit(()=>{const same=target?{...this.find(target).rememberedEnabled}:{};for(const g of this.groups){g.pluginIds=g.pluginIds.filter(id=>!selected.has(id));for(const id of selected)delete g.rememberedEnabled[id];}if(target){const g=this.find(target);for(const id of selected){g.pluginIds.push(id);g.rememberedEnabled[id]=Object.hasOwn(same,id)?same[id]:this.plugin.app.plugins.enabledPlugins.has(id);}}});
  }
  groupFor(id){return this.groups.find(g=>g.pluginIds.includes(id));}
  async rememberExternal(id,enabled){if(this.busy)return;const group=this.groupFor(id);if(!group||group.rememberedEnabled[id]===enabled)return;await this.edit(()=>{this.find(group.id).rememberedEnabled[id]=enabled;});}
  async forgetMemory(id){if(this.busy||!this.groupFor(id))return;await this.edit(()=>{delete this.groupFor(id).rememberedEnabled[id];});}
  async apply(ids,enabled){return this.applyStates(Object.fromEntries(ids.map(id=>[id,enabled])));}
  async applyGroup(id,enabled){
    const group=this.find(id),manager=this.plugin.app.plugins;
    const ids=group.pluginIds.filter(id=>manager.manifests[id]&&id!==this.plugin.manifest.id);
    const states=Object.fromEntries(ids.map(id=>[id,enabled?(Object.hasOwn(group.rememberedEnabled,id)?group.rememberedEnabled[id]:manager.enabledPlugins.has(id)):false]));
    if(enabled&&!Object.values(states).some(Boolean))throw new Error('기억한 조합에 켜질 플러그인이 없습니다. 원하는 항목을 개별적으로 켜세요.');
    return this.applyStates(states,{source:'group'});
  }
  async applyStates(states,{source='individual'}={}){
    if(this.busy)throw new Error('다른 전환을 진행 중입니다.');
    if(this.plugin.groupTransaction?.before)throw new Error('이전 전환의 복구를 먼저 완료해야 합니다. 앱을 다시 열어 복구를 시도하세요.');
    const manager=this.plugin.app.plugins;
    const targets=Object.keys(states).filter(id=>id!==this.plugin.manifest.id&&manager.manifests[id]&&typeof states[id]==='boolean');
    if(!targets.length)return;
    const before=Object.fromEntries(targets.map(id=>[id,{enabled:manager.enabledPlugins.has(id),loaded:!!manager.plugins[id]}]));
    const rememberedBefore=this.memory(),journal={before,rememberedBefore,at:new Date().toISOString()};
    const changed=[];this.busy=true;this.error='';this.changed();
    try{
      this.fillMemory();this.plugin.groupTransaction=journal;await this.save();
      for(const id of targets){
        const enabled=states[id];
        if(before[id].enabled===enabled&&before[id].loaded===enabled)continue;
        changed.push(id);await this.setState(id,enabled);
      }
      await this.flushState();
      if(source==='individual')for(const id of targets){const group=this.groupFor(id);if(group)group.rememberedEnabled[id]=states[id];}
      this.plugin.groupTransaction=null;await this.save();
    }catch(e){
      this.plugin.groupTransaction=journal;
      const failures=[];
      for(const id of changed.reverse())try{await this.setState(id,before[id].enabled);}catch{failures.push(id);}
      if(changed.length)try{await this.flushState();}catch{failures.push('활성 상태 저장');}
      this.restoreMemory(rememberedBefore);
      if(!failures.length)this.plugin.groupTransaction=null;
      try{await this.save();}catch{this.plugin.groupTransaction=journal;failures.push('상태 저장');}
      this.error=String(e.message||e)+(failures.length?' · 복구 미완료: '+failures.join(', '):' · 변경한 항목을 이전 상태로 복구했습니다.');
      throw new Error(this.error);
    }finally{this.busy=false;this.changed();}
  }
  async setState(id,enabled){
    const m=this.plugin.app.plugins;
    if(enabled)await m.enablePluginAndSave(id);else await m.disablePluginAndSave(id);
    if(m.enabledPlugins.has(id)!==enabled||!!m.plugins[id]!==enabled)throw new Error((m.manifests[id]?.name||id)+' 전환 실패');
  }
  async flushState(){
    const {app}=this.plugin,m=app.plugins;
    // AndSave only schedules Obsidian's debounced config write. Finish it before retiring the journal.
    if(typeof m.saveConfig!=='function')return;
    await m.saveConfig();
    const saved=JSON.parse(await app.vault.adapter.read(app.vault.configDir+'/community-plugins.json'));
    if(!Array.isArray(saved)||saved.length!==m.enabledPlugins.size||saved.some(id=>!m.enabledPlugins.has(id)))throw new Error('플러그인 활성 상태를 저장하지 못했습니다.');
  }
  async recover(){
    const pending=this.plugin.groupTransaction;if(!pending?.before)return;
    this.busy=true;const failed=[];
    try{for(const [id,state] of Object.entries(pending.before)){if(id===this.plugin.manifest.id||!this.plugin.app.plugins.manifests[id])continue;try{await this.setState(id,!!state.enabled);}catch{failed.push(id);}}
      if(!failed.length){await this.flushState();this.restoreMemory(pending.rememberedBefore);this.plugin.groupTransaction=null;try{await this.save();this.error='';}catch(e){this.plugin.groupTransaction=pending;throw e;}}else this.error='이전 전환 복구 미완료: '+failed.join(', ');
    }finally{this.busy=false;this.changed();}
  }
}
module.exports={GroupStore};

},
"./group-window.cjs": function(module,exports,require){
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

},
"./group-ui.cjs": function(module,exports,require){
const {Modal,Setting,Menu,Notice,PluginSettingTab}=require('obsidian');
const {selectRange,installWindow}=require('./group-window.cjs');
const run=async fn=>{try{await fn();}catch(e){new Notice(String(e.message||e));}};
function action(parent,text,fn,cls=''){const b=parent.createEl('button',{text,cls});b.onclick=()=>run(fn);return b;}

class GroupNameModal extends Modal{
  constructor(plugin,group=null){super(plugin.app);this.plugin=plugin;this.group=group;}
  onOpen(){this.titleEl.setText(this.group?'그룹 이름 변경':'그룹 만들기');const setting=new Setting(this.contentEl).setName('그룹 이름');let name=this.group?.name||'';setting.addText(t=>{t.setValue(name).onChange(v=>name=v);this.input=t.inputEl;});const footer=this.contentEl.createDiv({cls:'pm-group-actions'});action(footer,'취소',()=>this.close());action(footer,'저장',async()=>{const store=this.plugin.groupStore;if(this.group)await store.rename(this.group.id,name);else{const id=await store.create(name);for(const modal of this.plugin.groupModals)modal.selectedGroup=id;}this.close();this.plugin.groupChanged();},'mod-cta');this.input.focus();this.input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();footer.lastElementChild.click();}});}
}
class DeleteGroupModal extends Modal{
  constructor(plugin,group){super(plugin.app);this.plugin=plugin;this.group=group;}
  onOpen(){this.titleEl.setText('그룹 삭제');this.contentEl.createEl('p',{text:'“'+this.group.name+'” 그룹을 삭제합니다. 플러그인은 삭제하거나 끄지 않습니다. 소속을 해제하고 현재 상태에 따라 ‘켜진 플러그인’ 또는 ‘꺼진 플러그인’에 표시합니다.'});const footer=this.contentEl.createDiv({cls:'pm-group-actions'});action(footer,'취소',()=>this.close());action(footer,'그룹 삭제',async()=>{await this.plugin.groupStore.remove(this.group.id);for(const modal of this.plugin.groupModals)if(modal.selectedGroup===this.group.id)modal.selectedGroup='none';this.plugin.groupChanged();this.close();},'mod-warning');}
}
class GroupPickerModal extends Modal{
  constructor(owner){super(owner.app);this.owner=owner;this.ids=[...owner.checked];}
  onOpen(){this.titleEl.setText('그룹에 추가');this.modalEl.addClass('pm-group-picker');const search=this.contentEl.createEl('input',{type:'search',placeholder:'그룹 검색…',attr:{'aria-label':'추가할 그룹 검색'}}),list=this.contentEl.createDiv({cls:'pm-group-picker-list'});search.style.width='100%';const render=()=>{list.empty();const groups=this.owner.plugin.groupStore.groups.filter(g=>g.name.toLowerCase().includes(search.value.toLowerCase()));for(const g of groups)action(list,g.name,async()=>{await this.owner.plugin.groupStore.assign(this.ids,g.id);this.owner.checked.clear();this.owner.anchor=null;this.owner.render();this.close();},'pm-picker-option');if(!groups.length)list.createDiv({text:'일치하는 그룹이 없습니다.',cls:'pm-group-empty'});};search.oninput=render;search.onkeydown=e=>{if(e.key==='Enter')list.querySelector('button')?.click();};render();search.focus();}
}
class GroupsModal extends Modal{
  constructor(plugin){super(plugin.app);this.plugin=plugin;this.selectedGroup='none';this.checked=new Set();this.query='';this.groupQuery='';this.editing=false;this.anchor=null;this.sideWidth=plugin.groupWindow?.side||220;}
  onOpen(){this.modalEl.addClass('pm-groups-modal');this.titleEl.setText('플러그인 관리');this.plugin.groupModals.add(this);this.render();this.disposeWindow=installWindow(this);}
  onClose(){this.clearDrag();this.disposeWindow?.();this.plugin.groupModals.delete(this);}
  clearDrag(){this.dragSession=null;this.dragBadge?.remove();this.dragBadge=null;this.modalEl.querySelectorAll('.pm-drop-target,.pm-plugin-dragging').forEach(el=>el.classList.remove('pm-drop-target','pm-plugin-dragging'));}
  prepareDrop(block,target){
    block.dataset.pmGroupTarget=target||'none';
    const accepts=e=>this.editing&&!this.plugin.groupStore.busy&&this.dragSession&&Array.from(e.dataTransfer?.types||[]).includes('application/x-pm-plugin-selection');
    block.ondragover=e=>{if(!accepts(e))return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';block.addClass('pm-drop-target');};
    block.ondragleave=e=>{if(!block.contains(e.relatedTarget))block.removeClass('pm-drop-target');};
    block.ondrop=e=>{
      if(!accepts(e)||e.dataTransfer.getData('application/x-pm-plugin-selection')!==this.dragSession.token)return;
      e.preventDefault();e.stopPropagation();const ids=[...this.dragSession.ids];this.clearDrag();
      run(async()=>{await this.plugin.groupStore.assign(ids,target);this.checked.clear();this.anchor=null;this.render();});
    };
  }
  prepareDrag(row,id){
    row.draggable=true;
    let blocked=false;row.onpointerdown=e=>{blocked=!!e.target.closest('input,button,a,.checkbox-container,.extra-setting-button');};
    row.ondragstart=e=>{
      if(blocked||!this.editing||this.plugin.groupStore.busy){e.preventDefault();return;}
      this.clearDrag();const ids=this.checked.has(id)?[...this.checked]:[id];
      this.dragSession={ids,token:globalThis.crypto.randomUUID()};
      e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('application/x-pm-plugin-selection',this.dragSession.token);
      this.dragBadge=this.modalEl.createDiv({cls:'pm-plugin-drag-badge',text:ids.length+'개 플러그인 이동'});e.dataTransfer.setDragImage(this.dragBadge,12,12);
      for(const el of this.modalEl.querySelectorAll('.pm-group-plugin-row'))if(ids.includes(el.dataset.pmPluginId))el.addClass('pm-plugin-dragging');
    };
    row.ondragend=()=>this.clearDrag();
  }
  render(){
    const oldScroll=this.contentEl.querySelector('.pm-group-list')?.scrollTop||0;
    const store=this.plugin.groupStore;if(!['none','disabled'].includes(this.selectedGroup)&&!store.groups.some(g=>g.id===this.selectedGroup))this.selectedGroup='none';
    const root=this.contentEl;root.empty();root.addClass('pm-groups-content');const side=root.createDiv({cls:'pm-group-sidebar'});side.style.flexBasis=this.sideWidth+'px';const divider=root.createDiv({cls:'pm-group-divider',attr:{role:'separator','aria-label':'그룹 목록 너비 조절','aria-orientation':'vertical',tabindex:'0'}}),main=root.createDiv({cls:'pm-group-main'});
    divider.onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();this.sideWidth=Math.max(130,Math.min(this.sideWidth+(e.key==='ArrowRight'?10:-10),this.modalEl.clientWidth-300));side.style.flexBasis=this.sideWidth+'px';this.plugin.groupWindow={...(this.plugin.groupWindow||{}),side:this.sideWidth};this.plugin.persist();};
    const manifests=Object.values(this.app.plugins.manifests).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
    const disabledView=this.selectedGroup==='disabled';
    const matchesState=id=>disabledView?store.isVisible('disabled',id):!!store.groupFor(id)||store.isVisible('none',id);
    for(const id of this.checked)if(!this.app.plugins.manifests[id]||!matchesState(id))this.checked.delete(id);
    if(this.anchor&&!matchesState(this.anchor))this.anchor=null;
    side.createEl('h3',{text:'그룹'});
    const groupSearch=side.createEl('input',{type:'search',placeholder:'그룹 검색…',cls:'pm-group-filter',attr:{'aria-label':'그룹 검색'}});groupSearch.value=this.groupQuery;groupSearch.oninput=()=>{this.groupQuery=groupSearch.value;this.render();this.contentEl.querySelector('.pm-group-filter').focus();};
    const choose=(id,name,count,group)=>{
      const block=side.createDiv({cls:'pm-group-nav-item'+(this.selectedGroup===id?' is-selected':'')});
      if(this.editing&&id!=='disabled')this.prepareDrop(block,id==='none'?null:id);
      const b=action(block,group?name:name+' ('+count+')',()=>{this.selectedGroup=id;this.anchor=null;this.render();},'pm-group-select');b.setAttribute('aria-pressed',String(this.selectedGroup===id));
      if(group){const active=group.pluginIds.filter(id=>this.app.plugins.manifests[id]&&this.app.plugins.plugins[id]).length;const counts=b.createSpan({cls:'pm-group-counts',text:'전체 '+count+'개 / '});counts.createSpan({cls:active?'pm-group-active-count':'',text:'켜짐 '+active+'개'});}
      if(group){const controls=block.createDiv({cls:'pm-group-nav-actions'});groupToggle(controls,this.plugin,group);if(id==='none')return;const more=action(controls,'⋮',()=>{const menu=new Menu();menu.addItem(i=>i.setTitle('이름 변경').setIcon('pencil').onClick(()=>new GroupNameModal(this.plugin,group).open()));menu.addItem(i=>i.setTitle('그룹 삭제').setIcon('trash').onClick(()=>new DeleteGroupModal(this.plugin,group).open()));menu.showAtMouseEvent(this.menuEvent||{clientX:more.getBoundingClientRect().left,clientY:more.getBoundingClientRect().bottom});});more.setAttribute('aria-label',group.name+' 그룹 옵션');}
    };
    choose('none','켜진 플러그인',manifests.filter(m=>store.isVisible('none',m.id)).length);
    choose('disabled','꺼진 플러그인',manifests.filter(m=>store.isVisible('disabled',m.id)).length);
    for(const group of store.groups)if(group.name.toLowerCase().includes(this.groupQuery.toLowerCase()))choose(group.id,group.name,group.pluginIds.filter(id=>this.app.plugins.manifests[id]).length,group);

    action(side,'+ 그룹 만들기',()=>new GroupNameModal(this.plugin).open(),'pm-group-create').disabled=store.busy;
    const search=main.createEl('input',{type:'search',placeholder:'플러그인 검색…',cls:'pm-group-search',attr:{'aria-label':'플러그인 검색'}});search.value=this.query;
    search.oninput=()=>{const position=search.selectionStart;this.query=search.value;this.render();const next=this.contentEl.querySelector('.pm-group-search');next.focus();try{next.setSelectionRange(position,position);}catch{}};
    const toolbar=main.createDiv({cls:'pm-group-toolbar'});
    action(toolbar,this.editing?'완료':'수정',()=>{this.editing=!this.editing;this.checked.clear();this.anchor=null;this.render();},'pm-group-edit').disabled=store.busy;
    if(this.editing){toolbar.createSpan({text:this.checked.size+'개 선택됨',cls:'pm-selection-count'});
      action(toolbar,'그룹에 추가',()=>new GroupPickerModal(this).open(),'mod-cta').disabled=!this.checked.size||store.busy||!store.groups.length;
      if(!['none','disabled'].includes(this.selectedGroup))action(toolbar,'그룹에서 빼기',async()=>{await store.assign([...this.checked].filter(id=>store.groupFor(id)?.id===this.selectedGroup),null);this.checked.clear();this.anchor=null;this.render();}).disabled=!this.checked.size||store.busy;
    }
    if(store.error||this.plugin.saveError)main.createDiv({cls:'pm-group-error',text:store.error||this.plugin.saveError,attr:{role:'alert'}});
    if(store.busy)main.createDiv({text:'플러그인 상태를 변경하고 있습니다…',attr:{role:'status'}});
    const list=main.createDiv({cls:'pm-group-list'});
    const shown=manifests.filter(m=>store.isVisible(this.selectedGroup,m.id)&&[m.name,m.description,m.author].some(v=>String(v||'').toLowerCase().includes(this.query.toLowerCase())));
    for(const m of shown){
      const row=list.createDiv({cls:'pm-group-plugin-row',attr:{'data-pm-plugin-id':m.id}});
      if(this.editing)this.prepareDrag(row,m.id);
      if(this.editing){const check=row.createEl('input',{type:'checkbox',attr:{'aria-label':m.name+' 선택'}});check.checked=this.checked.has(m.id);check.disabled=store.busy;check.onclick=e=>{const selection=selectRange(this.checked,shown.map(x=>x.id),this.anchor,m.id,e.shiftKey,check.checked);this.checked=selection.checked;this.anchor=selection.anchor;this.render();this.contentEl.querySelector('[data-pm-plugin-id="'+m.id+'"]>input')?.focus({preventScroll:true});};}
      const s=new Setting(row).setName(m.name).setDesc(m.description||'');
      s.nameEl.createSpan({cls:'pm-group-metadata',text:' v'+m.version+(m.author?' · 개발자: '+m.author:'')});
      const group=store.groupFor(m.id);s.descEl.createDiv({cls:'pm-group-membership',text:'그룹: '+(group?.name||'없음')});
      s.addExtraButton(b=>b.setIcon('more-vertical').setTooltip(m.name+' 옵션').onClick(()=>this.plugin.openPluginMenu(m,b.extraSettingsEl,this)));
      s.addToggle(t=>{t.setValue(!!this.app.plugins.plugins[m.id]).setDisabled(store.busy||m.id===this.plugin.manifest.id).onChange(enabled=>run(()=>store.apply(this.editing&&this.checked.has(m.id)?[...this.checked]:[m.id],enabled)));if(m.id===this.plugin.manifest.id)t.toggleEl.setAttribute('aria-label','Performance Manager는 항상 켜짐');else t.toggleEl.title=this.editing&&this.checked.has(m.id)?'선택한 '+this.checked.size+'개 플러그인 함께 켜기·끄기':m.name+' 켜기·끄기';});
    }
    if(!shown.length)list.createDiv({cls:'pm-group-empty',text:!this.query&&disabledView?'꺼진 플러그인이 없습니다.':!this.query&&this.selectedGroup==='none'?'그룹에 속하지 않은 켜진 플러그인이 없습니다.':'표시할 플러그인이 없습니다.'});list.scrollTop=oldScroll;
    main.createDiv({cls:'pm-group-note',text:this.editing?'선택한 항목 하나의 스위치로 선택 전체 켜기·끄기 · Shift로 구간 선택 · 왼쪽 그룹으로 드래그하면 소속만 이동':'수정을 누르면 플러그인을 선택하여 그룹 편집과 일괄 켜기·끄기를 할 수 있습니다.'});
  }
}
class ManagerSettingTab extends PluginSettingTab{
  display(){this.containerEl.empty();new Setting(this.containerEl).setName('플러그인 관리').setDesc('플러그인을 관리하고, 그룹으로 묶어 일괄 켜거나 끕니다.').addButton(b=>b.setButtonText('플러그인 관리 열기').setCta().onClick(()=>this.plugin.openGroups()));}
}
function groupToggle(parent,plugin,group){
  const ids=group.pluginIds.filter(id=>plugin.app.plugins.manifests[id]&&id!==plugin.manifest.id),active=ids.filter(id=>!!plugin.app.plugins.plugins[id]).length,on=active>0,mixed=on&&active<ids.length;
  const setting=new Setting(parent).addToggle(t=>{
    t.setValue(on).setDisabled(plugin.groupStore.busy||!ids.length);
    t.toggleEl.setAttribute('aria-label',group.name+' 그룹 켜기·끄기');
    t.toggleEl.title=on?(mixed?'일부 켜짐 ('+active+'/'+ids.length+')':'켜짐')+' · 누르면 그룹 전체 끄기':!ids.length?'전환할 플러그인이 없습니다.':'꺼짐 · 누르면 기억한 조합으로 복원';
    if(mixed)t.toggleEl.addClass('pm-toggle-mixed');
    t.onChange(enabled=>run(async()=>{try{await plugin.groupStore.applyGroup(group.id,enabled);}finally{plugin.groupChanged();}}));
  });setting.settingEl.addClass('pm-group-toggle-setting');
}
module.exports={GroupsModal,GroupNameModal,ManagerSettingTab,run,groupToggle};

},
"./native-groups.cjs": function(module,exports,require){
const {groupToggle,run}=require('./group-ui.cjs');
class NativeGroups {
  constructor(plugin){this.plugin=plugin;this.hooks=[];this.frame=null;this.host=null;this.rows=[];}
  hook(owner,key,after){
    const original=owner[key];if(typeof original!=='function')return;
    const own=Object.hasOwn(owner,key);const wrapped=function(...args){const value=original.apply(this,args);if(value?.then)return value.then(result=>{after(...args);return result;},e=>{throw e;});after(...args);return value;};
    owner[key]=wrapped;this.hooks.push(()=>{if(owner[key]===wrapped){if(own)owner[key]=original;else delete owner[key];}});
  }
  install(){
    this.tab=this.plugin.app.setting?.findTabById?.('community-plugins');if(!this.tab)return;
    const schedule=()=>this.schedule();this.hook(this.tab,'display',schedule);this.hook(this.tab,'update',schedule);this.hook(this.tab,'renderInstalledPlugin',schedule);
    this.hook(this.tab,'hide',()=>{this.observer?.disconnect();this.cancelFrame();});
    for(const key of ['enablePluginAndSave','disablePluginAndSave','uninstallPlugin'])this.hook(this.plugin.app.plugins,key,id=>{
      if(!this.plugin._loaded||this.plugin.groupStore.busy)return;
      const manager=this.plugin.app.plugins;
      if(key==='enablePluginAndSave'&&(!manager.enabledPlugins.has(id)||!manager.plugins[id]))return;
      if(key==='disablePluginAndSave'&&(manager.enabledPlugins.has(id)||manager.plugins[id]))return;
      if(key==='uninstallPlugin'&&manager.manifests[id])return;
      run(async()=>{
        if(key==='uninstallPlugin')await this.plugin.groupStore.forgetMemory(id);
        else await this.plugin.groupStore.rememberExternal(id,this.plugin.app.plugins.enabledPlugins.has(id));
        this.plugin.groupChanged();
      });
    });
    if(this.plugin.app.setting.activeTab===this.tab)this.schedule();
  }
  cancelFrame(){if(this.frame!==null)this.frameWindow?.cancelAnimationFrame(this.frame);this.frame=null;}
  schedule(){const win=this.tab?.containerEl?.ownerDocument?.defaultView;if(!win)return;if(this.frame!==null&&this.frameWindow===win)return;this.cancelFrame();this.frameWindow=win;this.frame=win.requestAnimationFrame(()=>{this.frame=null;this.decorate();});}
  refresh(){if(this.plugin.app.setting.activeTab!==this.tab||!this.tab?.containerEl?.isConnected)return;this.tab.update();}
  restore(){
    if(this.host?.isConnected){for(const row of this.rows)if(row.isConnected)this.host.appendChild(row);this.host.querySelector(':scope > .pm-native-groups')?.remove();}
    this.host=null;this.rows=[];
  }
  decorate(){
    const tab=this.tab;if(this.plugin.app.setting.activeTab!==tab||!tab?.containerEl?.isConnected)return;
    this.observer?.disconnect();
    try{
      const rows=[...tab.containerEl.querySelectorAll('[data-plugin-id]')];
      if(!rows.length){this.host?.querySelector(':scope > .pm-native-groups')?.remove();return;}
      if(!this.host?.isConnected||!this.host.contains(rows[0]))this.host=rows[0].parentElement;
      this.rows=rows;
      // Move existing native rows, retaining their original settings, menu and toggle handlers.
      for(const row of rows)this.host.appendChild(row);
      this.host.querySelector(':scope > .pm-native-groups')?.remove();
      if(!this.plugin.groupStore.groups.length)return;
      const root=this.host.createDiv({cls:'pm-native-groups'}),store=this.plugin.groupStore;
      const query=tab.containerEl.querySelector('input[type="search"]')?.value.trim();
      const visibleRows=rows.filter(row=>row.style.display!=='none'&&!row.hidden);
      const launch=root.createDiv({cls:'pm-native-group-launch'});const manage=launch.createEl('button',{text:'플러그인 관리 열기'});manage.onclick=()=>this.plugin.openGroups();
      const grouped=new Set();
      const addSection=(id,name,members,group)=>{
        if(!members.length)return;
        const d=root.createEl('details',{cls:'pm-native-group',attr:{'data-pm-group-id':id}});d.open=!!query||!store.collapsed[id];
        const summary=d.createEl('summary');summary.createSpan({text:name+' · '+members.length+'개'});
        if(group){const actions=summary.createSpan({cls:'pm-native-group-actions'});actions.onclick=e=>e.stopPropagation();groupToggle(actions,this.plugin,group);}
        const body=d.createDiv({cls:'pm-native-group-body'});for(const row of members){grouped.add(row.dataset.pluginId);body.appendChild(row);}
        d.ontoggle=()=>{if(!d.isConnected||query)return;const collapsed=!d.open;if(!!store.collapsed[id]!==collapsed){store.collapsed[id]=collapsed;this.plugin.persist();}};
      };
      for(const group of store.groups)addSection(group.id,group.name,visibleRows.filter(r=>group.pluginIds.includes(r.dataset.pluginId)),group);
      addSection('none','그룹 없음',visibleRows.filter(r=>!grouped.has(r.dataset.pluginId)));
    }finally{
      if(!this.observer)this.observer=new MutationObserver(records=>{if(records.some(r=>r.type==='childList'||r.target.matches?.('[data-plugin-id]')))this.schedule();});
      this.observer.observe(tab.containerEl,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class','hidden']});
    }
  }
  destroy(){this.cancelFrame();this.observer?.disconnect();this.restore();for(const undo of this.hooks.reverse())undo();}
}
module.exports={NativeGroups};

},
"./main.cjs": function(module,exports,require){
const {Plugin,Modal,Notice,Platform,Menu,addIcon}=require('obsidian');
const {Recorder}=require('./recorder.cjs');
const {emptyTotals}=require('./profile.cjs');
const {OverlayManager}=require('./overlay.cjs');
const {GroupStore}=require('./groups.cjs');
const {GroupsModal,ManagerSettingTab}=require('./group-ui.cjs');
const {NativeGroups}=require('./native-groups.cjs');
const format=ms=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(ms)+' ms';

class RuntimeModal extends Modal {
  constructor(app,plugin){super(app);this.plugin=plugin;this.openRows=new Set();}
  onOpen(){this.modalEl.addClass('pm-runtime-modal');this.plugin.modals.add(this);this.render();}
  onClose(){this.plugin.modals.delete(this);this.contentEl.empty();}
  render(){
    const scroll=this.contentEl.scrollTop;
    const active=document.activeElement?.dataset?.action;
    const root=this.contentEl;root.empty();root.addClass('pm-runtime');
    const r=this.plugin.recorder;
    const live=r.state!=='idle';
    const result=live?r.snapshot():this.plugin.last;
    const total=result?.total||emptyTotals();
    const catalog=result?.catalog||this.plugin.catalog();
    root.createDiv({cls:'pm-eyebrow',text:'Performance Manager'});
    root.createEl('h2',{text:'사용 중 처리 시간'});
    const status=root.createDiv({cls:'pm-session',attr:{role:'status','aria-live':'polite'}});
    status.createSpan({text:r.state==='starting'?'측정 준비 중':r.state==='stopping'?'결과 정리 중':live?'측정 중 · 플러그인은 그대로 켜져 있습니다':result?'측정 완료 · '+new Date(result.at).toLocaleString('ko-KR'):'측정 시작을 누르고 평소처럼 사용하세요'});
    if(result)status.createSpan({text:'경과 '+(result.wallMs/1000).toFixed(1)+'초 · 기록 '+(total.durationMs/1000).toFixed(1)+'초'});
    const actions=root.createDiv({cls:'pm-actions'});
    const start=actions.createEl('button',{text:'측정 시작',cls:'mod-cta',attr:{'data-action':'start'}});start.disabled=live;
    start.onclick=()=>this.plugin.start();
    const stop=actions.createEl('button',{text:'측정 종료',attr:{'data-action':'stop'}});stop.disabled=r.state!=='recording';
    stop.onclick=()=>this.plugin.stop();
    const copy=actions.createEl('button',{text:'결과 복사',attr:{'data-action':'copy'}});copy.disabled=!result;
    copy.onclick=async()=>{try{await navigator.clipboard.writeText(this.plugin.textReport(result));new Notice('측정 결과를 복사했습니다.');}catch{new Notice('클립보드에 복사하지 못했습니다.');}};
    root.createDiv({cls:'pm-help',text:'측정 중 이 창을 닫아도 계속 측정합니다. 약 10초마다 갱신 · 최대 10분 후 자동 종료'});
    const error=r.error||result?.error||this.plugin.saveError;
    if(error)root.createDiv({cls:'pm-error',text:error,attr:{role:'alert'}});
    if(result?.reason==='interrupted')root.createDiv({cls:'pm-error',text:'연결 중단 전까지 완료된 구간만 표시합니다.'});
    const columns=root.createDiv({cls:'pm-columns'});columns.createSpan({text:'플러그인 · 많이 쓴 순'});columns.createSpan({text:'확인된 처리 시간 ≈'});
    const entries=new Map(this.plugin.catalog().map(p=>[p.id,p]));
    for(const p of catalog)entries.set(p.id,p);
    const rows=[...entries.values()].sort((a,b)=>(total.plugins[b.id]?.ms||0)-(total.plugins[a.id]?.ms||0)||a.name.localeCompare(b.name,'ko'));
    const maximum=Math.max(1,...Object.values(total.plugins).map(p=>p.ms));
    const list=root.createDiv({cls:'pm-list'});
    for(const p of rows){
      const group=total.plugins[p.id];
      if(group?.samples){
        const detail=list.createEl('details',{cls:'pm-plugin'});detail.open=this.openRows.has(p.id);
        detail.ontoggle=()=>{if(detail.open)this.openRows.add(p.id);else this.openRows.delete(p.id);};
        const head=detail.createEl('summary');
        const identity=head.createDiv({cls:'pm-identity'});identity.createSpan({cls:'pm-plugin-name',text:p.name});identity.createSpan({cls:'pm-version',text:p.version||''});
        if(p.id===this.plugin.manifest.id)identity.createSpan({cls:'pm-version',text:'이 측정 도구'});
        head.createSpan({cls:'pm-number',text:format(group.ms)});
        const track=head.createDiv({cls:'pm-track'});const bar=track.createDiv({cls:'pm-bar'});bar.style.width=(group.ms/maximum*100)+'%';
        const body=detail.createDiv({cls:'pm-functions'});
        body.createDiv({cls:'pm-function-heading',text:'확인된 함수 · 직접 실행 또는 호출한 공통 처리 포함'});
        const functions=Object.values(group.functions).sort((a,b)=>b.ms-a.ms);
        for(const f of functions){const row=body.createDiv({cls:'pm-function-row'});const name=row.createDiv();name.createSpan({text:f.name});if(f.line>0)name.createSpan({cls:'pm-location',text:' · 코드 '+f.line+'행'});row.createSpan({cls:'pm-number',text:format(f.ms)});}
        body.createDiv({cls:'pm-function-heading',text:'함수 이름은 플러그인이 제공한 코드 이름입니다. 처리 시간만으로 렉 원인을 확정하지 않습니다.'});
      }else{
        const row=list.createDiv({cls:'pm-unmeasured'});row.createSpan({text:p.name});
        row.createSpan({cls:'pm-no-value',text:!p.enabled?'꺼져 있음':!p.loaded?'불러오지 않음':!result?'측정 전':'이번 측정에서 처리 확인 안 됨'});
      }
    }
    if(!rows.length)list.createDiv({text:'설치된 플러그인 목록을 불러올 수 없습니다.'});
    const other=root.createDiv({cls:'pm-other'});
    for(const [label,value] of [['앱·공통 처리',total.coreMs],['출처·시간을 확인하지 못한 처리',total.unknownMs],['대기',total.idleMs]]){
      const row=other.createDiv();row.createSpan({text:label});row.createSpan({cls:'pm-number',text:result?format(value):'—'});
    }
    const foot=root.createDiv({cls:'pm-footnote'});
    foot.createDiv({text:'숫자는 측정 구간의 처리 시간 추정치입니다. 시작 시간·CPU %·메모리 MB가 아닙니다.'});
    foot.createDiv({text:'처리가 안 잡혔다고 사용량이 0인 것은 아닙니다. 별도 창·Worker의 처리는 포함하지 않습니다.'});
    this.contentEl.scrollTop=scroll;
    if(active)root.querySelector('[data-action="'+active+'"]')?.focus({preventScroll:true});
  }
}

module.exports=class PerformanceManager extends Plugin {
  async onload(){
    this.modals=new Set();this.last=null;this.saveError=null;this.saveQueue=Promise.resolve();
    const data=await this.loadData();if(data?.last?.schema===1&&data.last.total&&Array.isArray(data.last.catalog))this.last=data.last;
    this.overlaySettings={shown:!!data?.overlay?.shown,box:data?.overlay?.box||{}};
    this.groupWindow=data?.groupWindow||{};this.groupModals=new Set();this.groupTransaction=data?.groupTransaction||null;this.groupStore=new GroupStore(this,data?.groupState);
    this.recorder=new Recorder({
      getDebugger:()=>{if(!Platform.isDesktopApp)throw new Error('데스크톱 Obsidian에서만 측정할 수 있습니다.');return require('@electron/remote').getCurrentWebContents().debugger;},
      catalog:()=>this.catalog(),
      onUpdate:()=>this.refresh(),
      onFinish:async result=>{this.last=result;await this.persist();this.refresh();}
    });
    this.addRibbonIcon('gauge','플러그인 처리 시간',()=>this.openResults());
    addIcon('pm-plugin-manager','<g transform="scale(4.166667)" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9V5a1 1 0 0 0-1-1h-3a2.5 2.5 0 1 0-5 0H3a1 1 0 0 0-1 1v3a2.5 2.5 0 1 1 0 5v4a1 1 0 0 0 1 1h3a2.5 2.5 0 1 1 5 0h1"/><path d="m16.8 12.5 .4-1h1.6l.4 1 1 .4 1-.4 1.1 1.1-.4 1 .4 1 1 .4v1.6l-1 .4-.4 1 .4 1-1.1 1.1-1-.4-1 .4-.4 1h-1.6l-.4-1-1-.4-1 .4-1.1-1.1.4-1-.4-1-1-.4V16l1-.4.4-1-.4-1 1.1-1.1 1 .4z" transform="translate(0 1)"/><circle cx="18" cy="18" r="1.7"/></g>');
    this.addRibbonIcon('pm-plugin-manager','플러그인 관리',()=>this.openGroups());
    this.addCommand({id:'open-plugin-groups',name:'플러그인 관리',callback:()=>this.openGroups()});
    this.addSettingTab(new ManagerSettingTab(this.app,this));
    this.addCommand({id:'open-plugin-runtime',name:'플러그인 처리 시간 보기',callback:()=>this.openResults()});
    this.addCommand({id:'start-plugin-runtime',name:'플러그인 처리 시간 측정 시작',callback:()=>this.start()});
    this.addCommand({id:'stop-plugin-runtime',name:'플러그인 처리 시간 측정 종료',callback:()=>this.stop()});
    this.overlays=new OverlayManager(this);
    this.nativeGroups=new NativeGroups(this);
    this.app.workspace.onLayoutReady(()=>{if(this._loaded){this.overlays.sync();this.nativeGroups.install();this.groupStore.recover().then(()=>this.groupStore.initializeMemory()).catch(e=>new Notice(String(e.message||e)));}});
    this.registerEvent(this.app.workspace.on('layout-change',()=>this.overlays.sync()));
    this.registerEvent(this.app.workspace.on('active-leaf-change',()=>this.overlays.sync()));
    this.register(()=>{this.recorder.dispose();this.overlays.destroy();this.nativeGroups.destroy();for(const modal of [...this.modals,...this.groupModals])modal.close();});
  }
  catalog(){
    const manager=this.app.plugins;
    return Object.values(manager?.manifests||{}).map(m=>({id:m.id,name:m.name||m.id,version:m.version||'',enabled:!!manager.enabledPlugins?.has(m.id),loaded:!!manager.plugins?.[m.id]}));
  }
  persist(){this.saveQueue=this.saveQueue.catch(()=>{}).then(async()=>{try{await this.saveData({last:this.last,overlay:this.overlaySettings,groupState:this.groupStore?.snapshot(),groupWindow:this.groupWindow,groupTransaction:this.groupTransaction});this.saveError=null;}catch{this.saveError='측정 결과 또는 설정을 저장하지 못했습니다.';}});return this.saveQueue;}
  openGroups(){if(!this.groupModals.size)new GroupsModal(this).open();}
  groupChanged(){for(const modal of this.groupModals)modal.render();this.nativeGroups?.refresh();this.refreshOverlays();}
  openPluginMenu(manifest,anchor,modal){
    const menu=new Menu();const settings=this.app.setting;
    const community=settings.findTabById?.('community-plugins');
    if(typeof community?.buildPluginActionsMenu==='function'){
      community.buildPluginActionsMenu(menu,manifest);
      for(const item of menu.items){
        const callback=item.callback;if(typeof callback!=='function')continue;
        if(item.section==='info')item.onClick(event=>{modal.close();settings.open();return callback(event);});
      }
      const rect=anchor.getBoundingClientRect();menu.showAtPosition({x:rect.left,y:rect.bottom});return;
    }
    if(settings.pluginTabs?.some(t=>t.id===manifest.id))menu.addItem(i=>i.setTitle('설정').setIcon('settings').onClick(()=>{modal.close();settings.open();settings.openTabById(manifest.id);}));
    if(Object.keys(this.app.commands.commands).some(id=>id.startsWith(manifest.id+':')))menu.addItem(i=>i.setTitle('단축키').setIcon('keyboard').onClick(()=>{modal.close();settings.open();const tab=settings.openTabById('hotkeys');tab?.setQuery?.(manifest.id);}));
    if(!settings.pluginTabs?.some(t=>t.id===manifest.id)&&!Object.keys(this.app.commands.commands).some(id=>id.startsWith(manifest.id+':')))menu.addItem(i=>i.setTitle('설정·단축키가 없는 플러그인입니다').setDisabled(true));
    const rect=anchor.getBoundingClientRect();menu.showAtPosition({x:rect.left,y:rect.bottom});
  }
  refreshOverlays(){this.overlays?.render();}
  refresh(){for(const modal of this.modals)modal.render();this.refreshOverlays();}
  openResults(){if(this.modals.size){[...this.modals][0].render();return;}new RuntimeModal(this.app,this).open();}
  async start(openModal=true){try{await this.recorder.start();if(openModal&&!this.modals.size)this.openResults();}catch(e){new Notice('측정 시작 실패: '+String(e.message||e));this.refresh();}}
  async stop(){await this.recorder.stop();}
  textReport(result){
    const t=result.total;const names=new Map(result.catalog.map(p=>[p.id,p.name]));
    const rows=Object.entries(t.plugins).sort((a,b)=>b[1].ms-a[1].ms).map(([id,p])=>(names.get(id)||id)+'\t'+format(p.ms));
    return ['Performance Manager '+this.manifest.version,'측정 일시: '+result.at,'기록된 구간: '+(t.durationMs/1000).toFixed(1)+'초','처리 시간 추정치 (CPU %·메모리 사용량 아님)',...rows,'앱·공통 처리\t'+format(t.coreMs),'출처 미확인\t'+format(t.unknownMs),'대기\t'+format(t.idleMs)].join('\n');
  }
};

}};
const cache={};
function localRequire(id){if(!factories[id])return nativeRequire(id);if(!cache[id]){const m={exports:{}};cache[id]=m;factories[id](m,m.exports,localRequire);}return cache[id].exports;}
module.exports=localRequire('./main.cjs');
})(require);
