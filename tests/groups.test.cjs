const {test}=require('node:test');const assert=require('node:assert/strict');
const {GroupStore}=require('../src/groups.cjs');
function setup(){const m={manifests:{a:{name:'A'},b:{name:'B'},c:{name:'C'},self:{name:'Self'}},plugins:{a:{},b:{},c:{},self:{}},enabledPlugins:new Set(['a','b','c','self'])};const calls=[];
  m.enablePluginAndSave=async id=>{calls.push(['on',id]);m.enabledPlugins.add(id);m.plugins[id]={};};m.disablePluginAndSave=async id=>{calls.push(['off',id]);m.enabledPlugins.delete(id);delete m.plugins[id];};
  const p={app:{plugins:m},manifest:{id:'self'},persist:async()=>{},groupChanged:()=>{},groupTransaction:null};const s=new GroupStore(p);p.groupStore=s;return {m,p,s,calls};}
test('assign moves membership without touching activation',async()=>{const {s,m,calls}=setup();const one=await s.create('Canvas'),two=await s.create('글쓰기');await s.assign(['a','b'],one);await s.assign(['a'],two);assert.deepEqual(s.find(one).pluginIds,['b']);assert.deepEqual(s.find(two).pluginIds,['a']);assert.equal(calls.length,0);assert.equal(m.enabledPlugins.size,4);});
test('bulk switch only targets members and protects the manager',async()=>{const {s,m}=setup();await s.apply(['a','self','missing','a'],false);assert.equal(m.enabledPlugins.has('a'),false);assert.equal(m.enabledPlugins.has('self'),true);assert.equal(m.enabledPlugins.has('b'),true);});
test('failure rolls back even the partially failing target',async()=>{const {s,p,m}=setup();const original=m.disablePluginAndSave;m.disablePluginAndSave=async id=>{await original(id);if(id==='b')throw new Error('test failure');};await assert.rejects(s.apply(['a','b'],false),/복구/);assert.equal(m.enabledPlugins.has('a'),true);assert.equal(m.enabledPlugins.has('b'),true);assert.equal(p.groupTransaction,null);assert.equal(s.busy,false);});
test('failed journal persistence prevents any plugin changes',async()=>{const {s,p,calls}=setup();p.persist=async()=>{p.saveError='disk unavailable';};await assert.rejects(s.apply(['a'],false),/disk unavailable/);assert.equal(calls.length,0);});
test('unfinished transaction restores prior activation on recovery',async()=>{const {s,p,m}=setup();await m.disablePluginAndSave('a');p.groupTransaction={before:{a:{enabled:true},b:{enabled:false}}};await s.recover();assert.equal(m.enabledPlugins.has('a'),true);assert.equal(m.enabledPlugins.has('b'),false);assert.equal(p.groupTransaction,null);});
test('deleting a group does not disable or uninstall its plugins',async()=>{const {s,m,calls}=setup();const id=await s.create('Canvas');await s.assign(['a'],id);await s.remove(id);assert.equal(s.groupFor('a'),undefined);assert.ok(m.plugins.a);assert.equal(calls.length,0);});
test('concurrent switches are rejected rather than interleaved',async()=>{const {s,m}=setup();let release;const original=m.disablePluginAndSave;m.disablePluginAndSave=async id=>{await new Promise(r=>release=r);await original(id);};const first=s.apply(['a'],false);await new Promise(r=>setImmediate(r));await assert.rejects(s.apply(['b'],false),/진행 중/);release();await first;assert.ok(m.plugins.b);});

test('classification separates membership from activation',async()=>{
  const {s,m}=setup();const g=await s.create('Mixed');await s.assign(['a','b'],g);await s.apply(['b','c'],false);
  assert.ok(!s.isVisible('all','a'));assert.ok(!s.isVisible('none','a'));assert.ok(!s.isVisible('none','b'));
  assert.deepEqual(['a','b','c','self'].filter(id=>s.isVisible('disabled',id)),['c']);
  assert.deepEqual(['a','b','c','self'].filter(id=>s.isVisible('none',id)),['self']);
  await s.applyGroup(g,false);
  assert.deepEqual(s.find(g).pluginIds,['a','b']);assert.ok(s.isVisible(g,'b'));assert.ok(!s.isVisible('none','a'));assert.ok(!s.isVisible('disabled','a'));
});
test('migration records actual states without activating anything and snapshots do not alias',async()=>{
  const {p,m,calls}=setup();delete m.plugins.b;m.enabledPlugins.delete('b');
  const s=new GroupStore(p,{groups:[{id:'g',name:'G',pluginIds:['a','b'],rememberedEnabled:{a:false}}]});
  await s.initializeMemory();assert.deepEqual(s.find('g').rememberedEnabled,{a:false,b:false});assert.equal(calls.length,0);
  const copy=s.snapshot();copy.groups[0].rememberedEnabled.a=true;assert.equal(s.find('g').rememberedEnabled.a,false);
  const reload=new GroupStore(p,s.snapshot());await reload.initializeMemory();assert.equal(calls.length,0);
});
test('mixed group restores remembered combination and individual changes update only touched values',async()=>{
  const {s,m}=setup();await s.apply(['b'],false);const g=await s.create('Mixed');await s.assign(['a','b','c'],g);
  await s.applyGroup(g,false);assert.deepEqual(s.find(g).rememberedEnabled,{a:true,b:false,c:true});
  await s.applyGroup(g,true);assert.ok(m.plugins.a);assert.equal(m.plugins.b,undefined);assert.ok(m.plugins.c);
  await s.apply(['b'],true);await s.applyGroup(g,false);await s.applyGroup(g,true);assert.ok(m.plugins.b);
  await m.disablePluginAndSave('c');await s.rememberExternal('c',false);
  assert.deepEqual(s.find(g).rememberedEnabled,{a:true,b:true,c:false});
});
test('all-off memory never falls back to enabling every member',async()=>{
  const {s,calls}=setup();const g=await s.create('Off');await s.assign(['a','b'],g);await s.apply(['a','b'],false);const n=calls.length;
  await assert.rejects(s.applyGroup(g,true),/개별적으로/);assert.equal(calls.length,n);
});
test('membership moves capture actual state but same-group assignments and renames preserve memory',async()=>{
  const {s,m}=setup();const one=await s.create('One'),two=await s.create('Two');await s.assign(['a','b'],one);
  await s.applyGroup(one,false);await s.assign(['a'],one);assert.equal(s.find(one).rememberedEnabled.a,true);
  await s.assign(['a'],two);assert.equal(s.find(two).rememberedEnabled.a,false);assert.equal(s.find(one).rememberedEnabled.a,undefined);
  await s.rename(two,'Renamed');assert.equal(s.find(two).rememberedEnabled.a,false);assert.equal(m.plugins.a,undefined);
  await s.remove(two);assert.equal(m.plugins.a,undefined);assert.ok(!s.isVisible('none','a'));assert.ok(s.isVisible('disabled','a'));
});
test('mixed transition failure and final save failure roll back activation and memory',async()=>{
  const {s,m,p}=setup();const g=await s.create('Mixed');await s.assign(['a','b'],g);await s.apply(['b'],false);
  const memory=s.memory(),original=m.disablePluginAndSave;
  m.disablePluginAndSave=async id=>{await original(id);throw Error('partial failure');};
  await assert.rejects(s.applyGroup(g,false),/복구/);assert.ok(m.plugins.a);assert.equal(m.plugins.b,undefined);assert.deepEqual(s.memory(),memory);
  m.disablePluginAndSave=original;let saves=0;p.persist=async()=>{if(++saves===2)throw Error('commit failure');};
  await assert.rejects(s.apply(['b'],true),/commit failure/);assert.equal(m.plugins.b,undefined);assert.deepEqual(s.memory(),memory);assert.equal(p.groupTransaction,null);
});
test('pending recovery restores both memory and actual states',async()=>{
  const {s,m,p}=setup();const g=await s.create('Mixed');await s.assign(['a','b'],g);const rememberedBefore=s.memory();
  await s.apply(['a'],false);p.groupTransaction={before:{a:{enabled:true}},rememberedBefore};
  await s.recover();assert.ok(m.plugins.a);assert.deepEqual(s.memory(),rememberedBefore);assert.equal(p.groupTransaction,null);
});

test('activation file is flushed and checked before clearing the transaction journal',async()=>{
 const {s,m,p}=setup();let file=['a','b','c','self'],pendingAtFlush=false;
 p.app.vault={configDir:'.obsidian',adapter:{read:async()=>JSON.stringify(file)}};
 m.saveConfig=async()=>{pendingAtFlush=!!p.groupTransaction;file=[...m.enabledPlugins];};
 await s.apply(['a'],false);assert.ok(pendingAtFlush);assert.ok(!file.includes('a'));assert.equal(p.groupTransaction,null);
});
test('a silently failed Obsidian config write is detected and rolled back',async()=>{
 const {s,m,p}=setup();const file=['a','b','c','self'];
 p.app.vault={configDir:'.obsidian',adapter:{read:async()=>JSON.stringify(file)}};m.saveConfig=async()=>{};
 await assert.rejects(s.apply(['a'],false),/저장하지 못했습니다/);assert.ok(m.plugins.a);assert.equal(p.groupTransaction,null);
});

test('group reorder moves before and after without changing membership, memory or activation',async()=>{
 const {s,calls}=setup();const a=await s.create('A'),b=await s.create('B'),c=await s.create('C');await s.assign(['a'],a);await s.assign(['b'],b);
 const before=s.snapshot(),memory=s.memory();await s.moveGroup(c,a);assert.deepEqual(s.groups.map(g=>g.id),[c,a,b]);
 await s.moveGroup(c,b,true);assert.deepEqual(s.groups.map(g=>g.id),[a,b,c]);assert.deepEqual(s.snapshot(),before);assert.deepEqual(s.memory(),memory);assert.equal(calls.length,0);
 const reload=new GroupStore(s.plugin,s.snapshot());assert.deepEqual(reload.groups.map(g=>g.id),[a,b,c]);
});
test('failed group reorder save restores the previous order',async()=>{
 const {s,p}=setup();const a=await s.create('A'),b=await s.create('B');p.persist=async()=>{throw Error('disk failure');};
 await assert.rejects(s.moveGroup(b,a),/disk failure/);assert.deepEqual(s.groups.map(g=>g.id),[a,b]);
});

test('subgroup creation preserves direct membership and aggregates only descendants',async()=>{
 const {s,m,calls}=setup();const root=await s.create('Canvas');await s.assign(['a'],root);const child=await s.create('Edit',root);await s.assign(['b'],child);
 assert.equal(s.groupFor('a').id,root);assert.equal(s.groupFor('b').id,child);assert.deepEqual(s.members(root),['a','b']);assert.deepEqual(s.members(child),['b']);
 assert.ok(s.isVisible(root,'b'));assert.ok(!s.isVisible(child,'a'));assert.ok(!s.isVisible('none','b'));assert.equal(s.path(child),'Canvas / Edit');assert.equal(calls.length,0);assert.ok(m.plugins.a);
 const reload=new GroupStore(s.plugin,s.snapshot());assert.equal(reload.find(child).parentId,root);assert.deepEqual(reload.members(root),['a','b']);
});
test('parent restores each owner group memory and child switching does not affect its parent direct items',async()=>{
 const {s,m}=setup();await s.apply(['b'],false);const root=await s.create('Canvas'),child=await s.create('Edit',root);
 await s.assign(['c'],root);await s.assign(['a','b'],child);const memory=s.memory();
 await s.applyGroup(root,false);assert.ok(!m.plugins.a&&!m.plugins.b&&!m.plugins.c);assert.deepEqual(s.memory(),memory);
 await s.applyGroup(root,true);assert.ok(m.plugins.a&&m.plugins.c);assert.equal(m.plugins.b,undefined);
 await s.applyGroup(child,false);assert.ok(m.plugins.c);assert.equal(m.plugins.a,undefined);await s.applyGroup(child,true);assert.ok(m.plugins.a);
 await s.apply(['b'],true);await s.applyGroup(root,false);await s.applyGroup(root,true);assert.ok(m.plugins.b);
});
test('hierarchy rejects cycles and a third level without losing data',async()=>{
 const {s}=setup();const root=await s.create('Root'),child=await s.create('Child',root),other=await s.create('Other');const before=s.snapshot();
 await assert.rejects(s.create('Grandchild',child),/2단계/);await assert.rejects(s.reparentGroup(root,child),/2단계/);await assert.rejects(s.reparentGroup(root,other),/2단계/);await assert.rejects(s.reparentGroup(child,child),/2단계/);assert.deepEqual(s.snapshot(),before);
});
test('drag nesting and sibling placement preserve group contents and memory',async()=>{
 const {s,calls}=setup();const root=await s.create('Root'),one=await s.create('One'),two=await s.create('Two',root);
 await s.assign(['a'],one);const memory=s.memory();await s.reparentGroup(one,root);assert.equal(s.find(one).parentId,root);
 await s.moveGroup(one,two);assert.deepEqual(s.children(root).map(g=>g.id),[one,two]);
 await s.moveGroup(one,root,true);assert.equal(s.find(one).parentId,null);assert.deepEqual(s.find(one).pluginIds,['a']);assert.deepEqual(s.memory(),memory);assert.equal(calls.length,0);
});
test('deleting a parent promotes children and leaves their plugins untouched',async()=>{
 const {s,m}=setup();const root=await s.create('Root'),child=await s.create('Child',root);await s.assign(['a'],root);await s.assign(['b'],child);const remembered={...s.find(child).rememberedEnabled};await s.remove(root);
 assert.equal(s.find(child).parentId,null);assert.deepEqual(s.find(child).rememberedEnabled,remembered);assert.equal(s.groupFor('b').id,child);assert.equal(s.groupFor('a'),undefined);assert.ok(m.plugins.a&&m.plugins.b);
});
test('tree collapse and parent changes roll back together on failed persistence',async()=>{
 const {s,p}=setup();const root=await s.create('Root'),child=await s.create('Child');const before=s.snapshot();p.persist=async()=>{throw Error('disk failure');};
 await assert.rejects(s.reparentGroup(child,root),/disk/);assert.deepEqual(s.snapshot(),before);await assert.rejects(s.toggleTree(root),/disk/);assert.deepEqual(s.snapshot(),before);
});
test('flat migration and malformed parent references never alter plugin ownership or activation',async()=>{
 const {p,calls}=setup();const s=new GroupStore(p,{groups:[{id:'x',name:'X',parentId:'y',pluginIds:['a']},{id:'y',name:'Y',parentId:'x',pluginIds:['b']},{id:'z',name:'Z',parentId:'missing',pluginIds:['c']}]});
 assert.equal(s.roots().length,3);assert.equal(s.groupFor('a').id,'x');assert.equal(s.groupFor('b').id,'y');await s.initializeMemory();assert.equal(calls.length,0);
});

test('hiding subgroup entries only filters the parent manager view',async()=>{
 const {s,calls}=setup();const root=await s.create('Root'),child=await s.create('Child',root);await s.assign(['a'],root);await s.assign(['b'],child);
 const groups=JSON.stringify(s.groups),memory=s.memory();assert.ok(s.isManagerVisible(root,'b'));await s.setHideSubgroupPlugins(true);
 assert.ok(s.isManagerVisible(root,'a'));assert.ok(!s.isManagerVisible(root,'b'));assert.ok(s.isManagerVisible(child,'b'));assert.ok(s.isVisible(root,'b'));assert.deepEqual(s.members(root),['a','b']);assert.equal(JSON.stringify(s.groups),groups);assert.deepEqual(s.memory(),memory);assert.equal(calls.length,0);
 const reload=new GroupStore(s.plugin,s.snapshot());assert.ok(reload.hideSubgroupPlugins);assert.ok(!reload.isManagerVisible(root,'b'));await s.setHideSubgroupPlugins(false);assert.ok(s.isManagerVisible(root,'b'));
});
test('failed display preference persistence restores the previous value',async()=>{
 const {s,p}=setup();assert.equal(s.hideSubgroupPlugins,false);p.persist=async()=>{throw Error('disk failure');};
 await assert.rejects(s.setHideSubgroupPlugins(true),/disk/);assert.equal(s.hideSubgroupPlugins,false);
});
