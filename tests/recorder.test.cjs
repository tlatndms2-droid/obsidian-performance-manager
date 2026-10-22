const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Recorder}=require('../src/recorder.cjs');
class FakeDebugger extends EventEmitter {
  constructor(){super();this.attached=false;this.calls=[];}
  isAttached(){return this.attached;}
  attach(){this.attached=true;}
  detach(){this.attached=false;this.emit('detach',{},'test');}
  async sendCommand(method){this.calls.push(method);if(method==='Debugger.enable')this.emit('message',{},'Debugger.scriptParsed',{scriptId:'7',url:'plugin:a'});if(method==='Profiler.stop')return {profile:{startTime:0,endTime:2000,nodes:[{id:1,callFrame:{functionName:'work',url:'',scriptId:'7',lineNumber:0,columnNumber:0}}],samples:[1],timeDeltas:[2000]}};return {};}
}
function setup(){const d=new FakeDebugger();let saved;const r=new Recorder({getDebugger:()=>d,catalog:()=>[{id:'a',name:'A'}],onUpdate:()=>{},onFinish:x=>{saved=x;},chunkMs:100000,maxMs:100000});return {r,d,saved:()=>saved};}
test('rotates, keeps aggregate, saves only summary and releases connection',async()=>{
  const {r,d,saved}=setup();await r.start();await r.enqueue(()=>r.rotate());assert.equal(r.total.plugins.a.ms,2);
  await r.stop();assert.equal(saved().total.plugins.a.ms,4);assert.equal(d.isAttached(),false);assert.equal(d.listenerCount('message'),0);assert.equal(r.state,'idle');
  assert.equal('nodes' in saved(),false);
});
test('refuses debugger already in use without detaching it',async()=>{
  const {r,d}=setup();d.attached=true;await assert.rejects(r.start(),/다른 측정기/);assert.equal(d.attached,true);assert.equal(d.calls.length,0);r.dispose();assert.equal(d.attached,true);
});
test('external detach saves completed chunks and clears timers',async()=>{
  const {r,d,saved}=setup();await r.start();await r.enqueue(()=>r.rotate());d.detach();assert.equal(r.state,'idle');assert.equal(saved().reason,'interrupted');assert.equal(saved().total.segments,1);assert.equal(d.listenerCount('message'),0);
});
test('unload releases owned debugger and prevents restarting',async()=>{
  const {r,d}=setup();await r.start();r.dispose();assert.equal(d.isAttached(),false);await assert.rejects(r.start(),/종료/);
});
test('concurrent start and repeated stop do not create duplicate sessions',async()=>{
  const {r,d}=setup();await Promise.all([r.start(),r.start()]);await Promise.all([r.stop(),r.stop()]);assert.equal(d.calls.filter(x=>x==='Profiler.start').length,1);assert.equal(d.calls.filter(x=>x==='Profiler.stop').length,1);
});
test('automatic time limit finishes and releases the debugger',async()=>{
  const {r,d,saved}=setup();r.maxMs=20;await r.start();await new Promise(resolve=>setTimeout(resolve,70));await r.queue;
  assert.equal(saved().reason,'limit');assert.equal(r.state,'idle');assert.equal(d.attached,false);
});
test('materializes bridge-backed profile arrays before iterating samples',async()=>{
  const {r,d}=setup();let reads=0;const send=d.sendCommand.bind(d);d.sendCommand=async method=>{
    const result=await send(method);if(result.profile){const values=result.profile.timeDeltas;Object.defineProperty(result.profile,'timeDeltas',{enumerable:true,get(){reads++;return values;}});}return result;
  };
  await r.start();await r.stop();assert.equal(reads,1);assert.equal(r.total.plugins.a.ms,2);
});
