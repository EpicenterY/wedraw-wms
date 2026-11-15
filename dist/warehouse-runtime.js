import {RustWarehouse} from './rust-core.js';

// Preserve references held by views, scene tracking and event subscribers.
export function reconcile(target,source){
  if(Array.isArray(source)){
    const old=Array.isArray(target)?target:[],byId=new Map(old.filter(v=>v&&typeof v==='object').map(v=>[v.id??v.requestId,v]));
    const next=source.map((v,i)=>v&&typeof v==='object'?reconcile((v.id??v.requestId)!=null?byId.get(v.id??v.requestId):old[i],v):v);
    old.splice(0,old.length,...next);return old;
  }
  if(source&&typeof source==='object'){
    const value=target&&typeof target==='object'&&!Array.isArray(target)?target:{};
    for(const key of Object.keys(value))if(!Object.hasOwn(source,key))delete value[key];
    for(const [key,item]of Object.entries(source))value[key]=reconcile(value[key],item);
    return value;
  }
  return source;
}
export function initializeWarehouse(sim){
  const runtime=new RustWarehouse(),map=values=>Object.fromEntries(values.map(v=>[v.id??v.key,v]));
  runtime.call('init',{config:sim.config,levels:sim.levels,skus:map(sim.catalog),bins:Object.fromEntries(sim.bins),cells:Object.fromEntries(sim.cells),orders:{},ports:map(sim.ports),metrics:sim.metrics,
    components:sim.components.map(c=>({...c,ports:c.ports.map(p=>p.id)})),demandWeights:Object.fromEntries(sim.demandWeights),optimizationPlan:null,optimizedBins:[],deletedInitialQty:0,deletedCurrentQty:0,deletedSkuCount:0});
  sim._runtime=runtime;sim._runtimeContextDirty=true;
}
export function command(sim,op,args={}){
  const signature=`${sim.running}:${sim.config.cooperativeDigging}:${sim.config.idleOptimization}:${sim.config.orderPrefetch}:${sim.config.pickingSeconds}:${JSON.stringify(sim.config.strategies)}`;
  let context;
  if(sim._runtimeContextDirty||sim._runtimeContextSignature!==signature){
    context={orderPrefetch:sim.config.orderPrefetch,pickingSeconds:sim.config.pickingSeconds,strategies:sim.config.strategies,running:sim.running,cooperativeDigging:sim.config.cooperativeDigging,idleOptimization:sim.config.idleOptimization,
      robots:sim.robots.map(r=>({id:r.id,available:r.available,serviceKeys:[...(r.serviceKeys||[])],operationalPortKeys:r.operationalPortKeys||[]}))};
    sim._runtimeContextDirty=false;sim._runtimeContextSignature=signature;
  }
  const {value,delta}=sim._runtime.call(op,args,sim.time,context);
  for(const id of delta.removedSkus){sim.skuMap.delete(id);}if(delta.removedSkus.length)sim.catalog=sim.catalog.filter(s=>sim.skuMap.has(s.id));
  for(const [id,sku]of Object.entries(delta.skus)){if(!sim.skuMap.has(id)){sim.skuMap.set(id,sku);sim.catalog.push(sku);}else reconcile(sim.skuMap.get(id),sku);}
  for(const kind of ['bins','cells'])for(const [id,item]of Object.entries(delta[kind])){const old=sim[kind].get(id);sim[kind].set(id,reconcile(old,item));}
  for(const [id,item]of Object.entries(delta.orders)){
    let old=sim.orders.find(o=>o.id===id)??sim.optimizationPlan?.order;
    if(old?.id!==id)old=null;
    if(old)reconcile(old,item);else if(!id.startsWith('OPT'))sim.orders.push(item);
  }
  for(const event of delta.notifications)if(event.kind==='rotationComplete'){const p=sim.ports.find(p=>p.id===event.portId);if(p?.rotation)reconcile(p.rotation,event.rotation);}
  for(const [id,item]of Object.entries(delta.ports))reconcile(sim.ports.find(p=>p.id===id),item);
  for(const [id,item]of Object.entries(delta.robots))Object.assign(sim.robots.find(r=>r.id===id),item);
  for(const [key,item]of Object.entries(delta.meta)){
    if(key==='locks'||key==='binClaims'){sim[key].clear();for(const [k,v]of Object.entries(item))sim[key].set(k,v);}
    else if(key==='componentAllocations')item.forEach((n,i)=>sim.components[i].allocated=n);
    else if(key==='clearOptimization'){sim.optimizationPlan=null;sim._hasOptimizationWork=false;for(const b of sim.bins.values())if(!b.skuIds.length)sim.demandWeights.delete(b.id);}
    else if(key==='optimizedBins')sim.optimizedBins=new Set(item);
    else if(key==='optimizationPlan')sim.optimizationPlan=item?reconcile(sim.optimizationPlan,item):null;
    else if(key==='orderNumber')sim._orderNumber=item;
    else if(key==='config'||key==='metrics')reconcile(sim[key],item);
    else sim[key]=item;
  }
  sim.revision+=delta.revisionDelta;if(delta.lastProgress)sim._lastProgressTime=sim.time;
  for(const entry of delta.logs)sim.log(entry.kind,entry.title,entry.detail);
  for(const event of delta.notifications){if(event.kind==='startPicking'){const p=sim.ports.find(p=>p.id===event.portId);sim._replayingRustEvent=true;try{sim._startPicking(p,p.entries.find(e=>e.requestId===event.requestId));}finally{sim._replayingRustEvent=false;}}}
  return value;
}
