const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarize,merge,emptyTotals}=require('../src/profile.cjs');
const frame=(functionName,url='',scriptId='0')=>({functionName,url,scriptId,lineNumber:2,columnNumber:3});
const catalog=[{id:'a',name:'A'},{id:'b',name:'B'}];
test('assigns exclusive time to nearest plugin without charging its callers twice',()=>{
  const profile={startTime:0,endTime:10000,nodes:[
    {id:1,callFrame:frame('(root)'),children:[2,5,6,7]},
    {id:2,callFrame:frame('outer','plugin:a'),children:[3]},
    {id:3,callFrame:frame('inner','plugin:b'),children:[4]},
    {id:4,callFrame:frame('native','app://obsidian.md/app.js')},
    {id:5,callFrame:frame('(idle)')},
    {id:6,callFrame:frame('core','app://obsidian.md/app.js')},
    {id:7,callFrame:frame('unknown')}
  ],samples:[2,3,4,5,6,7],timeDeltas:[1000,1000,2000,1000,1000,1000]};
  const r=summarize(profile,catalog);
  assert.equal(r.plugins.a.ms,1);assert.equal(r.plugins.b.ms,3);
  assert.equal(r.idleMs,1);assert.equal(r.coreMs,1);assert.equal(r.unknownMs,4);
  assert.equal(r.pluginMs+r.idleMs+r.coreMs+r.unknownMs,r.durationMs);
});
test('resolves blank profile URLs by script ID, keeps source location',()=>{
  const p={startTime:0,endTime:2000,nodes:[{id:1,callFrame:frame('test','','12')}],samples:[1],timeDeltas:[2000]};
  const r=summarize(p,catalog,{'12':'plugin:a'});
  assert.equal(r.plugins.a.ms,2);assert.equal(Object.values(r.plugins.a.functions)[0].line,3);
});
test('does not guess attribution for missing nodes, unknown plugins or zero samples',()=>{
  const p={startTime:0,endTime:6000,nodes:[{id:1,callFrame:frame('x','plugin:unknown')}],samples:[1,99],timeDeltas:[1000,2000]};
  const r=summarize(p,catalog);assert.deepEqual(r.plugins,{});assert.equal(r.unknownMs,6);
});
test('garbage collection is not assigned to a parent plugin',()=>{
  const p={startTime:0,endTime:2000,nodes:[{id:1,callFrame:frame('x','plugin:a'),children:[2]},{id:2,callFrame:frame('(garbage collector)')}],samples:[2],timeDeltas:[2000]};
  const r=summarize(p,catalog);assert.equal(r.coreMs,2);assert.equal(r.pluginMs,0);
});
test('merges rotations and bounds function summaries without losing plugin totals',()=>{
  const total=emptyTotals();
  const functions=Object.fromEntries(Array.from({length:250},(_,i)=>['f'+i,{name:'f'+i,url:'plugin:a',line:i,ms:1,samples:1}]));
  for(let n=0;n<4;n++)merge(total,{...emptyTotals(),durationMs:250,pluginMs:250,samples:250,segments:1,plugins:{a:{ms:250,samples:250,functions}}});
  assert.equal(total.plugins.a.ms,1000);assert.ok(Object.keys(total.plugins.a.functions).length<=200);
  assert.equal(Object.values(total.plugins.a.functions).reduce((s,f)=>s+f.ms,0),1000);
});
