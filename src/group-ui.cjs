const {Modal,Setting,Menu,Notice,PluginSettingTab}=require('obsidian');
const {selectRange,installWindow}=require('./group-window.cjs');
const run=async fn=>{try{await fn();}catch(e){new Notice(String(e.message||e));}};
function action(parent,text,fn,cls=''){const b=parent.createEl('button',{text,cls});b.onclick=()=>run(fn);return b;}

class GroupNameModal extends Modal{
  constructor(plugin,group=null){super(plugin.app);this.plugin=plugin;this.group=group;}
  onOpen(){this.titleEl.setText(this.group?'그룹 이름 변경':'그룹 만들기');const setting=new Setting(this.contentEl).setName('그룹 이름');let name=this.group?.name||'';setting.addText(t=>{t.setValue(name).onChange(v=>name=v);this.input=t.inputEl;});const footer=this.contentEl.createDiv({cls:'pm-group-actions'});action(footer,'취소',()=>this.close());action(footer,'저장',async()=>{const store=this.plugin.groupStore;if(this.group)await store.rename(this.group.id,name);else{const id=await store.create(name);for(const modal of this.plugin.groupModals)modal.selectedGroup=id;}this.close();this.plugin.groupChanged();},'mod-cta');this.input.focus();this.input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();footer.lastElementChild.click();}});}
}
class DeleteGroupModal extends Modal{
  constructor(plugin,group){super(plugin.app);this.plugin=plugin;this.group=group;}
  onOpen(){this.titleEl.setText('그룹 삭제');this.contentEl.createEl('p',{text:'“'+this.group.name+'” 그룹을 삭제합니다. 플러그인은 삭제하거나 끄지 않습니다. 소속을 해제하고 현재 상태에 따라 ‘켜진 플러그인’ 또는 ‘꺼진 플러그인’에 표시합니다.'});const footer=this.contentEl.createDiv({cls:'pm-group-actions'});action(footer,'취소',()=>this.close());action(footer,'그룹 삭제',async()=>{await this.plugin.groupStore.remove(this.group.id);for(const modal of this.plugin.groupModals)if(modal.selectedGroup===this.group.id)modal.selectedGroup='none';this.plugin.groupChanged();this.close();},'mod-warning');}
}
class GroupPickerModal extends Modal{
  constructor(owner){super(owner.app);this.owner=owner;this.ids=[...owner.checked];}
  onOpen(){this.titleEl.setText('그룹에 추가');this.modalEl.addClass('pm-group-picker');const search=this.contentEl.createEl('input',{type:'search',placeholder:'그룹 검색…',attr:{'aria-label':'추가할 그룹 검색'}}),list=this.contentEl.createDiv({cls:'pm-group-picker-list'});search.style.width='100%';const render=()=>{list.empty();const groups=this.owner.plugin.groupStore.groups.filter(g=>g.name.toLowerCase().includes(search.value.toLowerCase()));for(const g of groups)action(list,g.name,async()=>{await this.owner.plugin.groupStore.assign(this.ids,g.id);this.owner.checked.clear();this.owner.anchor=null;this.owner.render();this.close();},'pm-picker-option');if(!groups.length)list.createDiv({text:'일치하는 그룹이 없습니다.',cls:'pm-group-empty'});};search.oninput=render;search.onkeydown=e=>{if(e.key==='Enter')list.querySelector('button')?.click();};render();search.focus();}
}
class GroupsModal extends Modal{
  constructor(plugin){super(plugin.app);this.plugin=plugin;this.selectedGroup='none';this.checked=new Set();this.query='';this.groupQuery='';this.editing=false;this.anchor=null;this.sideWidth=plugin.groupWindow?.side||220;}
  onOpen(){this.modalEl.addClass('pm-groups-modal');this.titleEl.setText('플러그인 관리');this.plugin.groupModals.add(this);this.render();this.disposeWindow=installWindow(this);}
  onClose(){this.clearDrag();this.disposeWindow?.();this.plugin.groupModals.delete(this);}
  clearDrag(){this.dragSession=null;this.groupDragSession=null;this.dragBadge?.remove();this.dragBadge=null;this.modalEl.querySelectorAll('.pm-drop-target,.pm-plugin-dragging,.pm-group-order-dragging,.pm-group-insert-before,.pm-group-insert-after').forEach(el=>el.classList.remove('pm-drop-target','pm-plugin-dragging','pm-group-order-dragging','pm-group-insert-before','pm-group-insert-after'));}
  prepareGroupDrag(block,group){
    block.draggable=true;block.dataset.pmGroupOrderId=group.id;
    let blocked=false;block.onpointerdown=e=>{blocked=!!e.target.closest('.pm-group-nav-actions,input,a');};
    block.ondragstart=e=>{
      if(blocked||this.plugin.groupStore.busy){e.preventDefault();return;}
      this.clearDrag();this.groupDragSession={id:group.id,token:globalThis.crypto.randomUUID()};
      e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('application/x-pm-group-order',this.groupDragSession.token);block.addClass('pm-group-order-dragging');
    };
    const accepts=e=>!this.plugin.groupStore.busy&&this.groupDragSession&&Array.from(e.dataTransfer?.types||[]).includes('application/x-pm-group-order');
    const clearMarks=()=>this.modalEl.querySelectorAll('.pm-group-insert-before,.pm-group-insert-after').forEach(el=>el.classList.remove('pm-group-insert-before','pm-group-insert-after'));
    const after=e=>e.clientY>block.getBoundingClientRect().top+block.getBoundingClientRect().height/2;
    block.addEventListener('dragover',e=>{
      if(!accepts(e))return;clearMarks();if(this.groupDragSession.id===group.id)return;
      e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';block.addClass(after(e)?'pm-group-insert-after':'pm-group-insert-before');
      const side=block.closest('.pm-group-sidebar'),rect=side.getBoundingClientRect();if(e.clientY<rect.top+32)side.scrollTop-=12;else if(e.clientY>rect.bottom-32)side.scrollTop+=12;
    });
    block.addEventListener('dragleave',e=>{if(!block.contains(e.relatedTarget))block.classList.remove('pm-group-insert-before','pm-group-insert-after');});
    block.addEventListener('drop',e=>{
      if(!accepts(e)||e.dataTransfer.getData('application/x-pm-group-order')!==this.groupDragSession.token)return;
      e.preventDefault();e.stopPropagation();const id=this.groupDragSession.id,below=after(e);this.clearDrag();run(()=>this.plugin.groupStore.moveGroup(id,group.id,below));
    });
    block.ondragend=()=>this.clearDrag();
  }
  prepareDrop(block,target){
    block.dataset.pmGroupTarget=target||'none';
    const accepts=e=>this.editing&&!this.plugin.groupStore.busy&&this.dragSession&&Array.from(e.dataTransfer?.types||[]).includes('application/x-pm-plugin-selection');
    block.ondragover=e=>{if(!accepts(e))return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='move';block.addClass('pm-drop-target');};
    block.ondragleave=e=>{if(!block.contains(e.relatedTarget))block.removeClass('pm-drop-target');};
    block.ondrop=e=>{
      if(!accepts(e)||e.dataTransfer.getData('application/x-pm-plugin-selection')!==this.dragSession.token)return;
      e.preventDefault();e.stopPropagation();const ids=[...this.dragSession.ids];this.clearDrag();
      run(async()=>{await this.plugin.groupStore.assign(ids,target);this.checked.clear();this.anchor=null;this.render();});
    };
  }
  prepareDrag(row,id){
    row.draggable=true;
    let blocked=false;row.onpointerdown=e=>{blocked=!!e.target.closest('input,button,a,.checkbox-container,.extra-setting-button');};
    row.ondragstart=e=>{
      if(blocked||!this.editing||this.plugin.groupStore.busy){e.preventDefault();return;}
      this.clearDrag();const ids=this.checked.has(id)?[...this.checked]:[id];
      this.dragSession={ids,token:globalThis.crypto.randomUUID()};
      e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('application/x-pm-plugin-selection',this.dragSession.token);
      this.dragBadge=this.modalEl.createDiv({cls:'pm-plugin-drag-badge',text:ids.length+'개 플러그인 이동'});e.dataTransfer.setDragImage(this.dragBadge,12,12);
      for(const el of this.modalEl.querySelectorAll('.pm-group-plugin-row'))if(ids.includes(el.dataset.pmPluginId))el.addClass('pm-plugin-dragging');
    };
    row.ondragend=()=>this.clearDrag();
  }
  render(){
    const oldScroll=this.contentEl.querySelector('.pm-group-list')?.scrollTop||0,oldSideScroll=this.contentEl.querySelector('.pm-group-sidebar')?.scrollTop||0;
    const store=this.plugin.groupStore;if(!['none','disabled'].includes(this.selectedGroup)&&!store.groups.some(g=>g.id===this.selectedGroup))this.selectedGroup='none';
    const root=this.contentEl;root.empty();root.addClass('pm-groups-content');const side=root.createDiv({cls:'pm-group-sidebar'});side.style.flexBasis=this.sideWidth+'px';const divider=root.createDiv({cls:'pm-group-divider',attr:{role:'separator','aria-label':'그룹 목록 너비 조절','aria-orientation':'vertical',tabindex:'0'}}),main=root.createDiv({cls:'pm-group-main'});
    divider.onkeydown=e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();this.sideWidth=Math.max(130,Math.min(this.sideWidth+(e.key==='ArrowRight'?10:-10),this.modalEl.clientWidth-300));side.style.flexBasis=this.sideWidth+'px';this.plugin.groupWindow={...(this.plugin.groupWindow||{}),side:this.sideWidth};this.plugin.persist();};
    const manifests=Object.values(this.app.plugins.manifests).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
    const disabledView=this.selectedGroup==='disabled';
    const matchesState=id=>disabledView?store.isVisible('disabled',id):!!store.groupFor(id)||store.isVisible('none',id);
    for(const id of this.checked)if(!this.app.plugins.manifests[id]||!matchesState(id))this.checked.delete(id);
    if(this.anchor&&!matchesState(this.anchor))this.anchor=null;
    side.createEl('h3',{text:'그룹'});
    const groupSearch=side.createEl('input',{type:'search',placeholder:'그룹 검색…',cls:'pm-group-filter',attr:{'aria-label':'그룹 검색'}});groupSearch.value=this.groupQuery;groupSearch.oninput=()=>{this.groupQuery=groupSearch.value;this.render();this.contentEl.querySelector('.pm-group-filter').focus();};
    const choose=(id,name,count,group)=>{
      const block=side.createDiv({cls:'pm-group-nav-item'+(this.selectedGroup===id?' is-selected':'')});
      if(this.editing&&id!=='disabled')this.prepareDrop(block,id==='none'?null:id);
      const b=action(block,group?name:name+' ('+count+')',()=>{this.selectedGroup=id;this.anchor=null;this.render();},'pm-group-select');b.setAttribute('aria-pressed',String(this.selectedGroup===id));
      if(group){const active=group.pluginIds.filter(id=>this.app.plugins.manifests[id]&&this.app.plugins.plugins[id]).length;const counts=b.createSpan({cls:'pm-group-counts',text:'전체 '+count+'개 / '});counts.createSpan({cls:active?'pm-group-active-count':'',text:'켜짐 '+active+'개'});}
      if(group){this.prepareGroupDrag(block,group);b.title='드래그하여 그룹 순서 바꾸기';}
      if(group){const controls=block.createDiv({cls:'pm-group-nav-actions'});groupToggle(controls,this.plugin,group);if(id==='none')return;const more=action(controls,'⋮',()=>{const menu=new Menu();menu.addItem(i=>i.setTitle('이름 변경').setIcon('pencil').onClick(()=>new GroupNameModal(this.plugin,group).open()));menu.addItem(i=>i.setTitle('그룹 삭제').setIcon('trash').onClick(()=>new DeleteGroupModal(this.plugin,group).open()));menu.showAtMouseEvent(this.menuEvent||{clientX:more.getBoundingClientRect().left,clientY:more.getBoundingClientRect().bottom});});more.setAttribute('aria-label',group.name+' 그룹 옵션');}
    };
    choose('none','켜진 플러그인',manifests.filter(m=>store.isVisible('none',m.id)).length);
    choose('disabled','꺼진 플러그인',manifests.filter(m=>store.isVisible('disabled',m.id)).length);
    for(const group of store.groups)if(group.name.toLowerCase().includes(this.groupQuery.toLowerCase()))choose(group.id,group.name,group.pluginIds.filter(id=>this.app.plugins.manifests[id]).length,group);

    action(side,'+ 그룹 만들기',()=>new GroupNameModal(this.plugin).open(),'pm-group-create').disabled=store.busy;
    side.scrollTop=oldSideScroll;
    const search=main.createEl('input',{type:'search',placeholder:'플러그인 검색…',cls:'pm-group-search',attr:{'aria-label':'플러그인 검색'}});search.value=this.query;
    search.oninput=()=>{const position=search.selectionStart;this.query=search.value;this.render();const next=this.contentEl.querySelector('.pm-group-search');next.focus();try{next.setSelectionRange(position,position);}catch{}};
    const toolbar=main.createDiv({cls:'pm-group-toolbar'});
    action(toolbar,this.editing?'완료':'수정',()=>{this.editing=!this.editing;this.checked.clear();this.anchor=null;this.render();},'pm-group-edit').disabled=store.busy;
    if(this.editing){toolbar.createSpan({text:this.checked.size+'개 선택됨',cls:'pm-selection-count'});
      action(toolbar,'그룹에 추가',()=>new GroupPickerModal(this).open(),'mod-cta').disabled=!this.checked.size||store.busy||!store.groups.length;
      if(!['none','disabled'].includes(this.selectedGroup))action(toolbar,'그룹에서 빼기',async()=>{await store.assign([...this.checked].filter(id=>store.groupFor(id)?.id===this.selectedGroup),null);this.checked.clear();this.anchor=null;this.render();}).disabled=!this.checked.size||store.busy;
    }
    if(store.error||this.plugin.saveError)main.createDiv({cls:'pm-group-error',text:store.error||this.plugin.saveError,attr:{role:'alert'}});
    if(store.busy)main.createDiv({text:'플러그인 상태를 변경하고 있습니다…',attr:{role:'status'}});
    const list=main.createDiv({cls:'pm-group-list'});
    const shown=manifests.filter(m=>store.isVisible(this.selectedGroup,m.id)&&[m.name,m.description,m.author].some(v=>String(v||'').toLowerCase().includes(this.query.toLowerCase())));
    for(const m of shown){
      const row=list.createDiv({cls:'pm-group-plugin-row',attr:{'data-pm-plugin-id':m.id}});
      if(this.editing)this.prepareDrag(row,m.id);
      if(this.editing){const check=row.createEl('input',{type:'checkbox',attr:{'aria-label':m.name+' 선택'}});check.checked=this.checked.has(m.id);check.disabled=store.busy;check.onclick=e=>{const selection=selectRange(this.checked,shown.map(x=>x.id),this.anchor,m.id,e.shiftKey,check.checked);this.checked=selection.checked;this.anchor=selection.anchor;this.render();this.contentEl.querySelector('[data-pm-plugin-id="'+m.id+'"]>input')?.focus({preventScroll:true});};}
      const s=new Setting(row).setName(m.name).setDesc(m.description||'');
      s.nameEl.createSpan({cls:'pm-group-metadata',text:' v'+m.version+(m.author?' · 개발자: '+m.author:'')});
      const group=store.groupFor(m.id);s.descEl.createDiv({cls:'pm-group-membership',text:'그룹: '+(group?.name||'없음')});
      s.addExtraButton(b=>b.setIcon('more-vertical').setTooltip(m.name+' 옵션').onClick(()=>this.plugin.openPluginMenu(m,b.extraSettingsEl,this)));
      s.addToggle(t=>{t.setValue(!!this.app.plugins.plugins[m.id]).setDisabled(store.busy||m.id===this.plugin.manifest.id).onChange(enabled=>run(()=>store.apply(this.editing&&this.checked.has(m.id)?[...this.checked]:[m.id],enabled)));if(m.id===this.plugin.manifest.id)t.toggleEl.setAttribute('aria-label','Performance Manager는 항상 켜짐');else t.toggleEl.title=this.editing&&this.checked.has(m.id)?'선택한 '+this.checked.size+'개 플러그인 함께 켜기·끄기':m.name+' 켜기·끄기';});
    }
    if(!shown.length)list.createDiv({cls:'pm-group-empty',text:!this.query&&disabledView?'꺼진 플러그인이 없습니다.':!this.query&&this.selectedGroup==='none'?'그룹에 속하지 않은 켜진 플러그인이 없습니다.':'표시할 플러그인이 없습니다.'});list.scrollTop=oldScroll;
    main.createDiv({cls:'pm-group-note',text:this.editing?'선택한 항목 하나의 스위치로 선택 전체 켜기·끄기 · Shift로 구간 선택 · 왼쪽 그룹으로 드래그하면 소속만 이동':'수정을 누르면 플러그인을 선택하여 그룹 편집과 일괄 켜기·끄기를 할 수 있습니다.'});
  }
}
class ManagerSettingTab extends PluginSettingTab{
  display(){this.containerEl.empty();new Setting(this.containerEl).setName('플러그인 관리').setDesc('플러그인을 관리하고, 그룹으로 묶어 일괄 켜거나 끕니다.').addButton(b=>b.setButtonText('플러그인 관리 열기').setCta().onClick(()=>this.plugin.openGroups()));}
}
function groupToggle(parent,plugin,group){
  const ids=group.pluginIds.filter(id=>plugin.app.plugins.manifests[id]&&id!==plugin.manifest.id),active=ids.filter(id=>!!plugin.app.plugins.plugins[id]).length,on=active>0,mixed=on&&active<ids.length;
  const setting=new Setting(parent).addToggle(t=>{
    t.setValue(on).setDisabled(plugin.groupStore.busy||!ids.length);
    t.toggleEl.setAttribute('aria-label',group.name+' 그룹 켜기·끄기');
    t.toggleEl.title=on?(mixed?'일부 켜짐 ('+active+'/'+ids.length+')':'켜짐')+' · 누르면 그룹 전체 끄기':!ids.length?'전환할 플러그인이 없습니다.':'꺼짐 · 누르면 기억한 조합으로 복원';
    if(mixed)t.toggleEl.addClass('pm-toggle-mixed');
    t.onChange(enabled=>run(async()=>{try{await plugin.groupStore.applyGroup(group.id,enabled);}finally{plugin.groupChanged();}}));
  });setting.settingEl.addClass('pm-group-toggle-setting');
}
module.exports={GroupsModal,GroupNameModal,ManagerSettingTab,run,groupToggle};
