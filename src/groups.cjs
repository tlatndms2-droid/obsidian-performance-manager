class GroupStore {
  constructor(plugin,data={}){
    this.plugin=plugin;this.busy=false;this.error='';this.collapsed=data.collapsed||{};this.treeCollapsed=data.treeCollapsed||{};this.hideSubgroupPlugins=!!data.hideSubgroupPlugins;
    const assigned=new Set(),ids=new Set();
    this.groups=(Array.isArray(data.groups)?data.groups:[]).filter(g=>g&&typeof g.id==='string'&&typeof g.name==='string'&&!ids.has(g.id)&&ids.add(g.id)).map(g=>{const pluginIds=(Array.isArray(g.pluginIds)?g.pluginIds:[]).filter(id=>typeof id==='string'&&!assigned.has(id)&&assigned.add(id));return {id:g.id,name:g.name,parentId:typeof g.parentId==='string'?g.parentId:null,pluginIds,rememberedEnabled:Object.fromEntries(pluginIds.filter(id=>typeof g.rememberedEnabled?.[id]==='boolean').map(id=>[id,g.rememberedEnabled[id]]))};});
    const parents=new Map(this.groups.map(g=>[g.id,g.parentId]));for(const g of this.groups)if(g.parentId===g.id||!parents.has(g.parentId)||parents.get(g.parentId))g.parentId=null;
  }
  snapshot(){return JSON.parse(JSON.stringify({groups:this.groups,collapsed:this.collapsed,treeCollapsed:this.treeCollapsed,hideSubgroupPlugins:this.hideSubgroupPlugins}));}
  async setHideSubgroupPlugins(value){await this.edit(()=>{this.hideSubgroupPlugins=!!value;});}
  isManagerVisible(view,id){return this.isVisible(view,id)&&!(this.hideSubgroupPlugins&&this.groupFor(id)?.parentId===view);}
  roots(){return this.groups.filter(g=>!g.parentId);}
  children(id){return this.groups.filter(g=>g.parentId===id);}
  orderedGroups(){return this.roots().flatMap(g=>[g,...this.children(g.id)]);}
  subtree(id){return [this.find(id),...this.children(id)];}
  members(id){return [...new Set(this.subtree(id).flatMap(g=>g.pluginIds))];}
  path(id,separator=' / '){const g=this.find(id);return g.parentId?this.find(g.parentId).name+separator+g.name:g.name;}
  contains(groupId,pluginId){return this.members(groupId).includes(pluginId);}
  assertParent(id,parentId){if(!parentId)return;const parent=this.find(parentId);if(id===parentId||parent.parentId||this.children(id).length)throw new Error('상위 그룹과 하위 그룹의 2단계까지만 만들 수 있습니다.');}
  async toggleTree(id){await this.edit(()=>{this.find(id);this.treeCollapsed[id]=!this.treeCollapsed[id];});}
  async save(){await this.plugin.persist();if(this.plugin.saveError)throw new Error(this.plugin.saveError);}
  changed(){this.plugin.groupChanged?.();}
  memory(){return Object.fromEntries(this.groups.map(g=>[g.id,{...g.rememberedEnabled}]));}
  restoreMemory(memory){for(const g of this.groups)if(memory?.[g.id])g.rememberedEnabled={...memory[g.id]};}
  fillMemory(){let changed=false;for(const g of this.groups)for(const id of g.pluginIds)if(!Object.hasOwn(g.rememberedEnabled,id)&&this.plugin.app.plugins.manifests[id]){g.rememberedEnabled[id]=this.plugin.app.plugins.enabledPlugins.has(id);changed=true;}return changed;}
  async initializeMemory(){if(this.busy||this.plugin.groupTransaction?.before)return;const previous=this.memory();if(!this.fillMemory())return;this.busy=true;try{await this.save();}catch(e){this.restoreMemory(previous);throw e;}finally{this.busy=false;this.changed();}}
  isVisible(view,id){const manager=this.plugin.app.plugins;if(!manager.manifests[id])return false;const group=this.groupFor(id),active=!!manager.plugins[id];if(view==='none')return !group&&active;if(view==='disabled')return !group&&!active;return !!group&&(group.id===view||group.parentId===view);}
  async edit(fn){
    if(this.busy)throw new Error('플러그인 전환이 끝난 후 수정하세요.');
    if(this.plugin.groupTransaction?.before)throw new Error('이전 전환 복구를 먼저 완료해야 합니다.');
    const previous=this.snapshot();this.busy=true;
    try{fn();await this.save();}catch(e){this.groups=previous.groups;this.collapsed=previous.collapsed;this.treeCollapsed=previous.treeCollapsed;this.hideSubgroupPlugins=previous.hideSubgroupPlugins;throw e;}finally{this.busy=false;this.changed();}
  }
  async create(name,parentId=null){
    name=name.trim();if(!name)throw new Error('그룹 이름을 입력하세요.');
    if(this.groups.some(g=>g.name===name))throw new Error('같은 이름의 그룹이 있습니다.');
    const id=globalThis.crypto?.randomUUID?.()||'group-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    this.assertParent(id,parentId);
    await this.edit(()=>{this.groups.push({id,name,parentId,pluginIds:[],rememberedEnabled:{}});if(parentId)this.treeCollapsed[parentId]=false;});return id;
  }
  async rename(id,name){name=name.trim();if(!name)throw new Error('그룹 이름을 입력하세요.');if(this.groups.some(g=>g.id!==id&&g.name===name))throw new Error('같은 이름의 그룹이 있습니다.');await this.edit(()=>{const g=this.find(id);g.name=name;});}
  find(id){const g=this.groups.find(g=>g.id===id);if(!g)throw new Error('그룹을 찾을 수 없습니다.');return g;}
  async remove(id){await this.edit(()=>{this.groups=this.groups.filter(g=>g.id!==id);for(const g of this.children(id))g.parentId=null;delete this.collapsed[id];delete this.treeCollapsed[id];});}
  async reparentGroup(id,parentId){this.find(id);this.assertParent(id,parentId);await this.edit(()=>{this.find(id).parentId=parentId||null;if(parentId)this.treeCollapsed[parentId]=false;});}
  async moveGroup(id,target,after=false){
    this.find(id);const destination=this.find(target);if(id===target)return;this.assertParent(id,destination.parentId);
    await this.edit(()=>{const group=this.find(id);group.parentId=destination.parentId;this.groups=this.groups.filter(g=>g.id!==id);const index=this.groups.findIndex(g=>g.id===target);this.groups.splice(index+(after?1:0),0,group);});
  }
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
    const manager=this.plugin.app.plugins;
    const ids=this.members(id).filter(id=>manager.manifests[id]&&id!==this.plugin.manifest.id);
    const states=Object.fromEntries(ids.map(id=>{const memory=this.groupFor(id).rememberedEnabled;return [id,enabled?(Object.hasOwn(memory,id)?memory[id]:manager.enabledPlugins.has(id)):false];}));
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
