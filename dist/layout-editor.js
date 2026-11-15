import {positiveDimension,CELL_WIDTH_M,CELL_DEPTH_M} from './floor-plan.js';
import {AutoStoreSim,normalizeConfig} from './engine.js';

// Editor analysis always owns a separate simulation. Nothing in this module
// accepts a live warehouse instance, so inspecting a draft cannot reset work.
const freeze=value=>{
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freeze(child);
    Object.freeze(value);
  }
  return value;
};
const canonicalConfigs=new WeakSet(),signatures=new WeakMap();
const canonical=config=>{
  if(config&&canonicalConfigs.has(config))return config;
  const normalized=normalizeConfig(config||{});
  // A layout gesture changes geometry, not catalog membership. Reuse the
  // immutable ID array so an 80-step edit history does not copy 100k IDs per step.
  if(Array.isArray(config?.catalogIds)&&Object.isFrozen(config.catalogIds)&&normalized.catalogIds.length===config.catalogIds.length&&normalized.catalogIds.every((id,index)=>id===config.catalogIds[index]))normalized.catalogIds=config.catalogIds;
  freeze(normalized);canonicalConfigs.add(normalized);return normalized;
};
const signature=config=>{
  if(config&&typeof config==='object'&&Object.isFrozen(config)){
    if(!signatures.has(config))signatures.set(config,JSON.stringify(config));
    return signatures.get(config);
  }
  return JSON.stringify(config);
};
const key=(x,z)=>`${x},${z}`;
const analysisCache=new Map();
const CACHE_LIMIT=8;
const CACHE_SKU_LIMIT=120000;
let cachedSkus=0;

/** Read-only layout analysis using the same geometry and access rules as runtime. */
export function analyzeLayout(input){
  const normalized=canonical(input),id=signature(normalized);
  if(analysisCache.has(id)){
    const cached=analysisCache.get(id);
    analysisCache.delete(id);analysisCache.set(id,cached);
    return cached;
  }
  const sim=new AutoStoreSim(normalized);
  const result=Object.freeze({
    config:normalized,sim,
    stats:Object.freeze(sim.getStats()),
    warnings:Object.freeze(sim.getWarnings()),
    inaccessibleKeys:Object.freeze([...sim.cells.values()].filter(cell=>!cell.isEquipment&&!cell.operational).map(cell=>cell.key)),
  });
  analysisCache.set(id,result);cachedSkus+=sim.catalog.length;
  // Large catalogs otherwise keep eight independent 100k-item warehouses in
  // memory just from moving a port. The active draft/baseline remain owned by
  // LayoutEditor even when an old preview is evicted.
  while(analysisCache.size>CACHE_LIMIT||(cachedSkus>CACHE_SKU_LIMIT&&analysisCache.size>1)){
    const oldest=analysisCache.keys().next().value;cachedSkus-=analysisCache.get(oldest).sim.catalog.length;analysisCache.delete(oldest);
  }
  return result;
}

/** Undoable layout draft; apply/cancel of the real warehouse belongs to the caller. */
export class LayoutEditor {
  constructor(config){
    this.baseConfig=freeze(canonical(config));
    this.baseline=analyzeLayout(this.baseConfig);
    this.analysis=this.baseline;this.config=this.analysis.config;
    this._undo=[];this._redo=[];this._group=null;this.historyLimit=80;
  }
  get dirty(){return signature(this.config)!==signature(this.baseConfig);}
  get inGroup(){return this._group!==null;}
  get canUndo(){return this._undo.length>0||!!(this._group&&signature(this._group)!==signature(this.config));}
  get canRedo(){return this._redo.length>0&&!(this._group&&signature(this._group)!==signature(this.config));}
  _show(config){this.analysis=analyzeLayout(config);this.config=this.analysis.config;}
  _remember(config){this._undo.push(config);if(this._undo.length>this.historyLimit)this._undo.shift();}
  replace(next){
    const normalized=canonical(next);
    if(signature(normalized)===signature(this.config))return false;
    if(!this._group){this._remember(this.config);this._redo=[];}
    this._show(normalized);return true;
  }
  beginGroup(){if(this._group)return false;this._group=this.config;return true;}
  endGroup(){
    if(!this._group)return false;
    const start=this._group;this._group=null;
    if(signature(start)===signature(this.config))return false;
    this._remember(start);this._redo=[];return true;
  }
  cancelGroup(){
    if(!this._group)return false;
    const start=this._group;this._group=null;
    const changed=signature(start)!==signature(this.config);
    if(changed)this._show(start);
    return changed;
  }
  undo(){
    this.endGroup();
    if(!this._undo.length)return false;
    const previous=this._undo.pop();this._redo.push(this.config);this._show(previous);return true;
  }
  redo(){
    this.endGroup();
    if(!this._redo.length)return false;
    const next=this._redo.pop();this._remember(this.config);this._show(next);return true;
  }
  preview(next){return analyzeLayout(next);}
}

function coordinate(cell){
  if(typeof cell==='string'){
    if(!/^\d+,\d+$/.test(cell))return null;
    const [x,z]=cell.split(',').map(Number);return {x,z};
  }
  if(cell&&Number.isInteger(cell.x)&&Number.isInteger(cell.z))return {x:cell.x,z:cell.z};
  return null;
}

/** A whole brush stroke / rectangle is one input, and therefore one undo step. */
export function paintCells(input,cells,mode){
  const config=canonical(input),active=new Set(config.activeCells);
  if(mode!=='add'&&mode!=='erase')return config;
  for(const value of cells||[]){
    const point=coordinate(value);
    if(!point||point.x<0||point.z<0||point.x>=config.width||point.z>=config.depth)continue;
    if(mode==='add')active.add(key(point.x,point.z));else active.delete(key(point.x,point.z));
  }
  return canonical({...config,activeCells:[...active],ports:config.ports.filter(port=>active.has(key(port.x,port.z)))});
}

export function resizeLayout(input,width,depth){
  const config=canonical(input);
  const dimension=positiveDimension;
  const nextWidth=dimension(width,config.width),nextDepth=dimension(depth,config.depth);
  const cells=new Set(config.activeCells.filter(value=>{const [x,z]=value.split(',').map(Number);return x<nextWidth&&z<nextDepth;}));
  // Enlarging the floor creates empty sites; placement is a separate gesture.
  return canonical({...config,width:nextWidth,depth:nextDepth,floorWidthM:nextWidth*CELL_WIDTH_M,floorDepthM:nextDepth*CELL_DEPTH_M,activeCells:[...cells],ports:config.ports.filter(port=>port.x<nextWidth&&port.z<nextDepth)});
}

// Match the engine's straight outward operator-access test. Snapping is local:
// a pointer deep inside the warehouse never jumps to a distant outside edge.
function boundaryPoint(config,x,z){
  const active=new Set(config.activeCells);
  const outward=(px,pz)=>[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dz])=>{
    let ax=px+dx,az=pz+dz;
    while(ax>=0&&az>=0&&ax<config.width&&az<config.depth){if(active.has(key(ax,az)))return false;ax+=dx;az+=dz;}
    return true;
  });
  if(active.has(key(x,z))&&outward(x,z))return {x,z};
  const candidates=config.activeCells.map(value=>coordinate(value)).filter(point=>Math.hypot(point.x-x,point.z-z)<=1.01&&outward(point.x,point.z));
  candidates.sort((a,b)=>Math.hypot(a.x-x,a.z-z)-Math.hypot(b.x-x,b.z-z)||a.z-b.z||a.x-b.x);
  return candidates[0]||{x,z};
}

function nextPortId(ports){let count=1;while(ports.some(port=>port.id===`P${count}`))count++;return `P${count}`;}

/**
 * `port` is a getPortVisuals() item, including the engine-calculated layout.
 * Red candidates cannot be committed. Amber candidates remain valid design
 * drafts (for example a one-layer warehouse), even when operation is blocked.
 */
export function makePortCandidate(input,{x,z,type='buffer3',portId=null,snap=true}={}){
  const base=canonical(input),baseline=analyzeLayout(base);
  const existing=portId?base.ports.find(port=>port.id===portId):null;
  const raw={x:Math.round(Number(x)),z:Math.round(Number(z))};
  const placement=Number.isFinite(raw.x)&&Number.isFinite(raw.z)?(snap?boundaryPoint(base,raw.x,raw.z):raw):{x:-1,z:-1};
  const candidate={id:existing?.id||nextPortId(base.ports),x:placement.x,z:placement.z,type:existing?.type||(type==='single'?'single':'buffer3')};
  const outside=placement.x<0||placement.z<0||placement.x>=base.width||placement.z>=base.depth;
  let hardReason=portId&&!existing?'이동할 포트를 찾을 수 없습니다.':outside?'그리드 안의 셀을 선택하세요.':!base.activeCells.includes(key(placement.x,placement.z))?'포트를 놓을 그리드 셀이 필요합니다.':!existing&&base.ports.length>=8?'포트는 최대 8개까지 배치할 수 있습니다.':'';
  const occupied=base.ports.find(port=>port.id!==existing?.id&&port.x===placement.x&&port.z===placement.z);
  if(occupied)hardReason=`${occupied.id} 포트가 있는 위치입니다.`;
  const next={...base,ports:[...base.ports.filter(port=>port.id!==existing?.id),candidate]};
  let analysis=hardReason?baseline:analyzeLayout(next);
  let port=analysis.sim.getPortVisuals().find(port=>port.id===candidate.id&&port.x===placement.x&&port.z===placement.z)||null;
  // A collision still gets the real station shape for the red ghost, without
  // pretending that an invalid candidate changed the draft's capacity.
  if(hardReason&&!outside){
    const ghost=analyzeLayout({...base,activeCells:[...new Set([...base.activeCells,key(placement.x,placement.z)])],ports:[candidate]});
    port=ghost.sim.getPortVisuals().find(port=>port.id===candidate.id)||null;
  }
  if(!hardReason&&(!port||/겹/.test(port.operationalReason||'')))hardReason=port?.operationalReason||'포트를 배치할 수 없는 위치입니다.';
  let reason=hardReason||port?.operationalReason||'';
  if(!reason&&port){
    const shafts=new Set(port.layout.shafts.map(shaft=>shaft.key));
    const accessible=analysis.sim.robots.some(robot=>robot.available&&robot.operationalPortKeys?.some(value=>shafts.has(value)));
    if(!accessible)reason='2칸 로봇이 접근할 수 있는 경로를 확보해 주세요.';
  }
  const status=hardReason?'invalid':reason?'warning':'valid';
  return {config:analysis.config,analysis,port,placement,status,reason:reason||'배치 가능',canPlace:!hardReason,snapped:placement.x!==raw.x||placement.z!==raw.z};
}

export function compareLayouts(before,after){
  const a=before?.sim&&before?.stats?before:analyzeLayout(before),b=after?.sim&&after?.stats?after:analyzeLayout(after);
  const previous=new Map(a.sim.ports.map(port=>[port.id,port])),current=new Map(b.sim.ports.map(port=>[port.id,port]));
  const removedPortIds=[...previous.keys()].filter(id=>!current.has(id));
  const affectedPortIds=new Set(removedPortIds);
  for(const port of b.sim.ports){
    const old=previous.get(port.id);
    if(!old||old.x!==port.x||old.z!==port.z||old.type!==port.type||old.operational!==port.operational||old.operationalReason!==port.operationalReason||signature(old.intakeKeys)!==signature(port.intakeKeys))affectedPortIds.add(port.id);
  }
  const inaccessibleKeys=b.inaccessibleKeys.filter(value=>!a.sim.cells.has(value)||a.sim.cells.get(value).operational);
  return {
    capacityDelta:b.stats.capacitySkus-a.stats.capacitySkus,
    cellDelta:b.stats.cellCount-a.stats.cellCount,
    binDelta:b.stats.usableBinCapacity-a.stats.usableBinCapacity,
    portDelta:b.stats.portCount-a.stats.portCount,
    unavailableSkuDelta:(b.stats.assignedSkuCount-b.stats.operationalSkuCount)-(a.stats.assignedSkuCount-a.stats.operationalSkuCount),
    unassignedSkuDelta:b.stats.unassignedSkuCount-a.stats.unassignedSkuCount,
    operationalSkuDelta:b.stats.operationalSkuCount-a.stats.operationalSkuCount,
    affectedPortIds:[...affectedPortIds],removedPortIds,inaccessibleKeys,
    allInaccessibleKeys:[...b.inaccessibleKeys],
    removedKeys:[...a.sim.cells.keys()].filter(value=>!b.sim.cells.has(value)),
    addedKeys:[...b.sim.cells.keys()].filter(value=>!a.sim.cells.has(value)),
  };
}
