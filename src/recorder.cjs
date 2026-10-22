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
