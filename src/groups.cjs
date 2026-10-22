class GroupStore {
  constructor(plugin,data={}){
    this.plugin=plugin;this.busy=false;this.error='';this.collapsed=data.collapsed||{};
    const assigned=new Set(),ids=new Set();
    this.groups=(Array.isArray(data.groups)?data.groups:[]).filter(g=>g&&typeof g.id==='string'&&typeof g.name==='string'&&!ids.has(g.id)&&ids.add(g.id)).map(g=>({id:g.id,name:g.name,pluginIds:(Array.isArray(g.pluginIds)?g.pluginIds:[]).filter(id=>typeof id==='string'&&!assigned.has(id)&&assigned.add(id))}));
  }
  snapshot(){return {groups:this.groups,collapsed:this.collapsed};}
  async save(){await this.plugin.persist();if(this.plugin.saveError)throw new Error(this.plugin.saveError);}
  changed(){this.plugin.groupChanged?.();}
  async edit(fn){
    if(this.busy)throw new Error('플러그인 전환이 끝난 후 수정하세요.');
    const previous=JSON.parse(JSON.stringify(this.groups));fn();
    try{await this.save();}catch(e){this.groups=previous;throw e;}this.changed();
  }
  async create(name){
    name=name.trim();if(!name)throw new Error('그룹 이름을 입력하세요.');
    if(this.groups.some(g=>g.name===name))throw new Error('같은 이름의 그룹이 있습니다.');
    const id=globalThis.crypto?.randomUUID?.()||'group-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    await this.edit(()=>this.groups.push({id,name,pluginIds:[]}));return id;
  }
  async rename(id,name){name=name.trim();if(!name)throw new Error('그룹 이름을 입력하세요.');if(this.groups.some(g=>g.id!==id&&g.name===name))throw new Error('같은 이름의 그룹이 있습니다.');await this.edit(()=>{const g=this.find(id);g.name=name;});}
  find(id){const g=this.groups.find(g=>g.id===id);if(!g)throw new Error('그룹을 찾을 수 없습니다.');return g;}
  async remove(id){await this.edit(()=>{this.groups=this.groups.filter(g=>g.id!==id);});}
  async assign(ids,target){
    const selected=new Set(ids.filter(id=>this.plugin.app.plugins.manifests[id]));
    if(target)this.find(target);
    await this.edit(()=>{for(const g of this.groups)g.pluginIds=g.pluginIds.filter(id=>!selected.has(id));if(target)this.find(target).pluginIds.push(...selected);});
  }
  groupFor(id){return this.groups.find(g=>g.pluginIds.includes(id));}
  async apply(ids,enabled){
    if(this.busy)throw new Error('다른 전환을 진행 중입니다.');
    if(this.plugin.groupTransaction?.before)throw new Error('이전 전환의 복구를 먼저 완료해야 합니다. 앱을 다시 열어 복구를 시도하세요.');
    const manager=this.plugin.app.plugins;
    const targets=[...new Set(ids)].filter(id=>id!==this.plugin.manifest.id&&manager.manifests[id]);
    const before=Object.fromEntries(targets.map(id=>[id,{enabled:manager.enabledPlugins.has(id),loaded:!!manager.plugins[id]}]));
    const changed=[];this.busy=true;this.error='';this.changed();
    try{
      if(targets.some(id=>before[id].enabled!==enabled)){
        this.plugin.groupTransaction={before,at:new Date().toISOString()};await this.save();
      }
      for(const id of targets){
        if(before[id].enabled===enabled&&before[id].loaded===enabled)continue;
        changed.push(id);await this.setState(id,enabled);
      }
      this.plugin.groupTransaction=null;await this.save();
    }catch(e){
      const failures=[];
      for(const id of changed.reverse())try{await this.setState(id,before[id].enabled);}catch{failures.push(id);}
      if(!failures.length)this.plugin.groupTransaction=null;
      try{await this.save();}catch{failures.push('상태 저장');}
      this.error=String(e.message||e)+(failures.length?' · 복구 미완료: '+failures.join(', '):' · 변경한 항목을 이전 상태로 복구했습니다.');
      throw new Error(this.error);
    }finally{this.busy=false;this.changed();}
  }
  async setState(id,enabled){
    const m=this.plugin.app.plugins;
    if(enabled)await m.enablePluginAndSave(id);else await m.disablePluginAndSave(id);
    if(m.enabledPlugins.has(id)!==enabled||!!m.plugins[id]!==enabled)throw new Error((m.manifests[id]?.name||id)+' 전환 실패');
  }
  async recover(){
    const pending=this.plugin.groupTransaction;if(!pending?.before)return;
    this.busy=true;const failed=[];
    try{for(const [id,state] of Object.entries(pending.before)){if(id===this.plugin.manifest.id||!this.plugin.app.plugins.manifests[id])continue;try{await this.setState(id,!!state.enabled);}catch{failed.push(id);}}
      if(!failed.length){this.plugin.groupTransaction=null;await this.save();}else this.error='이전 전환 복구 미완료: '+failed.join(', ');
    }finally{this.busy=false;this.changed();}
  }
}
module.exports={GroupStore};
