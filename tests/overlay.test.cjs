const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const mod={exports:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../src/overlay.cjs'),'utf8'),{module:mod,require:()=>({setIcon(){}})});
const {fitBox,dragBox,resizeBox}=mod.exports;
test('drag keeps size and clamps the overlay inside the window',()=>{
  const b=dragBox({x:300,y:20,w:260,h:230},-1000,1000,1000,700);
  assert.equal(b.x,8);assert.equal(b.y,462);assert.equal(b.w,260);assert.equal(b.h,230);
});
test('bottom-left resize keeps top-right anchored while increasing width and height',()=>{
  const b=resizeBox({x:500,y:20,w:260,h:230},-80,60,1000,700);
  assert.equal(b.x,420);assert.equal(b.x+b.w,760);assert.equal(b.y,20);assert.equal(b.h,290);
});
test('resize does not invert the overlay or move its right anchor',()=>{
  const b=resizeBox({x:500,y:20,w:260,h:230},1000,-1000,1000,700);
  assert.equal(b.w,160);assert.equal(b.h,95);assert.equal(b.x+b.w,760);
});
test('saved geometry fits a smaller window after restart or resizing',()=>{
  const b=fitBox({x:900,y:600,w:700,h:600},300,200);
  assert.equal(b.w,284);assert.equal(b.h,184);assert.equal(b.x,8);assert.equal(b.y,8);
});

test('one app overlay survives leaf changes and cleans up on unload',()=>{
  const nodes=[];let disconnected=0;
  const node=()=>({style:{},isConnected:true,classList:{toggle(){}},
    createDiv(){const el=node();nodes.push(el);return el;},createEl(){return node();},createSpan(){},
    addEventListener(){},removeEventListener(){},setAttribute(){},remove(){this.isConnected=false;}});
  const body=node();const doc={body,documentElement:{clientWidth:1200,clientHeight:800},
    defaultView:{ResizeObserver:class {observe(){}disconnect(){disconnected++;}}}};
  const plugin={app:{workspace:{containerEl:{ownerDocument:doc}}},overlaySettings:{shown:false,box:{}}};
  const manager=new mod.exports.OverlayManager(plugin);
  manager.sync();const original=manager.item.root;
  for(let i=0;i<10;i++)manager.sync();
  assert.equal(manager.item.root,original);
  assert.equal(original.hidden,true);
  manager.destroy();assert.equal(original.isConnected,false);assert.equal(manager.item,null);assert.equal(disconnected,1);
  manager.sync();assert.notEqual(manager.item.root,original);manager.destroy();
});
