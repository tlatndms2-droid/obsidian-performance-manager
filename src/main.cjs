const {Plugin,Modal,Notice,Platform}=require('obsidian');
const {Recorder}=require('./recorder.cjs');
const {emptyTotals}=require('./profile.cjs');
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
    this.modals=new Set();this.last=null;this.saveError=null;
    const data=await this.loadData();if(data?.last?.schema===1&&data.last.total&&Array.isArray(data.last.catalog))this.last=data.last;
    this.recorder=new Recorder({
      getDebugger:()=>{if(!Platform.isDesktopApp)throw new Error('데스크톱 Obsidian에서만 측정할 수 있습니다.');return require('@electron/remote').getCurrentWebContents().debugger;},
      catalog:()=>this.catalog(),
      onUpdate:()=>this.refresh(),
      onFinish:async result=>{this.last=result;try{await this.saveData({last:result});this.saveError=null;}catch{this.saveError='마지막 결과를 저장하지 못했습니다.';}this.refresh();}
    });
    this.addRibbonIcon('gauge','플러그인 처리 시간',()=>this.openResults());
    this.addCommand({id:'open-plugin-runtime',name:'플러그인 처리 시간 보기',callback:()=>this.openResults()});
    this.addCommand({id:'start-plugin-runtime',name:'플러그인 처리 시간 측정 시작',callback:()=>this.start()});
    this.addCommand({id:'stop-plugin-runtime',name:'플러그인 처리 시간 측정 종료',callback:()=>this.stop()});
    this.register(()=>{this.recorder.dispose();for(const modal of [...this.modals])modal.close();});
  }
  catalog(){
    const manager=this.app.plugins;
    return Object.values(manager?.manifests||{}).map(m=>({id:m.id,name:m.name||m.id,version:m.version||'',enabled:!!manager.enabledPlugins?.has(m.id),loaded:!!manager.plugins?.[m.id]}));
  }
  refresh(){for(const modal of this.modals)modal.render();}
  openResults(){if(this.modals.size){[...this.modals][0].render();return;}new RuntimeModal(this.app,this).open();}
  async start(){try{await this.recorder.start();if(!this.modals.size)this.openResults();}catch(e){new Notice('측정 시작 실패: '+String(e.message||e));this.refresh();}}
  async stop(){await this.recorder.stop();}
  textReport(result){
    const t=result.total;const names=new Map(result.catalog.map(p=>[p.id,p.name]));
    const rows=Object.entries(t.plugins).sort((a,b)=>b[1].ms-a[1].ms).map(([id,p])=>(names.get(id)||id)+'\t'+format(p.ms));
    return ['Performance Manager '+this.manifest.version,'측정 일시: '+result.at,'기록된 구간: '+(t.durationMs/1000).toFixed(1)+'초','처리 시간 추정치 (CPU %·메모리 사용량 아님)',...rows,'앱·공통 처리\t'+format(t.coreMs),'출처 미확인\t'+format(t.unknownMs),'대기\t'+format(t.idleMs)].join('\n');
  }
};
