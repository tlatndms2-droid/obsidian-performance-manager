const {groupToggle,run}=require('./group-ui.cjs');
class NativeGroups {
  constructor(plugin){this.plugin=plugin;this.hooks=[];this.frame=null;this.host=null;this.rows=[];}
  hook(owner,key,after,before){
    const original=owner[key];if(typeof original!=='function')return;
    const own=Object.hasOwn(owner,key);const wrapped=function(...args){before?.(...args);const value=original.apply(this,args);if(value?.then)return value.then(result=>{after(...args);return result;},e=>{throw e;});after(...args);return value;};
    owner[key]=wrapped;this.hooks.push(()=>{if(owner[key]===wrapped){if(own)owner[key]=original;else delete owner[key];}});
  }
  install(){
    this.tab=this.plugin.app.setting?.findTabById?.('community-plugins');if(!this.tab)return;
    const schedule=()=>this.schedule();this.hook(this.tab,'display',schedule);this.hook(this.tab,'update',schedule);this.hook(this.tab,'renderInstalledPlugin',schedule);
    this.hook(this.tab,'hide',()=>{this.observer?.disconnect();this.cancelFrame();this.revealedPluginId=null;this.pendingScrollId=null;});
    this.hook(this.plugin.app.setting,'scrollToDefinition',tab=>{if(tab===this.tab&&this.pendingScrollId)this.schedule();},(tab,definition)=>this.prepareReveal(tab,definition));
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
  prepareReveal(tab,definition){
    if(tab!==this.tab)return;
    const row=tab.getElementForDefinition?.(definition)?.closest('[data-plugin-id]');
    if(!row)return;
    // Native settings must scroll only after our final grouping layout exists.
    this.revealedPluginId=row.dataset.pluginId;this.pendingScrollId=null;
    this.cancelFrame();this.decorate();
    const group=row.closest('.pm-native-group');if(group)group.open=true;
    this.pendingScrollId=row.dataset.pluginId;
  }
  schedule(){const win=this.tab?.containerEl?.ownerDocument?.defaultView;if(!win)return;if(this.frame!==null&&this.frameWindow===win)return;this.cancelFrame();this.frameWindow=win;this.frame=win.requestAnimationFrame(()=>{this.frame=null;this.decorate();const id=this.pendingScrollId;this.pendingScrollId=null;if(id){const row=this.rows.find(el=>el.dataset.pluginId===id);if(row?.isConnected){row.scrollIntoView({block:'center'});this.plugin.app.setting.focusSettingItem?.(row);}}});}
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
      const addSection=(id,name,members,group,parent=root,ownMembers=members)=>{
        if(!members.length)return;
        const revealed=members.some(row=>row.dataset.pluginId===this.revealedPluginId);
        const d=parent.createEl('details',{cls:'pm-native-group',attr:{'data-pm-group-id':id}});d.open=!!query||revealed||!store.collapsed[id];
        const summary=d.createEl('summary');summary.createSpan({text:name+' · '+members.length+'개'});
        if(group){const actions=summary.createSpan({cls:'pm-native-group-actions'});actions.onclick=e=>e.stopPropagation();groupToggle(actions,this.plugin,group);}
        const body=d.createDiv({cls:'pm-native-group-body'});for(const row of ownMembers){grouped.add(row.dataset.pluginId);body.appendChild(row);}
        d.ontoggle=()=>{if(!d.isConnected||query)return;if(revealed){if(d.open)return;this.revealedPluginId=null;}const collapsed=!d.open;if(!!store.collapsed[id]!==collapsed){store.collapsed[id]=collapsed;this.plugin.persist();}};
        return body;
      };
      for(const group of store.roots()){
        const body=addSection(group.id,group.name,visibleRows.filter(r=>store.contains(group.id,r.dataset.pluginId)),group,root,visibleRows.filter(r=>group.pluginIds.includes(r.dataset.pluginId)));
        if(body)for(const child of store.children(group.id))addSection(child.id,child.name,visibleRows.filter(r=>child.pluginIds.includes(r.dataset.pluginId)),child,body);
      }
      addSection('none','그룹 없음',visibleRows.filter(r=>!grouped.has(r.dataset.pluginId)));
    }finally{
      if(!this.observer)this.observer=new MutationObserver(records=>{if(records.some(r=>r.type==='childList'||r.target.matches?.('[data-plugin-id]')))this.schedule();});
      this.observer.observe(tab.containerEl,{childList:true,subtree:true,attributes:true,attributeFilter:['style','class','hidden']});
    }
  }
  destroy(){this.cancelFrame();this.observer?.disconnect();this.restore();for(const undo of this.hooks.reverse())undo();}
}
module.exports={NativeGroups};
