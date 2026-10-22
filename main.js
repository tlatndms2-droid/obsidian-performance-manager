/* Performance Manager 0.1.1 */
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
"./main.cjs": function(module,exports,require){
const {Plugin,Modal,Notice,Platform}=require('obsidian');
const {Recorder}=require('./recorder.cjs');
const {emptyTotals}=require('./profile.cjs');
const {OverlayManager}=require('./overlay.cjs');
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
    this.recorder=new Recorder({
      getDebugger:()=>{if(!Platform.isDesktopApp)throw new Error('데스크톱 Obsidian에서만 측정할 수 있습니다.');return require('@electron/remote').getCurrentWebContents().debugger;},
      catalog:()=>this.catalog(),
      onUpdate:()=>this.refresh(),
      onFinish:async result=>{this.last=result;await this.persist();this.refresh();}
    });
    this.addRibbonIcon('gauge','플러그인 처리 시간',()=>this.openResults());
    this.addCommand({id:'open-plugin-runtime',name:'플러그인 처리 시간 보기',callback:()=>this.openResults()});
    this.addCommand({id:'start-plugin-runtime',name:'플러그인 처리 시간 측정 시작',callback:()=>this.start()});
    this.addCommand({id:'stop-plugin-runtime',name:'플러그인 처리 시간 측정 종료',callback:()=>this.stop()});
    this.overlays=new OverlayManager(this);
    this.app.workspace.onLayoutReady(()=>{if(this._loaded)this.overlays.sync();});
    this.registerEvent(this.app.workspace.on('layout-change',()=>this.overlays.sync()));
    this.registerEvent(this.app.workspace.on('active-leaf-change',()=>this.overlays.sync()));
    this.register(()=>{this.recorder.dispose();this.overlays.destroy();for(const modal of [...this.modals])modal.close();});
  }
  catalog(){
    const manager=this.app.plugins;
    return Object.values(manager?.manifests||{}).map(m=>({id:m.id,name:m.name||m.id,version:m.version||'',enabled:!!manager.enabledPlugins?.has(m.id),loaded:!!manager.plugins?.[m.id]}));
  }
  persist(){this.saveQueue=this.saveQueue.catch(()=>{}).then(async()=>{try{await this.saveData({last:this.last,overlay:this.overlaySettings});this.saveError=null;}catch{this.saveError='측정 결과 또는 오버레이 설정을 저장하지 못했습니다.';}});return this.saveQueue;}
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
