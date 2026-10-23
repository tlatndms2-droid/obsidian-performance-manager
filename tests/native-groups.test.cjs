const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const moduleStub={exports:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../src/native-groups.cjs'),'utf8'),{module:moduleStub,require:()=>({})});
const {NativeGroups}=moduleStub.exports;
test('settings search finalizes grouping and opens the target before native scroll',()=>{
 const events=[],group={open:false},row={dataset:{pluginId:'test-plugin'},closest:selector=>selector==='[data-plugin-id]'?row:group};
 const definition={},tab={getElementForDefinition:d=>d===definition?row:null};
 const native=new NativeGroups({app:{}});native.tab=tab;
 native.cancelFrame=()=>events.push('cancel');native.decorate=()=>events.push('group');
 const setting={scrollToDefinition(t,d){assert.equal(t,tab);assert.equal(d,definition);assert.ok(group.open);events.push('scroll');return 'native result';}};
 native.hook(setting,'scrollToDefinition',()=>{},(t,d)=>native.prepareReveal(t,d));
 assert.equal(setting.scrollToDefinition(tab,definition),'native result');assert.deepEqual(events,['cancel','group','scroll']);
 assert.equal(native.revealedPluginId,'test-plugin');assert.equal(native.pendingScrollId,'test-plugin');
 native.hooks[0]();group.open=false;assert.throws(()=>setting.scrollToDefinition(tab,definition));
});
test('unrelated settings and missing plugin rows retain native behavior',()=>{
 const native=new NativeGroups({app:{}}),tab={getElementForDefinition:()=>null};native.tab=tab;
 native.decorate=()=>assert.fail('unrelated setting was decorated');native.cancelFrame=()=>assert.fail('unrelated setting interrupted');
 native.prepareReveal({},{});native.prepareReveal(tab,{});
});
