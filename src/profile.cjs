const SYSTEM = new Set(['(idle)', '(program)', '(root)', '(garbage collector)']);

function pluginId(url, ids) {
  if (typeof url !== 'string' || !url.startsWith('plugin:')) return null;
  const value = url.slice(7);
  // Obsidian sourceURL is plugin:<manifest id>, sometimes followed by a query.
  return ids.find(id => value === id || value.startsWith(id+'?') || value.startsWith(id+'/')) || null;
}

function emptyTotals() { return { durationMs: 0, pluginMs: 0, coreMs: 0, idleMs: 0, unknownMs: 0, samples: 0, segments: 0, plugins: {} }; }

function summarize(profile, catalog, scriptMap = {}) {
  const out = emptyTotals();
  const nodes = new Map(profile.nodes.map(n => [n.id,n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const child of n.children || []) parent.set(child,n.id);
  const ids = catalog.map(p=>p.id).sort((a,b)=>b.length-a.length);
  const resolved = new Map();
  function owner(id) {
    if (resolved.has(id)) return resolved.get(id);
    let n = nodes.get(id), seen = new Set();
    while(n && !seen.has(n.id)) {
      seen.add(n.id);
      const frame=n.callFrame;
      if (SYSTEM.has(frame.functionName)) break;
      const url=frame.url || scriptMap[String(frame.scriptId)] || '';
      const found=pluginId(url,ids);
      if(found) { const answer={id:found,frame,url};resolved.set(id,answer);return answer; }
      n=nodes.get(parent.get(n.id));
    }
    resolved.set(id,null);return null;
  }
  out.durationMs=Math.max(0,(profile.endTime-profile.startTime)/1000);
  let remaining=out.durationMs;
  for(let i=0;i<(profile.samples||[]).length;i++) {
    const delta=profile.timeDeltas?.[i];
    if(!Number.isFinite(delta)||delta<0) continue;
    const ms=Math.min(delta/1000,remaining);remaining-=ms;out.samples++;
    const node=nodes.get(profile.samples[i]);
    if(!node){out.unknownMs+=ms;continue;}
    const frame=node.callFrame;
    if(frame.functionName==='(idle)'){out.idleMs+=ms;continue;}
    const found=owner(node.id);
    if(found) {
      const p=out.plugins[found.id] ||= {ms:0,samples:0,functions:{}};
      p.ms+=ms;p.samples++;out.pluginMs+=ms;
      const f=found.frame;
      const key=JSON.stringify([f.functionName||'(이름 없는 함수)',found.url,f.lineNumber,f.columnNumber]);
      const fun=p.functions[key] ||= {name:f.functionName||'(이름 없는 함수)',url:found.url,line:(f.lineNumber??-1)+1,column:(f.columnNumber??-1)+1,ms:0,samples:0};
      fun.ms+=ms;fun.samples++;
    } else if(SYSTEM.has(frame.functionName) || (frame.url && !frame.url.startsWith('plugin:'))) {
      out.coreMs+=ms;
    } else {out.unknownMs+=ms;}
  }
  // Unsampled time remains explicitly unassigned, never billed to a plugin.
  out.unknownMs+=remaining;out.segments=1;
  return out;
}

function merge(total, piece) {
  for(const key of ['durationMs','pluginMs','coreMs','idleMs','unknownMs','samples','segments']) total[key]+=piece[key];
  for(const [id,group] of Object.entries(piece.plugins)) {
    const p=total.plugins[id] ||= {ms:0,samples:0,functions:{}};
    p.ms+=group.ms;p.samples+=group.samples;
    for(const [key,fn] of Object.entries(group.functions)) {
      const f=p.functions[key] ||= {...fn,ms:0,samples:0};f.ms+=fn.ms;f.samples+=fn.samples;
    }
    // Bound retained summaries even during long sessions.
    const entries=Object.entries(p.functions).sort((a,b)=>b[1].ms-a[1].ms);
    if(entries.length>200) {
      const dropped=entries.slice(199);const other={name:'그 밖의 함수',url:'',line:0,column:0,ms:0,samples:0};
      for(const [,fn] of dropped){other.ms+=fn.ms;other.samples+=fn.samples;}
      p.functions=Object.fromEntries(entries.slice(0,199));
      const prior=p.functions.__other;if(prior){other.ms+=prior.ms;other.samples+=prior.samples;}
      p.functions.__other=other;
    }
  }
  return total;
}
module.exports={pluginId,emptyTotals,summarize,merge};
