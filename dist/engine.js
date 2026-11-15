import {REST_GRIPPER_Y,BELT_ANCHOR_Y,getWheelTravelState,getRemainingRobotRoute} from './robot-motion.js';
import {normalizeStrategies,prepareTraffic,dispatchStrategies,portForecast} from './robot-strategies.js';
import {positiveDimension,CELL_WIDTH_M,CELL_DEPTH_M} from './floor-plan.js';
import {initializeWarehouse,command} from './warehouse-runtime.js';
/* wedraw WMS — dimension-based simulation; not an OEM controller or certified digital twin. */
import {getPortFootprint,rectanglesOverlap} from './port-footprint.js';
import {RustNavigator,smoothMotion,smoothVelocity,motionDuration,storageCapacity} from './rust-core.js';
export {smoothMotion,smoothVelocity,motionDuration};
export const keyOf = (x, z) => `${x},${z}`;
export const MAX_SKUS = 100000;
export const MAX_ROBOTS = 30;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const xy = key => key.split(',').map(Number);
const GRID_X=.705,GRID_Z=.480,BIN_X=.649,BIN_Z=.449,WORK_HEIGHT=.96;
// Published bin / SDG dimensions and height limits. A nominal bin height is used
// as the stack pitch; nesting tolerances require a site-specific CAD model.
export function getBinSpec(height=.33){const i=height===.22?0:height===.425?2:1;return {
  outsideLengthM:BIN_X,outsideWidthM:BIN_Z,outsideHeightM:[.22,.33,.425][i],
  insideLengthM:.603,insideWidthM:.403,insideHeightM:[.202,.312,.404][i],
  minimumLevels:[6,4,3][i],maximumLevels:[26,18,14][i],maximumCompartments:[32,32,8][i],
  nominalStackPitchM:[.22,.33,.425][i],maximumLoadKg:30};}
const mulberry32 = seed => () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };

export function createDefaultConfig() {
  const width = 12, depth = 8;
  return {
    width, depth, maxHeightM: 2.64, binHeightM: 0.33, compartments: 4,
    robotCount: 4, skuCount: 1000, seed: 20261114, reserveRatio: 0.18, cooperativeDigging: true,idleOptimization:false,strategies:normalizeStrategies(),
    activeCells: Array.from({length: width * depth}, (_, i) => keyOf(i % width, Math.floor(i / width))),
    ports: [{id: 'P1', x: 0, z: 7, type:'buffer3'}, {id: 'P2', x: 11, z: 0, type:'single'}],
  };
}

const CATEGORIES = [
  {name:'경첩', base:'가구 경첩', variants:['110° 클립형','95° 인셋','155° 광각','유리문용','소프트클로징'], finishes:['니켈','흑니켈','무광'], weight:.065},
  {name:'피스', base:'목재용 피스', variants:['3.5×16 mm','4×20 mm','4×30 mm','4.5×40 mm','5×50 mm'], finishes:['아연','흑착색','스테인리스'], weight:.004},
  {name:'연결철물', base:'가구 연결구', variants:['캠락 Ø15','캠볼트 34 mm','미니픽스','조립 너트','목심 결합형'], finishes:['니켈','아연','블랙'], weight:.021},
  {name:'브래킷', base:'고정 브래킷', variants:['L형 30×30','L형 50×50','코너 보강','상판 고정','벽체 연결'], finishes:['실버','화이트','블랙'], weight:.092},
  {name:'손잡이', base:'가구 손잡이', variants:['64 mm','96 mm','128 mm','160 mm','192 mm'], finishes:['매트 블랙','브러시 실버','샴페인'], weight:.080},
  {name:'서랍레일', base:'소형 서랍레일', variants:['250 mm 좌','250 mm 우','300 mm 좌','300 mm 우','350 mm'], finishes:['아연','블랙','화이트'], weight:.180},
  {name:'선반받침', base:'선반 다보', variants:['Ø5 mm','Ø6 mm','유리 선반용','잠금형','고무 캡형'], finishes:['니켈','블랙','투명'], weight:.012},
  {name:'다리·레벨러', base:'가구 레벨러', variants:['M6×25','M8×30','M8×50','Ø25 받침','Ø35 받침'], finishes:['블랙','그레이','실버'], weight:.070},
  {name:'댐퍼·래치', base:'도어 부속', variants:['푸시오픈','자석 캐치','오일 댐퍼','롤러 래치','충격 완충'], finishes:['화이트','그레이','블랙'], weight:.039},
  {name:'캡·마감재', base:'마감 부속', variants:['Ø5 홀캡','Ø8 홀캡','Ø15 캠캡','볼트 커버','모서리 캡'], finishes:['화이트','오크','블랙'], weight:.006},
];

const skuIdOf=number=>`HW-${String(number).padStart(4,'0')}`;
const skuNumberOf=id=>typeof id==='string'&&/^HW-\d+$/.test(id)?Number(id.slice(3)):NaN;
function makeSku(number,seed){
    const i=number-1;
    // The original catalog consumes two random values per SKU. Jump directly
    // to that SKU's state so sparse, monotonically increasing IDs retain their
    // deterministic product data without iterating through deleted IDs.
    const rng=mulberry32((Number(seed)|0)+Math.imul(i,0xDA56F3EA));
    const c = CATEGORIES[i % CATEGORIES.length], variant = Math.floor(i / CATEGORIES.length);
    const spec = `${c.variants[variant % c.variants.length]} · ${c.finishes[Math.floor(variant / c.variants.length) % c.finishes.length]}`;
    const unitWeightKg = +(c.weight * (.94 + rng() * .12)).toFixed(4);
    // At most 1.65 kg per SKU; even 16 compartments remain below 30 kg.
    const qty = Math.max(1, Math.min(20 + Math.floor(rng() * 61), Math.floor(1.65 / unitWeightKg)));
    const id = skuIdOf(number);
    return {id, code:id, name:`${c.base} ${spec} · ${String(variant + 1).padStart(2,'0')}`, category:c.name, spec,
      unit:'개', unitWeightKg, qty, initialQty:qty, binId:null, compartment:null, assigned:false, reachable:false,operational:false};
}
export function makeCatalog(count = 1000, seed = 20261114) {
  return Array.from({length:clamp(Math.floor(Number(count)||0),0,MAX_SKUS)},(_,i)=>makeSku(i+1,seed));
}

export function normalizeConfig(input = {}) {
  const d = createDefaultConfig();
  const width = positiveDimension(input.width,d.width);
  const depth = positiveDimension(input.depth,d.depth);
  const bh = +input.binHeightM || d.binHeightM;
  const binHeightM = [.22,.33,.425].find(v => Math.abs(v-bh)<.0001) || .33;
  const maxHeightM = clamp(+input.maxHeightM || d.maxHeightM, binHeightM, 6);
  const source = input.activeCells === undefined ? Array.from({length:width*depth},(_,i)=>keyOf(i%width,Math.floor(i/width))) : Array.from(input.activeCells);
  const activeCells = [...new Set(source.filter(k => typeof k === 'string' && /^\d+,\d+$/.test(k)).filter(k => {const [x,z]=xy(k);return x<width&&z<depth;}))];
  const active = new Set(activeCells), seen = new Set();
  const portIds = new Set();
  const ports = (Array.isArray(input.ports) ? input.ports : d.ports).filter(p => {
    const k=keyOf(+p.x,+p.z); if(!Number.isInteger(+p.x)||!Number.isInteger(+p.z)||!active.has(k)||seen.has(k)) return false;
    seen.add(k);return true;
  }).slice(0,8).map((p,i)=>{let id=String(p.id||`P${i+1}`);let suffix=i+1;while(portIds.has(id))id=`P${++suffix}`;portIds.add(id);return{id,x:+p.x,z:+p.z,type:p.type==='buffer3'?'buffer3':'single'};});
  const requestedCount=Number.isFinite(Number(input.skuCount))?clamp(Math.floor(Number(input.skuCount)),0,MAX_SKUS):d.skuCount;
  // Explicit membership is authoritative, including an empty catalog. Legacy
  // files without catalogIds continue to create HW-0001 through skuCount.
  const catalogIds=[],catalogSeen=new Set();let maxSkuNumber=0;
  if(Array.isArray(input.catalogIds)){
    for(const id of input.catalogIds){
      const number=skuNumberOf(id);
      if(!Number.isSafeInteger(number)||number<=0||number>=Number.MAX_SAFE_INTEGER||catalogSeen.has(number))continue;
      catalogSeen.add(number);catalogIds.push(skuIdOf(number));maxSkuNumber=Math.max(maxSkuNumber,number);
      if(catalogIds.length===MAX_SKUS)break;
    }
  }else for(let number=1;number<=requestedCount;number++)catalogIds.push(skuIdOf(number));
  if(!Array.isArray(input.catalogIds))maxSkuNumber=requestedCount;
  const requestedNext=Number(input.nextSkuNumber);
  const nextSkuNumber=Math.max(maxSkuNumber+1,Number.isSafeInteger(requestedNext)&&requestedNext>0?requestedNext:1);
  return {width,depth,floorWidthM:Number.isFinite(input.floorWidthM)&&input.floorWidthM>=width*GRID_X&&input.floorWidthM<(width+1)*GRID_X?input.floorWidthM:width*GRID_X,floorDepthM:Number.isFinite(input.floorDepthM)&&input.floorDepthM>=depth*GRID_Z&&input.floorDepthM<(depth+1)*GRID_Z?input.floorDepthM:depth*GRID_Z,maxHeightM,binHeightM,ports,activeCells,cooperativeDigging:input.cooperativeDigging!==false,idleOptimization:input.idleOptimization===true,strategies:normalizeStrategies(input.strategies),orderPrefetch:input.orderPrefetch===true,pickingSeconds:input.pickingSeconds!=null&&Number.isFinite(Number(input.pickingSeconds))?clamp(Number(input.pickingSeconds),.5,60):null,
    compartments:Math.min([1,4,8,16].includes(+input.compartments)?+input.compartments:d.compartments,getBinSpec(binHeightM).maximumCompartments),
    robotCount:clamp(Math.floor(+input.robotCount||d.robotCount),1,MAX_ROBOTS),
    skuCount:catalogIds.length,catalogIds,nextSkuNumber,
    seed:Number.isFinite(+input.seed)?+input.seed:d.seed,
    reserveRatio:clamp(Number.isFinite(+input.reserveRatio)?+input.reserveRatio:d.reserveRatio,.10,.40),
  };
}

// Motion coordinates are metres. gripperY is the lower contact plane (bin top), binY is its centre.
const PHASE_NAMES={'traffic-wait':'교차 구간 진입 대기','idle':'상부 레일 대기','lower-empty':'그리퍼 하강','grip':'빈 체결','raise-loaded':'빈 인양','move':'상부 레일 운반','lower-loaded':'빈 하강','release':'빈 해제','raise-empty':'그리퍼 복귀','pick':'철물 피킹'};

export class AutoStoreSim {
  constructor(config={}){this.reconfigure(config);}
  reconfigure(input={}) {
    this._runtime?.dispose();this._runtime=null;
    this.config=normalizeConfig(input);
    this._navigator?.dispose();
    this._navigator=new RustNavigator(this.config.width,this.config.depth,this.config.activeCells);
    this.binSpec=getBinSpec(this.config.binHeightM);
    this.levels=Math.min(this.binSpec.maximumLevels,Math.max(1,Math.floor((this.config.maxHeightM+1e-8)/this.config.binHeightM)));
    this.actualHeightM=+(this.levels*this.config.binHeightM).toFixed(3);
    this.cells=new Map(this.config.activeCells.map(k=>{const[x,z]=xy(k);return[k,{key:k,x,z,stack:[],isPort:false,isEquipment:false,facilityPortIds:[],component:-1,reachable:false,operational:false,accessReason:''}];}));
    this.ports=this.config.ports.map(p=>({...p,key:keyOf(p.x,p.z),capacity:p.type==='buffer3'?3:1,status:'idle',binId:null,orderId:null,activeEntryId:null,entries:[],sequence:0,rotation:null,shuttle:null,inletReservation:null,
      aperture:{state:'closed',openness:0,elapsed:0,duration:.8,from:0,to:0},presentation:{state:'hidden',binId:null,pickAllowed:false},settleElapsed:0,
      binY:this.getMotionConfig().portBaseY+this.config.binHeightM/2}));
    for(const p of this.ports)this.cells.get(p.key).isPort=true;
    this._configureStations();
    this.components=[];
    for(const[k,c]of this.cells){if(c.component!==-1)continue;const index=this.components.length,keys=[],q=[k];c.component=index;
      for(let i=0;i<q.length;i++){const n=q[i];keys.push(n);for(const nk of this.neighbors(n)){const nc=this.cells.get(nk);if(nc.component===-1){nc.component=index;q.push(nk);}}}
      const ports=this.ports.filter(p=>keys.includes(p.key));this.components.push({id:index,keys,ports,storageKeys:keys.filter(n=>!this.cells.get(n).isEquipment)});
    }
    this.catalog=this.config.catalogIds.map(id=>makeSku(skuNumberOf(id),this.config.seed));this.skuMap=new Map(this.catalog.map(s=>[s.id,s]));this.bins=new Map();
    this.deletedInitialQty=0;this.deletedCurrentQty=0;this.deletedSkuCount=0;
    this.orders=[];this.logs=[];this.running=false;this.paused=false;this.time=0;this.revision=0;this.locks=new Map();this.binClaims=new Map();this._orderNumber=0;this._jobNumber=0;this._lastProgressTime=0;this._lastDispatchRevision=-1;this.stalled=false;this._rand=mulberry32(this.config.seed+7);
    this.demandWeights=new Map();this.demandSampleSize=0;this._demandSignature='';this.optimizationPlan=null;this.optimizedBins=new Set();this._optimizationNumber=0;this._hasOptimizationWork=false;
    this.metrics={completedOrders:0,pickedUnits:0,relocations:0,travelMeters:0,robotMoves:0,totalOrderSec:0,blockedOrders:0,optimizationMoves:0,emptyTravelMeters:0,portStarvedSec:0,portIdleDemandSec:0,trafficScheduledJobs:0,trafficWaitSec:0};
    this._parkingCache??=new Map();this._requiredParkingCoverage=null;this._requiredOperationalCoverage=null;this._buildRegions();this._placeRobots();this._updateAccess();
    this._requiredParkingCoverage=new Set([...this.cells.values()].filter(c=>c.reachable&&!c.isEquipment).map(c=>c.key));
    this._requiredOperationalCoverage=new Set([...this.cells.values()].filter(c=>c.operational&&!c.isEquipment).map(c=>c.key));this._allocate();
    this.log('info','설정 적용',`${this.catalog.length.toLocaleString()} SKU · ${this.bins.size.toLocaleString()} 빈 · 상부 로봇 ${this.robots.filter(r=>r.available).length}대`);
    return this;
  }
  getMotionConfig(){const h=this.config.binHeightM,H=this.actualHeightM;return {stackBaseY:.015,portBaseY:WORK_HEIGHT-h,workHeightM:WORK_HEIGHT,restGripperY:H+REST_GRIPPER_Y,beltTopY:H+BELT_ANCHOR_Y,beltBottomOffset:.025,binHeightM:h,binPhysical:getBinSpec(h),stackPitchM:h,gridPitchX:GRID_X,gridPitchZ:GRID_Z,railY:H};}
  _configureStations(){
    const bounds=[...this.cells.values()].reduce((b,c)=>({x0:Math.min(b.x0,c.x),x1:Math.max(b.x1,c.x),z0:Math.min(b.z0,c.z),z1:Math.max(b.z1,c.z)}),{x0:Infinity,x1:-Infinity,z0:Infinity,z1:-Infinity});
    for(const p of this.ports){
      const sides=[[(p.x-bounds.x0)*GRID_X,-1,0],[(bounds.x1-p.x)*GRID_X,1,0],[(p.z-bounds.z0)*GRID_Z,0,-1],[(bounds.z1-p.z)*GRID_Z,0,1]].sort((a,b)=>a[0]-b[0]);
      const openSide=([,dx,dz])=>{let x=p.x+dx,z=p.z+dz;while(x>=0&&z>=0&&x<this.config.width&&z<this.config.depth){if(this.cells.has(keyOf(x,z)))return false;x+=dx;z+=dz;}return true;};
      const side=sides.find(openSide)||sides[0],outX=side[1],outZ=side[2];let tanX=-outZ,tanZ=outX,second=null;
      if(p.type==='buffer3')for(const flip of[1,-1]){const tx=tanX*flip,tz=tanZ*flip,k=keyOf(p.x-2*tx,p.z-2*tz),middle=keyOf(p.x-tx,p.z-tz);
        if(this.cells.has(k)&&this.cells.has(middle)){tanX=tx;tanZ=tz;second=k;break;}}
      const span=p.type==='buffer3'?2*(tanX?GRID_X:GRID_Z):0,radiusM=span/Math.sqrt(3),hx=p.x*GRID_X+outX*radiusM/2-tanX*span/2,hz=p.z*GRID_Z+outZ*radiusM/2-tanZ*span/2;
      const wx=hx+outX*radiusM,wz=hz+outZ*radiusM;
      // The published front furniture dimension is separate from the inferred
      // rear mechanism envelope. Keep the full moving-bin envelope in that zone.
      const workOffset=radiusM*1.5,halfDepth=(outX?BIN_X:BIN_Z)/2,frontOffsetM=workOffset+halfDepth+.18,rearOffsetM=frontOffsetM-(p.type==='buffer3'?1.137:.82);
      p.stationLayout={outX,outZ,tanX,tanZ,hubX:hx/GRID_X,hubZ:hz/GRID_Z,workX:wx/GRID_X,workZ:wz/GRID_Z,intakeX:p.x,intakeZ:p.z,radiusM,
        station:{widthM:p.type==='buffer3'?2.114:1.10,depthM:p.type==='buffer3'?1.137:.82,workHeightM:WORK_HEIGHT,frontOffsetM,rearOffsetM,centerX:(p.x*GRID_X+outX*(frontOffsetM+rearOffsetM)/2-tanX*span/2)/GRID_X,centerZ:(p.z*GRID_Z+outZ*(frontOffsetM+rearOffsetM)/2-tanZ*span/2)/GRID_Z,dimensionBasis:p.type==='buffer3'?'published SDG front furniture; rear envelope reconstructed':'generic single access station'},
        modelBasis:'published bin/grid sizes; reconstructed two-rear-transfer kinematics'};
      p.intakeKeys=p.type==='buffer3'?[p.key,second].filter(Boolean):[p.key];
      p.intakeBySlot=p.type==='buffer3'?{1:p.key,2:second}:{0:p.key};
      p.operationalReason=this.levels<this.binSpec.minimumLevels?`${this.config.binHeightM*1000} mm 빈은 출고 설비에 최소 ${this.binSpec.minimumLevels}층이 필요합니다.`:!openSide(side)?'작업자 전면에서 그리드 외부로 연결되는 공간이 없습니다.':p.type==='buffer3'&&!second?'후방 인계 2열과 그 사이 상부 레일이 필요합니다.':'';
      p.operational=!p.operationalReason;p.footprintReservedKeys=[];
      const shafts=p.intakeKeys.map(k=>{const[x,z]=xy(k);return {x:x*GRID_X,z:z*GRID_Z};});
      const origin=[shafts.reduce((sum,p)=>sum+p.x,0)/shafts.length,shafts.reduce((sum,p)=>sum+p.z,0)/shafts.length];
      p.installationBounds=getPortFootprint({type:p.type,outX,outZ,origin,hub:[hx,hz],radius:radiusM,station:p.stationLayout.station,shafts}).rectangles;
      for(const c of this.cells.values()){
        const cellBounds={minX:(c.x-.5)*GRID_X,maxX:(c.x+.5)*GRID_X,minZ:(c.z-.5)*GRID_Z,maxZ:(c.z+.5)*GRID_Z};
        if(p.intakeKeys.includes(c.key)||p.installationBounds.some(r=>rectanglesOverlap(r,cellBounds))){
          c.isEquipment=true;c.facilityPortIds.push(p.id);p.footprintReservedKeys.push(c.key);
        }
      }
    }
    for(let i=0;i<this.ports.length;i++)for(let j=i+1;j<this.ports.length;j++){
      const a=this.ports[i],b=this.ports[j];if(a.footprintReservedKeys.some(k=>b.footprintReservedKeys.includes(k))||a.installationBounds.some(x=>b.installationBounds.some(y=>rectanglesOverlap(x,y)))){
        a.operational=b.operational=false;a.operationalReason=b.operationalReason='포트 설비의 설치·회전 영역이 서로 겹칩니다.';
      }
    }
  }
  footprint(key,sign){const[x,z]=xy(key);return[key,keyOf(x,z+sign)];}
  validPosition(key,sign){return this.footprint(key,sign).every(k=>this.cells.has(k));}
  neighbors(k){const[x,z]=xy(k);return[[x-1,z],[x+1,z],[x,z-1],[x,z+1]].map(([a,b])=>keyOf(a,b)).filter(n=>this.cells.has(n));}
  _reachableNodes(from,sign,blocked=new Set()) {
    return this._navigator.reachable(from,sign,blocked);
  }
  _buildRegions(){this.regions=[];this._motionNodes=new Map();for(const sign of[-1,1]){
    // The rail layout stays fixed until reconfigure. Reuse its exact two-cell
    // anchors and neighbor order across the many live reservation searches.
    const graph=new Map([...this.cells.keys()].filter(k=>this.validPosition(k,sign)).map(k=>[k,{footprint:this.footprint(k,sign),neighbors:[]}]));
    for(const[k,node]of graph)node.neighbors=this.neighbors(k).filter(n=>graph.has(n));this._motionNodes.set(sign,graph);
    const remaining=new Set(graph.keys());
    while(remaining.size){const from=remaining.values().next().value,nodes=this._reachableNodes(from,sign);for(const k of nodes)remaining.delete(k);
      this.regions.push({id:`${sign}:${this.regions.length}`,sign,nodes,ports:this.ports.filter(p=>p.intakeKeys.some(k=>nodes.has(k)))});}}
  }
  _parkingCoverage(robots){
    // Reuse a projected parking proof only within the current dispatch revision.
    const signature=this._planningParking?robots.map(r=>[r.homeKey,r.bodySign,!!r.requiresPort,!!r.requiresOperationalPort].join(':')).join('|'):null;
    const cached=this._planningParking?.get(signature);
    if(cached)return {...cached,reachByRobot:new Map(robots.map((r,i)=>[r,cached.nodes[i]]).filter(([,nodes])=>nodes))};
    const finish=result=>{if(signature!==null)this._planningParking.set(signature,{valid:result.valid,coverage:result.coverage,operationalCoverage:result.operationalCoverage,nodes:robots.map(r=>result.reachByRobot.get(r))});return result;};
    const coverage=new Set(),operationalCoverage=new Set(),reachByRobot=new Map(),occupied=new Set(),footprints=new Map();
    for(const r of robots){const footprint=this._motionNodes.get(r.bodySign)?.get(r.homeKey)?.footprint;if(!footprint)return finish({coverage,operationalCoverage,valid:false,reachByRobot});footprints.set(r,footprint);
      for(const k of footprint){if(occupied.has(k))return finish({coverage,operationalCoverage,valid:false,reachByRobot});occupied.add(k);}}
    for(const r of robots){const blocked=new Set(occupied);for(const k of footprints.get(r))blocked.delete(k);
      const nodes=this._reachableNodes(r.homeKey,r.bodySign,blocked),hasPort=this.ports.some(p=>p.intakeKeys.some(k=>nodes.has(k))),hasOperationalPort=this.ports.some(p=>p.operational&&p.intakeKeys.some(k=>nodes.has(k)));
      reachByRobot.set(r,nodes);if(hasPort)for(const k of nodes)if(!this.cells.get(k).isEquipment){coverage.add(k);if(hasOperationalPort)operationalCoverage.add(k);}
      if(r.requiresPort&&!hasPort||r.requiresOperationalPort&&!hasOperationalPort)return finish({coverage,operationalCoverage,valid:false,reachByRobot});
    }return finish({coverage,operationalCoverage,valid:true,reachByRobot});
  }
  _placeRobots(){
    const signature=JSON.stringify([this.config.width,this.config.depth,this.config.robotCount,this.config.activeCells.slice().sort(),this.config.ports.map(p=>[p.id,p.x,p.z,p.type])]);
    const cached=this._parkingCache.get(signature);if(cached){this._makeParkedRobots(cached);return;}
    const parked=[],occupied=new Set(),portKeys=new Set(this.ports.flatMap(p=>p.intakeKeys));
    for(let index=0;index<this.config.robotCount;index++){
      let best=null,bestScore=-Infinity;
      for(const region of this.regions){
        let candidates=[...region.nodes].filter(k=>this.footprint(k,region.sign).every(f=>!occupied.has(f)));
        const awayFromPort=candidates.filter(k=>this.footprint(k,region.sign).every(f=>!portKeys.has(f)));if(awayFromPort.length)candidates=awayFromPort;
        candidates.sort((a,b)=>{
          const score=k=>{const[x,z]=xy(k),body=keyOf(x,z+region.sign);return(this.validPosition(body,region.sign)?100:0)-Math.min(x,this.config.width-1-x)*3-Math.min(z,this.config.depth-1-z)*.2;};
          return score(b)-score(a);
        });
        // Include distant boundary alternatives, not just adjacent anchors.
        const pool=[...new Set([...candidates.slice(0,12),...candidates.filter((_,i)=>i%Math.max(1,Math.floor(candidates.length/8))===0).slice(0,8)])];
        for(const k of pool){const candidate={homeKey:k,bodySign:region.sign,requiresPort:region.ports.length>0,regionId:region.id};
          const result=this._parkingCoverage([...parked,candidate]);if(!result.valid)continue;
          const[x,z]=xy(k),body=keyOf(x,z+region.sign),distance=parked.length?Math.min(...parked.map(r=>{const[a,b]=xy(r.homeKey);return Math.abs(x-a)+Math.abs(z-b);})):0;
          const score=result.coverage.size*10000+(region.ports.length?100:0)+(this.validPosition(body,region.sign)?50:0)+distance*2-Math.min(x,this.config.width-1-x);
          if(score>bestScore){bestScore=score;best=candidate;}
        }
      }
      if(best){parked.push(best);for(const k of this.footprint(best.homeKey,best.bodySign))occupied.add(k);}
      else parked.push({homeKey:null,bodySign:index%2?1:-1,requiresPort:false,regionId:null,unavailable:true});
      // Remove unavailable entries from the planning collection; expose them below by index.
      if(parked.at(-1).unavailable)break;
    }
    const placed=parked.filter(r=>!r.unavailable);
    if(this._parkingCache.size>=6)this._parkingCache.delete(this._parkingCache.keys().next().value);
    this._parkingCache.set(signature,placed.map(r=>({...r})));this._makeParkedRobots(placed);
  }
  _makeParkedRobots(placed){const rest=this.getMotionConfig().restGripperY;
    this.robots=Array.from({length:this.config.robotCount},(_,i)=>{const p=placed[i],coords=p?xy(p.homeKey):[null,null];return{
      id:`R${String(i+1).padStart(2,'0')}`,index:i,x:coords[0],z:coords[1],position:{x:coords[0],z:coords[1]},homeKey:p?.homeKey??null,
      bodySign:p?.bodySign??(i%2?1:-1),regionId:p?.regionId??null,requiresPort:!!p?.requiresPort,available:!!p,onGrid:!!p,
      status:p?PHASE_NAMES.idle:'미배치 · 2칸 주차 공간 부족',carryingBinId:null,gripperY:rest,speedMps:0,
      progress:0,job:null,currentOperation:null,battery:100,completed:0};});
  }
  _parkingLayout(robot=null,endKey=null){return this.robots.filter(r=>r.available).map(r=>({robot:r,homeKey:r===robot?endKey:r.job?.endKey??keyOf(r.x,r.z),bodySign:r.bodySign,requiresPort:r.requiresPort,requiresOperationalPort:r.requiresOperationalPort}));}
  _updateAccess(){for(const c of this.cells.values()){c.reachable=false;c.operational=false;c.robotIds=[];c.accessReason=this.components[c.component].ports.length?'2칸 로봇 접근 경로 없음':'연결된 포트 없음';}
    // Capability follows the actual idle anchor or an active job's reserved
    // endpoint, never the robot's old home. Transient route locks are checked
    // separately by each planner; they must not turn stock into unreachable stock.
    const layout=this._parkingLayout(),parking=this._parkingCoverage(layout);
    for(const pose of layout){const r=pose.robot,nodes=parking.reachByRobot.get(pose)||new Set();
      r.serviceKeys=nodes;r.portKeys=this.ports.flatMap(p=>p.intakeKeys.filter(k=>nodes.has(k)));r.operationalPortKeys=this.ports.filter(p=>p.operational).flatMap(p=>p.intakeKeys.filter(k=>nodes.has(k)));r.requiresOperationalPort??=r.operationalPortKeys.length>0;
      if(r.portKeys.length)for(const k of nodes){const c=this.cells.get(k);c.reachable=true;if(r.operationalPortKeys.length)c.operational=true;c.accessReason='';c.robotIds.push(r.id);}
    }
      if(this._runtime){this._runtimeContextDirty=true;this._rpc('syncAccess',{cells:[...this.cells.values()].map(c=>({key:c.key,reachable:c.reachable,operational:c.operational,accessReason:c.accessReason,robotIds:c.robotIds}))});}
  }
  _allocate(){const rng=mulberry32(this.config.seed+13);this.rawBinCapacity=0;this.usableBinCapacity=0;
    for(const comp of this.components){
      comp.rawStorageKeys=comp.storageKeys.slice();
      // Reserve columns that no two-cell robot can service with the other
      // robots at their waiting positions. This same set governs additions,
      // digging destinations, returns and optimization for this layout.
      comp.storageKeys=comp.rawStorageKeys.filter(k=>this.cells.get(k).reachable);
      for(const k of comp.rawStorageKeys)this.cells.get(k).storageExcluded=!this.cells.get(k).reachable;
      const raw=comp.rawStorageKeys.length*this.levels,capacity=storageCapacity(comp.storageKeys.length,this.levels,this.config.reserveRatio);
      this.rawBinCapacity+=raw;this.usableBinCapacity+=capacity;
      const order=comp.storageKeys.slice();for(let i=order.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[order[i],order[j]]=[order[j],order[i]];}
      comp.capacity=capacity;comp.allocated=0;comp.allocationOrder=order;
    }
    const comps=this.components.slice().sort((a,b)=>Number(b.ports.length>0)-Number(a.ports.length>0));let skuIndex=0,binNumber=0;
    for(const comp of comps)for(let n=0;n<comp.capacity&&skuIndex<this.catalog.length;n++){
      const valid=comp.allocationOrder.filter(k=>this.cells.get(k).stack.length<this.levels);if(!valid.length)break;
      const k=valid[Math.floor(rng()*valid.length)],c=this.cells.get(k),id=`B${String(++binNumber).padStart(4,'0')}`,skuIds=[];
      for(let j=0;j<this.config.compartments&&skuIndex<this.catalog.length;j++){const sku=this.catalog[skuIndex++];Object.assign(sku,{binId:id,compartment:j+1,assigned:true,reachable:c.reachable,operational:c.operational,accessReason:c.accessReason});skuIds.push(sku.id);}
      this.bins.set(id,{id,skuIds,compartments:this.config.compartments,location:{type:'grid',key:k,x:c.x,z:c.z,level:c.stack.length,y:.015+(c.stack.length+.5)*this.config.binHeightM},weightKg:0});c.stack.push(id);comp.allocated++;
    }this.refreshWeights();
  }
  _blockedFor(robot){if(this._planningBlocks?.has(robot.id))return this._planningBlocks.get(robot.id);const blocked=new Set();for(const[k,owner]of this.locks)if(owner!==robot.id)blocked.add(k);
    for(const other of this.robots)if(other!==robot&&other.available){
      if(other.job){for(const k of other.job.locked)blocked.add(k);
        if(other.job.traffic){
          // Existing timed missions keep their contracts even after switching off.
          for(const w of other.job.traffic.windows)if(w.end>this.time&&(!this.config.strategies.timeReservations||w.end>=1e12))blocked.add(w.key);
        }
      }else for(const k of this.footprint(keyOf(other.x,other.z),other.bodySign))blocked.add(k);
    }this._planningBlocks?.set(robot.id,blocked);return blocked;
  }
  _planningNodes(robot){if(this._planningReach?.has(robot.id))return this._planningReach.get(robot.id);const nodes=this._reachableNodes(keyOf(robot.x,robot.z),robot.bodySign,this._blockedFor(robot));this._planningReach?.set(robot.id,nodes);return nodes;}
  setOrderPrefetch(value){if(this.config.orderPrefetch===!!value)return false;this.config.orderPrefetch=!!value;this._runtimeContextDirty=true;this._lastDispatchRevision=-1;this.revision++;return this.config.orderPrefetch;}
  setPickingSeconds(seconds){const value=Number(seconds);if(!Number.isFinite(value)||value<.5||value>60)throw Error('피킹 시간은 0.5~60초로 입력하세요.');return this._rpc('setPickingSeconds',{seconds:value});}
  setStrategies(value){const next=normalizeStrategies(value);if(JSON.stringify(next)===JSON.stringify(this.config.strategies))return false;
    this.config.strategies=next;this._runtimeContextDirty=true;this._lastDispatchRevision=-1;this.revision++;return true;
  }
  path(from,to,blocked=this.locks,bodySign=-1){
    return this._navigator.path(from,to,blocked,bodySign);
  }
  log(type,title,detail=''){this.logs.unshift({id:`L${this.revision}-${this.logs.length}-${this.time}`,time:this.time,type,title,detail});if(this.logs.length>100)this.logs.pop();}
  reservedQuantity(skuId){return this._rpc('reserved',{skuId});}
  _ensureRuntime(){if(!this._runtime)initializeWarehouse(this);return this._runtime;}
  _rpc(op,args={}){this._ensureRuntime();return command(this,op,args);}
  availableQuantity(skuId){const s=this.skuMap.get(skuId);return s?Math.max(0,s.qty-this.reservedQuantity(skuId)):0;}
  enableIdleOptimization(enabled=true){this.config.idleOptimization=!!enabled;if(!enabled&&this.optimizationPlan)this._rpc('optimizationCancel');this.revision++;return this.config.idleOptimization;}
  setDemandWeights(rows=[],{sampleSize}={}){const weights=new Map();for(const row of rows){const count=Math.max(0,Math.floor(Number(row.orderCount)||0));if(count&&this.bins.has(row.binId))weights.set(row.binId,count);}
    const signature=JSON.stringify([...weights].sort((a,b)=>a[0].localeCompare(b[0])));this.demandSampleSize=Number.isFinite(sampleSize)?Math.max(0,Math.floor(sampleSize)):[...weights.values()].reduce((a,b)=>a+b,0);
    if(signature===this._demandSignature)return;this._demandSignature=signature;this.demandWeights=weights;
    this._hasOptimizationWork=!!this._rpc('optimizationDemand',{weights:Object.fromEntries(weights)});this.revision++;
  }
  _findOptimizationPlan(){return this._rpc('optimizationFind');}
  _dispatchOptimization(){const plan=this._rpc('optimizationNext');this._hasOptimizationWork=!!plan;if(!plan)return;
    const active=this.optimizationPlan,move=active.moves[active.index],robot=this.robots.find(r=>r.id===active.robotId);
    const job=this._buildTransfer(active.order,robot,move.binId,'grid',move.fromKey,'grid',move.toKey,{kind:'optimize'});
    if(job){job.optimizationPlan=active;this._assignJob(robot,job);}
  }
  canAddSkus(){return !this.running&&!this.robots.some(r=>r.job)&&!this.ports.some(p=>p.entries.length||p.shuttle||p.rotation||p.inletReservation);}
  setSkuCount(total){total=Number(total);if(!Number.isInteger(total)||total<0||total>MAX_SKUS)throw new Error('SKU 수는 0개부터 최대 100,000개까지 설정할 수 있습니다.');
    const oldCount=this.catalog.length;if(total===oldCount)return {added:0,removed:0,total,assigned:0,unassigned:0};
    if(total<oldCount)return {...this.removeSkus(this.catalog.slice(total).map(s=>s.id)),added:0};
    const count=total-oldCount,start=this.config.nextSkuNumber;if(!Number.isSafeInteger(start+count))throw new Error('새 SKU 식별 번호의 범위를 초과했습니다.');
    return this._rpc('addSkus',{extra:Array.from({length:count},(_,i)=>makeSku(start+i,this.config.seed)),nextSkuNumber:start+count});
  }
  addSkus(count){count=Number(count);if(!Number.isInteger(count)||count<1)throw new Error('추가할 SKU 수를 양의 정수로 입력해 주세요.');return this.setSkuCount(this.catalog.length+count);}
  removeSkus(ids){return this._rpc('removeSkus',{ids});}
  enqueueSku(skuId,qty=1,metadata={}){const id=this._rpc('enqueue',{skuId,qty:Number(qty),metadata});return this.orders.find(o=>o.id===id)??null;}
  enqueueRandom(count=20){const added=[];for(let i=0;i<clamp(Math.floor(count),1,200);i++){const eligible=this.catalog.filter(s=>s.assigned&&s.reachable&&s.operational&&this.availableQuantity(s.id)>0);if(!eligible.length)break;
      const sku=eligible[Math.floor(this._rand()*eligible.length)];added.push(this.enqueueSku(sku.id,Math.min(this.availableQuantity(sku.id),1+Math.floor(this._rand()*3))));}
    if(!added.length)this.log('warning','작업 생성 불가','예약을 제외하고 출고할 수 있는 배정 재고가 필요합니다.');else this.log('info','출고 요청 생성',`${added.length}건의 더미 출고 요청을 추가했습니다.`);return added;
  }
  start(){if(!this.ports.length){this.log('warning','포트를 배치해 주세요','포트가 없는 그리드에서는 출고를 시작할 수 없습니다.');return false;}
    if(!this.ports.some(p=>p.operational)){this.log('warning','포트 설치 조건 미충족',this.ports[0].operationalReason);return false;}
    if(!this.robots.some(r=>r.available&&r.operationalPortKeys.length)){this.log('warning','2칸 로봇 접근 불가','두 칸을 차지하는 로봇의 주차점과 포트 경로가 필요합니다.');return false;}this.running=true;this.paused=false;this.stalled=false;this._lastProgressTime=this.time;return true;}
  pause(){this.running=false;this.paused=true;}
  reset(){return this.reconfigure(this.config);}
  _transferEnd(robot,dropKey,startKey,blocked,order,options){
    // Every reserved endpoint must leave a recoverable parked arrangement.
    // Checking the projected endpoints of active jobs makes this invariant
    // independent of completion order, while route reservations protect motion.
    const layout=this._parkingLayout(robot,dropKey),own=layout.find(p=>p.robot===robot),required=this._requiredParkingCoverage,operational=this._requiredOperationalCoverage;
    // Solo requests cannot borrow another robot merely because total warehouse
    // coverage is preserved. Keep their bound carrier connected to its target
    // and its own port until that physical request has finished.
    const soloNeeds=this.config.cooperativeDigging?[]:this.orders.filter(o=>this._isPending(o)).map(o=>{
      const id=o.soloRobotId||(o===order?robot.id:null),pose=layout.find(p=>p.robot.id===id),bin=this.bins.get(o.binId),port=o===order&&options.port?options.port:this.ports.find(p=>p.id===o.portId);
      return {pose,key:bin?.location.type==='grid'?bin.location.key:null,port};
    }).filter(v=>v.pose);
    const queuePort=options.queuePort;
    const safe=key=>{own.homeKey=key;const result=this._parkingCoverage(layout);
      if(queuePort&&(!queuePort.intakeKeys.some(k=>result.reachByRobot.get(own)?.has(k))||!layout.some(p=>p!==own&&queuePort.intakeKeys.some(k=>result.reachByRobot.get(p)?.has(k)))||!layout.every(p=>p===own||(p.robot.operationalPortKeys||[]).every(k=>result.reachByRobot.get(p)?.has(k)))))return false;
      return result.valid&&(!required||[...required].every(k=>result.coverage.has(k)))&&(!operational||[...operational].every(k=>result.operationalCoverage.has(k)))&&soloNeeds.every(({pose,key,port})=>{
      const nodes=result.reachByRobot.get(pose);return (!key||nodes.has(key))&&(!port||port.intakeKeys.some(k=>nodes.has(k)));});};
    const sharedIntakes=new Set(this.ports.filter(p=>p.operational&&layout.some(r=>r!==own&&r.robot.operationalPortKeys?.some(k=>p.intakeKeys.includes(k)))).flatMap(p=>p.intakeKeys));
    const clearsPorts=key=>this.footprint(key,robot.bodySign).every(k=>!sharedIntakes.has(k));
    if(queuePort){
      // Queue beside, never over, an intake. Leave the full two-cell approach
      // envelope available to a carrier clearing the station.
      const approaches=new Set(this.ports.filter(p=>p.operational).flatMap(p=>p.intakeKeys.flatMap(k=>layout.flatMap(r=>this.validPosition(k,r.bodySign)?this.footprint(k,r.bodySign):[]))));
      const distance=key=>{const[x,z]=xy(key);return Math.min(...queuePort.intakeKeys.map(k=>{const[a,b]=xy(k);return Math.abs(a-x)*GRID_X+Math.abs(b-z)*GRID_Z;}));};
      const candidates=[...this._reachableNodes(dropKey,robot.bodySign,blocked)].filter(k=>this.footprint(k,robot.bodySign).every(f=>!approaches.has(f))).sort((a,b)=>distance(a)-distance(b));
      for(const key of candidates)if(safe(key))return key;
      return null;
    }
    if(clearsPorts(dropKey)&&safe(dropKey))return dropKey;
    const [x,z]=xy(dropKey),candidates=[...this._reachableNodes(dropKey,robot.bodySign,blocked)].sort((a,b)=>{
      const distance=k=>{const[tx,tz]=xy(k);return Math.abs(tx-x)*GRID_X+Math.abs(tz-z)*GRID_Z;};return distance(a)-distance(b);});
    for(const key of candidates)if(clearsPorts(key)&&safe(key))return key;
    // A cramped layout may have no spare pocket outside an intake. The proven
    // starting arrangement remains a safe fallback, without forcing a home trip.
    if(candidates.includes(dropKey)&&safe(dropKey))return dropKey;
    if(candidates.includes(startKey)&&safe(startKey))return startKey;
    return candidates.find(safe)??null;
  }
  _buildTransfer(order,robot,binId,fromKind,fromKey,toKind,toKey,options={}){
    const b=this.bins.get(binId),blocked=this._blockedFor(robot),sign=robot.bodySign,mc=this.getMotionConfig(),bh=this.config.binHeightM;
    if(!b||!robot.available)return null;
    const fromCell=this.cells.get(fromKey),toCell=this.cells.get(toKey),port=options.port;
    if(fromKind==='robot'&&(b.location.type!=='robot'||b.location.robotId!==robot.id||robot.carryingBinId!==binId))return null;
    if(fromKind==='grid'&&(b.location.type!=='grid'||fromCell?.stack.at(-1)!==binId))return null;
    if(fromKind==='port'&&(b.location.type!=='port'||!port||!port.entries.some(e=>e.binId===binId&&e.atShaft)))return null;
    if(toKind==='grid'&&(!toCell||toCell.isEquipment||toCell.storageExcluded||toCell.stack.length>=this.levels))return null;
    const ops=[],locked=new Set(),startKey=keyOf(robot.x,robot.z);let current=startKey;
    const addMove=(to,purpose,routeBlocked=blocked)=>{const path=this.path(current,to,routeBlocked,sign);if(!path)return false;
      for(const k of path)for(const f of this.footprint(k,sign))locked.add(f);
      if(path.length>1){const segments=[];let start=0;while(start<path.length-1){let end=start+1;const[a,b]=xy(path[start]),[c,d]=xy(path[end]),dx=c-a,dz=d-b;
          while(end+1<path.length){const[x1,z1]=xy(path[end]),[x2,z2]=xy(path[end+1]);if(x2-x1!==dx||z2-z1!==dz)break;end++;}
          const[fX,fZ]=xy(path[start]),[tX,tZ]=xy(path[end]),distance=Math.abs(tX-fX)*.705+Math.abs(tZ-fZ)*.480;
          segments.push({from:{x:fX,z:fZ},to:{x:tX,z:tZ},duration:motionDuration(distance,1.8,2.8),distance,pathStart:start,pathEnd:end});start=end;}
        ops.push({type:'move',phase:'move',path,segments,purpose,duration:segments.reduce((a,v)=>a+v.duration,0),sourceKey:current,targetKey:to});}
      current=to;return true;};
    const hoist=(phase,fromY,toY,extra)=>ops.push({type:'hoist',phase,fromY,toY,duration:motionDuration(toY-fromY),...extra});
    const take=(kind,k,top)=>{const extra={binId,kind,key:k,portId:kind==='port'?port.id:null,sourceKey:k,targetKey:null,relocation:options.kind==='dig'};
      hoist('lower-empty',mc.restGripperY,top,extra);ops.push({type:'grip',phase:'grip',fromY:top,toY:top,duration:.4,...extra});hoist('raise-loaded',top,mc.restGripperY,extra);};
    const drop=(kind,k,top)=>{const extra={binId,kind,key:k,portId:kind==='port'?port.id:null,sourceKey:null,targetKey:k,relocation:options.kind==='dig'};
      hoist('lower-loaded',mc.restGripperY,top,extra);ops.push({type:'release',phase:'release',fromY:top,toY:top,duration:.4,...extra});hoist('raise-empty',top,mc.restGripperY,extra);};
    if(fromKind!=='robot'&&!addMove(fromKey,options.kind==='optimize'?'유휴 재배치 빈 접근':options.kind==='dig'?'협업 재배치 빈 접근':fromKind==='port'?'피킹 완료 빈 회수 접근':'출고 빈 접근'))return null;
    if(fromKind!=='robot')take(fromKind,fromKey,fromKind==='grid'?mc.stackBaseY+fromCell.stack.length*bh:port.binY+bh/2);
    if(!addMove(toKey,options.kind==='optimize'?'주문 빈도 기반 상부 배치':options.kind==='dig'?'상부 빈 분담 운반':toKind==='port'?'포트 버퍼 반출':'빈 복귀 운반'))return null;
    if(toKind!=='robot')drop(toKind,toKey,toKind==='grid'?mc.stackBaseY+(toCell.stack.length+1)*bh:port.binY+bh/2);
    const endKey=this._transferEnd(robot,current,startKey,blocked,order,options);if(endKey===null)return null;
    // Usually the next mission starts exactly where this bin was placed. Only
    // move aside when that footprint would obstruct access or a shared intake.
    let exitBlocked=blocked;
    if(endKey!==current&&options.kind==='dig'&&this.config.cooperativeDigging){const avoidSource=new Set([...blocked,...this.footprint(fromKey,sign)]);
      if(this.path(current,endKey,avoidSource,sign))exitBlocked=avoidSource;}
    if(!addMove(endKey,'인출·통로 확보 대기',exitBlocked))return null;
    for(const k of this.footprint(current,sign))locked.add(k);
    const job={id:`J${++this._jobNumber}`,kind:options.kind,binId,fromKey,toKey,startKey,endKey,ops,locked,port,portSlot:options.portSlot??null,index:0,elapsed:0,order,startedAt:this.time};
    return this.config.strategies.timeReservations?prepareTraffic(this,robot,job,smoothMotion):job;
  }
  _returnStandby(){
    if(this._planningReturnStandby)return this._planningReturnStandby;
    const held=new Set();
    if(!this.config.orderPrefetch||this.robots.filter(r=>r.available).length<2)return held;
    const urgent=this._priorityRequests();
    for(const p of this.ports){
      const imminent=p.entries.filter(e=>(['ready','outbound'].includes(e.status)||e.status==='picking'&&e.pickDuration-e.pickElapsed<=10)&&(!urgent.length||this.orders.find(o=>o.id===e.requestId)?.priority==='urgent'||this._priorityPrerequisite(p,e,urgent)));
      if(!p.operational||p.inletReservation?.kind==='return'||!imminent.length)continue;
      const choices=this.robots.filter(r=>r.available&&!r.job&&!held.has(r.id)&&(this.config.cooperativeDigging||imminent.some(e=>this.orders.find(o=>o.id===e.requestId)?.soloRobotId===r.id))).map(r=>{const nodes=this._planningNodes(r),dist=Math.min(...p.intakeKeys.filter(k=>nodes.has(k)).map(k=>{const[x,z]=xy(k);return Math.abs(x-r.x)*GRID_X+Math.abs(z-r.z)*GRID_Z;}));return {r,dist};}).filter(c=>c.dist<=2.5).sort((a,b)=>a.dist-b.dist);
      if(choices.length)held.add(choices[0].r.id);
    }
    if(this._planningBlocks)this._planningReturnStandby=held;
    return held;
  }
  _robotsFor(order,kind){const bin=this.bins.get(order.binId),port=kind==='return'?this.ports.find(p=>p.entries.some(e=>e.requestId===order.id)):null,entry=port?.entries.find(e=>e.requestId===order.id);
    const source=kind==='return'?port?.intakeBySlot[entry?.slot]:bin?.location.type==='grid'?bin.location.key:null;
    const standby=kind==='return'?new Set():this._returnStandby();
    const candidates=this.robots.filter(r=>r.available&&!r.job&&!standby.has(r.id)).map(r=>{const path=source?this.path(keyOf(r.x,r.z),source,this._blockedFor(r),r.bodySign):null;
      const distance=path?path.slice(1).reduce((sum,k,i)=>{const[x,z]=xy(k),[a,b]=xy(path[i]);return sum+Math.abs(x-a)*GRID_X+Math.abs(z-b)*GRID_Z;},0):null;
      return {id:r.id,available:r.available,portCount:r.operationalPortKeys?.length||0,distance,completed:r.completed,index:r.index};});
    return this._rpc('rankRobots',{orderId:order.id,order:order.id.startsWith('OPT')?order:undefined,candidates}).map(id=>this.robots.find(r=>r.id===id));
  }
  _isPending(order){return order.status==='queued'||order.status==='inProgress';}
  _compareRequests(a,b){return Number(b.priority==='urgent')-Number(a.priority==='urgent')||(a.priority==='urgent'&&b.priority==='urgent'?((a.prioritySequence??a.sequence??0)-(b.prioritySequence??b.sequence??0)):0)||(a.sequence??0)-(b.sequence??0);}
  _priorityRequests(){return this.orders.filter(o=>o.priority==='urgent'&&this._isPending(o)).sort((a,b)=>this._compareRequests(a,b));}
  _canUsePortSlot(order,p,slot,retrieving=false){const key=p.intakeBySlot[slot],bin=this.bins.get(order.binId);if(!key||retrieving&&!['grid','robot'].includes(bin?.location.type))return false;
    return this.robots.some(r=>r.available&&(!order.soloRobotId||this.config.cooperativeDigging||r.id===order.soloRobotId)&&r.operationalPortKeys.includes(key)&&(!retrieving||(bin.location.type==='robot'?r.id===bin.location.robotId:r.serviceKeys.has(bin.location.key))));}
  _portHasSpace(p,order=null){return p.entries.length<p.capacity&&(p.type==='single'?[0]:[1,2]).some(slot=>!p.entries.some(e=>(e.slot??e.destinationSlot)===slot)&&(!order||this._canUsePortSlot(order,p,slot,true)));}
  _portCanReceive(p){return p.operational&&this._portHasSpace(p)&&!p.inletReservation&&!p.shuttle&&!p.rotation;}
  _priorityPorts(order){const b=this.bins.get(order.binId);if(order.pickedQty)return[];
    if(b?.location.type==='robot'){const robot=this.robots.find(r=>r.id===b.location.robotId),planned=this.ports.find(p=>p.id===robot?.job?.plannedPortId&&p.operational);return this.ports.filter(p=>p.operational&&(!planned||p===planned)&&p.intakeKeys.some(k=>robot?.operationalPortKeys.includes(k)));}
    if(b?.location.type!=='grid')return[];
    const robots=this.robots.filter(r=>r.available&&r.serviceKeys.has(b.location.key));
    return this.components[this.cells.get(b.location.key).component].ports.filter(p=>p.operational&&p.intakeKeys.some(k=>robots.some(r=>r.operationalPortKeys.includes(k))));}
  _priorityNeedsPortSpace(port,urgent){return urgent.some(order=>{if(this.ports.some(p=>p.entries.some(e=>e.requestId===order.id)))return false;const ports=this._priorityPorts(order);return ports.includes(port)&&!ports.some(p=>this._portHasSpace(p,order));});}
  _priorityPrerequisite(port,entry,urgent){return urgent.some(o=>o.binId===entry.binId)||this._priorityNeedsPortSpace(port,urgent);}
  _pendingTargetKeys(){return new Set(this.orders.filter(o=>this._isPending(o)&&!o.pickedQty).map(o=>this.bins.get(o.binId)).filter(b=>b?.location.type==='grid').map(b=>b.location.key));}
  _protectedTargets(order){const keys=new Set();for(const o of this.orders)if(this._compareRequests(o,order)<0&&this._isPending(o)&&!o.pickedQty){const b=this.bins.get(o.binId);if(b?.location.type==='grid')keys.add(b.location.key);}return keys;}
  _planDig(order,robot){const target=this.bins.get(order.binId);if(target?.location.type!=='grid')return null;const source=this.cells.get(target.location.key);if(source.stack.at(-1)===target.id)return null;
    // Higher priority targets, then earlier requests at the same priority, must
    // make monotonic progress without being re-covered by later work.
    const protectedKeys=this._protectedTargets(order);if(protectedKeys.has(source.key))return null;
    const accessible=this._planningNodes(robot);if(!accessible.has(source.key))return null;
    const sourceFootprint=new Set(this.footprint(source.key,robot.bodySign));
    const pendingTargets=this.config.orderPrefetch?this._pendingTargetKeys():new Set();
    const binId=source.stack.at(-1),comp=this.components[source.component],destinations=comp.storageKeys.filter(k=>k!==source.key&&!protectedKeys.has(k)&&accessible.has(k)&&this.cells.get(k).stack.length<this.levels).sort((a,b)=>{
      const score=k=>{const c=this.cells.get(k),overlap=this.config.cooperativeDigging&&this.footprint(k,robot.bodySign).some(f=>sourceFootprint.has(f));return(pendingTargets.has(k)?1000:0)+(overlap?20:0)+Math.abs(c.x-source.x)+Math.abs(c.z-source.z)+c.stack.length*.12;};return score(a)-score(b);});
    for(const dest of destinations){const job=this._buildTransfer(order,robot,binId,'grid',source.key,'grid',dest,{kind:'dig'});if(job)return job;}return null;
  }
  _planSupply(order,robot){
    if(!this.config.orderPrefetch||this.robots.filter(r=>r.available).length<2)return this._planDelivery(order,robot);
    // Lift without monopolizing the shaft; approach from a safe nearby queue.
    const lifted=this._planPrelift(order,robot);if(lifted)return lifted;
    return this._planDelivery(order,robot,{emptyOnly:true});
  }
  _planPrelift(order,robot){
    // A solo carrier must remain empty until its own station bin is returned.
    if(!this.config.cooperativeDigging&&this.ports.some(p=>p.entries.some(e=>this.orders.find(o=>o.id===e.requestId)?.soloRobotId===robot.id)))return null;
    const b=this.bins.get(order.binId);if(b?.location.type!=='grid')return null;const c=this.cells.get(b.location.key);if(c.stack.at(-1)!==b.id)return null;
    const staged=id=>this.robots.filter(r=>r.job?.kind==='prelift'&&r.job.plannedPortId===id).length;
    const ports=this.ports.filter(p=>p.operational&&p.intakeKeys.some(k=>robot.operationalPortKeys.includes(k))).sort((a,b)=>portForecast(a)+staged(a.id)*20-portForecast(b)-staged(b.id)*20);
    for(const port of ports){if(staged(port.id))continue;
      const job=this._buildTransfer(order,robot,b.id,'grid',c.key,'robot',c.key,{kind:'prelift',queuePort:port});
      if(job){job.plannedPortId=port.id;return job;}
    }return null;
  }
  _planDelivery(order,robot,{emptyOnly=false}={}){const b=this.bins.get(order.binId),loaded=b?.location.type==='robot'&&b.location.robotId===robot.id;
    if(!loaded&&b?.location.type!=='grid')return null;const c=this.cells.get(loaded?keyOf(robot.x,robot.z):b.location.key);if(!loaded&&c.stack.at(-1)!==b.id)return null;
    const accessible=this._planningNodes(robot);if(!accessible.has(c.key))return null;
    const planned=loaded&&this.ports.find(p=>p.id===robot.job?.plannedPortId&&p.operational);
    const ports=this.components[c.component].ports.filter(p=>(!emptyOnly||!p.entries.length)&&(!planned||p===planned)&&(!this.config.orderPrefetch||loaded||!this.robots.some(r=>r!==robot&&r.job?.kind==='prelift'&&r.job.plannedPortId===p.id))&&this._portCanReceive(p)&&p.intakeKeys.some(k=>accessible.has(k))).sort((a,b)=>(a.entries.length/a.capacity)*3+Math.abs(a.x-c.x)+Math.abs(a.z-c.z)-((b.entries.length/b.capacity)*3+Math.abs(b.x-c.x)+Math.abs(b.z-c.z)));
    if(this.config.orderPrefetch||this.config.strategies.completionTime||this.config.strategies.portPacing)ports.sort((a,b)=>{const score=p=>(this.config.orderPrefetch?Math.max(0,portForecast(p)-10):portForecast(p))+Math.abs(p.x-c.x)*GRID_X+Math.abs(p.z-c.z)*GRID_Z;return score(a)-score(b);});
    for(const port of ports)for(const slot of port.type==='single'?[0]:[1,2]){const k=port.intakeBySlot[slot];if(!k||!accessible.has(k)||port.entries.some(e=>e.slot===slot))continue;const job=this._buildTransfer(order,robot,b.id,loaded?'robot':'grid',c.key,'port',k,{kind:'deliver',port,portSlot:slot});if(job)return job;}return null;
  }
  _planReturn(order,robot,port,entry){if(!entry.atShaft||entry.status!=='outbound'||port.inletReservation||port.shuttle||port.rotation)return null;
    const fromKey=port.intakeBySlot[entry.slot];if(!fromKey)return null;
    const accessible=this._planningNodes(robot);if(!accessible.has(fromKey))return null;
    const pendingTargets=this.config.orderPrefetch?this._pendingTargetKeys():new Set();
    const protectedKeys=this._protectedTargets(order),comp=this.components[this.cells.get(port.key).component],destinations=comp.storageKeys.filter(k=>!protectedKeys.has(k)&&accessible.has(k)&&this.cells.get(k).stack.length<this.levels).sort((a,b)=>{
      if(!this.config.orderPrefetch){if(a===order.returnKey)return-1;if(b===order.returnKey)return 1;}const c=this.cells.get(a),d=this.cells.get(b);return(Number(pendingTargets.has(a))-Number(pendingTargets.has(b)))*1000+(Math.abs(c.x-port.x)+Math.abs(c.z-port.z))-(Math.abs(d.x-port.x)+Math.abs(d.z-port.z));});
    for(const dest of destinations){const job=this._buildTransfer(order,robot,entry.binId,'port',fromKey,'grid',dest,{kind:'return',port,portSlot:entry.slot});if(job)return job;}return null;
  }
  _assignJob(robot,job){
    const {order,port,locked,ops,optimizationPlan,...fields}=job;
    this._rpc('assign',{robotId:robot.id,job:{...fields,orderId:order.id,portId:port?.id,locked:[...locked]},order:job.kind==='optimize'?order:undefined});
    robot.job=job;robot.currentOperation=ops[0];robot.status=ops[0]?.purpose||PHASE_NAMES[ops[0]?.phase];robot.progress=0;
    this._planningBlocks?.clear();this._planningReach?.clear();this._planningParking?.clear();this._planningReturnStandby=null;
    this._updateAccess();this._runtimeContextDirty=true;
    this.log('info',robot.id+' · '+order.id,job.kind==='optimize'?job.binId+' 유휴 재배치':job.kind==='dig'?job.binId+' 상부 빈 분담 재배치':job.kind==='prelift'?job.binId+' 선행 리프팅':job.kind==='deliver'?job.binId+' → '+port.id+' 인계':port.id+' → '+job.binId+' 회수');
  }
  _dispatchReturn(order,port,entry,prerequisite=false){if(!this._rpc('taskKind',{kind:'return',orderId:order.id,portId:port.id}))return false;
    for(const r of this._robotsFor(order,'return')){const job=this._planReturn(order,r,port,entry);if(job){job.priorityPrerequisite=prerequisite;this._assignJob(r,job);return true;}}return false;}
  _dispatchRetrieval(order){const kind=this._rpc('taskKind',{kind:'retrieve',orderId:order.id});if(!kind)return false;
    for(const r of this._robotsFor(order,kind)){const job=kind==='dig'?this._planDig(order,r):this._planDelivery(order,r);if(job){this._assignJob(r,job);return true;}}return false;}
  _dispatch(){
    if(this._lastDispatchRevision===this.revision&&(!this.config.orderPrefetch||this.time<(this._nextPreparationCheck||0)))return;
    this._nextPreparationCheck=this.time+.5;
    this._planningBlocks=new Map();this._planningReach=new Map();this._planningParking=new Map();this._planningReturnStandby=null;
    try {
    // Clear completed station bins before a queued delivery reserves the inlet.
    if(this.config.orderPrefetch){
      const returns=this._rpc('dispatchPlan').tasks.filter(t=>t.kind==='return');
      for(const task of returns){const order=this.orders.find(o=>o.id===task.orderId),port=this.ports.find(p=>p.id===task.portId),entry=port?.entries.find(e=>e.requestId===task.orderId);
        if(order&&entry)this._dispatchReturn(order,port,entry,task.prerequisite);
      }
    }
    // Finish already lifted payloads before assigning new speculative work.
    for(const robot of this.robots.filter(r=>r.job?.prepared).sort((a,b)=>this._compareRequests(a.job.order,b.job.order))){
      const next=this._planDelivery(robot.job.order,robot);if(next)this._assignJob(robot,next);
    }
    const plan=this._rpc('dispatchPlan');
    if(plan.cancelOptimization&&this.optimizationPlan){if(this.robots.some(r=>r.job?.kind==='optimize'))this.optimizationPlan.cancelAfterJob=true;else this.optimizationPlan=null;}
    if(this.config.orderPrefetch||this.config.strategies.completionTime||this.config.strategies.portPacing)dispatchStrategies(this);
    else for(const task of plan.tasks){const order=this.orders.find(o=>o.id===task.orderId);if(!order)continue;
      if(task.kind==='return'){const p=this.ports.find(p=>p.id===task.portId),e=p?.entries.find(e=>e.requestId===order.id);if(e)this._dispatchReturn(order,p,e,task.prerequisite);}
      else this._dispatchRetrieval(order);
    }
    const retry=this._rpc('finalizeDispatch');this._dispatchOptimization();this._lastDispatchRevision=retry?-1:this.revision;
    }finally{this._planningBlocks=null;this._planningReach=null;this._planningParking=null;this._planningReturnStandby=null;}
  }
  _operationStart(robot,op){robot.status=op.type==='move'?op.purpose:PHASE_NAMES[op.phase]||op.phase;robot.speedMps=0;if(Number.isFinite(op.fromY))robot.gripperY=op.fromY;this.revision++;}
  _operationEnd(robot,op){
    if(Number.isFinite(op.toY))robot.gripperY=op.toY;
    this._rpc('operationEnd',{robot:{id:robot.id,x:robot.x,z:robot.z,gripperY:robot.gripperY,carryingBinId:robot.carryingBinId},op});
    if(op.type==='move'){[robot.x,robot.z]=xy(op.path.at(-1));robot.position={x:robot.x,z:robot.z};}
  }
  _finish(robot){const job=robot.job;
    if(job.kind==='prelift'){
      this._rpc('finishPrelift',{robotId:robot.id});job.prepared=true;
      job.ops=[{type:'wait',phase:'prepared',purpose:'선행 리프팅 완료 · 포트 인계 대기',duration:1e12}];job.index=0;job.elapsed=0;
      robot.currentOperation=job.ops[0];robot.status=job.ops[0].purpose;robot.progress=0;robot.speedMps=0;this._lastDispatchRevision=-1;return;
    }
    this._rpc('finish',{robotId:robot.id});
    if(job.kind==='optimize'){const plan=job.optimizationPlan;plan.index++;if(job.binId===plan.targetBinId)this.optimizedBins.add(plan.targetBinId);if(plan.cancelAfterJob||plan.index>=plan.moves.length){this.optimizationPlan=null;this._hasOptimizationWork=false;}}
    robot.completed++;robot.job=null;robot.currentOperation=null;robot.carryingBinId=null;robot.status=PHASE_NAMES.idle;robot.progress=0;robot.speedMps=0;
  }
  _animate(robot,op,elapsed){const t=clamp(elapsed/op.duration,0,1);robot.progress=t;
    if(op.type==='move'){let local=elapsed;for(let i=0;i<op.segments.length;i++){const v=op.segments[i];if(local<=v.duration+1e-9||i===op.segments.length-1){const q=clamp(local/v.duration,0,1),f=smoothMotion(q);robot.x=v.from.x+(v.to.x-v.from.x)*f;robot.z=v.from.z+(v.to.z-v.from.z)*f;robot.speedMps=v.distance/v.duration*smoothVelocity(q);break;}local-=v.duration;}robot.position={x:robot.x,z:robot.z};
    }else if(Number.isFinite(op.fromY)&&Number.isFinite(op.toY)){robot.gripperY=op.fromY+(op.toY-op.fromY)*smoothMotion(t);robot.speedMps=Math.abs(op.toY-op.fromY)/op.duration*smoothVelocity(t);}else robot.speedMps=0;
    if(robot.carryingBinId)Object.assign(this.bins.get(robot.carryingBinId).location,{x:robot.x,z:robot.z,y:robot.gripperY-this.config.binHeightM/2});
  }
  _releasePassedLocks(robot){const job=robot.job;if(!job)return;
    const xLow=Math.floor(robot.x+1e-8),xHigh=Math.ceil(robot.x-1e-8),zLow=Math.floor(robot.z+1e-8),zHigh=Math.ceil(robot.z-1e-8),signature=`${job.index}:${xLow}:${xHigh}:${zLow}:${zHigh}`;
    if(job.lockProgress===signature)return;job.lockProgress=signature;
    const keep=new Set(),add=k=>{for(const f of this.footprint(k,robot.bodySign))keep.add(f);};
    // Keep the complete remaining route, future hoists and the actual continuous
    // two-cell envelope. Reservations only shrink; jobs never acquire conflicting
    // cells halfway through motion, and no cell is released below a moving body.
    for(let i=job.index;i<job.ops.length;i++){const op=job.ops[i];
      if(op.type==='move'){let first=0;
        if(i===job.index){let local=job.elapsed;for(let j=0;j<op.segments.length;j++){const s=op.segments[j];if(local<=s.duration+1e-9||j===op.segments.length-1){
              const walked=Math.abs(robot.x-s.from.x)+Math.abs(robot.z-s.from.z);first=s.pathStart+Math.floor(walked+1e-8);break;}local-=s.duration;}}
        for(const k of op.path.slice(first))add(k);
      }else if(op.key)add(op.key);
    }
    for(let x=xLow;x<=xHigh;x++)for(let z=zLow;z<=zHigh;z++)add(keyOf(x,z));
    let changed=false;const released=[];for(const k of job.locked)if(!keep.has(k)){released.push(k);job.locked.delete(k);if(this.locks.get(k)===robot.id)this.locks.delete(k);changed=true;}
    if(changed){this._rpc('releaseLocks',{robotId:robot.id,released});this.revision++;}
  }
  _portLayout(p){return {...p.stationLayout,angle:p.rotation?smoothMotion(p.rotation.elapsed/p.rotation.duration)*p.rotation.delta*2*Math.PI/3:0,
    shafts:Object.entries(p.intakeBySlot).filter(([,k])=>k).map(([index,key])=>{const[x,z]=xy(key);return{index:Number(index),key,x,z,binY:p.binY};}),equipmentCells:p.footprintReservedKeys.map(key=>{const[x,z]=xy(key);return{key,x,z};})};}
  _slotPosition(p,index,angle=0){if(p.type==='single')return {x:p.x,z:p.z,binY:p.binY};const l=p.stationLayout,a=index*2*Math.PI/3+angle;
    return {x:l.hubX+(l.outX*Math.cos(a)+l.tanX*Math.sin(a))*l.radiusM/GRID_X,z:l.hubZ+(l.outZ*Math.cos(a)+l.tanZ*Math.sin(a))*l.radiusM/GRID_Z,binY:p.binY};}
  _portEntryPosition(p,e){return e.slot!==null?this._slotPosition(p,e.slot,this._portLayout(p).angle):e.position;}
  _setAperture(p,open){this._rpc('portAction',{portId:p.id,action:'aperture',open});}
  _rotatePort(p,delta){this._rpc('portAction',{portId:p.id,action:'rotate',delta});}
  _startPicking(p,e){if(!this._replayingRustEvent)this._rpc('portAction',{portId:p.id,action:'pick',requestId:e.requestId});}
  _syncPort(p){this._rpc('portAction',{portId:p.id,action:'sync'});}
  _tickPorts(dt){this._rpc('tickPorts',{dt});}
  tick(dt){if(!this.running||!Number.isFinite(dt)||dt<=0)return;let remaining=Math.min(dt,7200);
    while(remaining>1e-8){const step=Math.min(.10,remaining);remaining-=step;this._dispatch();this.time+=step;
      for(const robot of this.robots){const job=robot.job;if(!job)continue;let t=step;
        while(t>1e-8&&robot.job){const op=job.ops[job.index];if(!op){this._finish(robot);break;}robot.currentOperation=op;if(!op.started){this._operationStart(robot,op);op.started=true;}
          const use=Math.min(t,op.duration-job.elapsed);job.elapsed+=use;t-=use;this._animate(robot,op,job.elapsed);robot.battery=Math.max(15,robot.battery-use*.001);
          if(job.elapsed>=op.duration-1e-8){this._operationEnd(robot,op);job.index++;job.elapsed=0;if(job.index>=job.ops.length)this._finish(robot);else{robot.currentOperation=job.ops[job.index];robot.progress=0;}}
        }if(robot.job)this._releasePassedLocks(robot);}
      this._tickPorts(step);
      const hasJob=this.robots.some(r=>r.job),hasPort=this.ports.some(p=>p.entries.length||p.rotation||p.shuttle),hasRequests=this.orders.some(o=>o.status==='queued'||o.status==='inProgress');
      if(!hasJob&&!hasPort&&!hasRequests&&!this.config.idleOptimization){this.running=false;remaining=0;}
      else if(!hasJob&&!hasPort&&!hasRequests&&this.config.idleOptimization){this.stalled=false;}
      else if(!hasJob&&!this.ports.some(p=>p.rotation||p.shuttle||p.activeEntryId)&&this.time-this._lastProgressTime>30){this.stalled=true;this.running=false;remaining=0;this.log('warning','진행 경로를 확인해 주세요','상부 주차점·2칸 경로 또는 포트 회수 경로가 막혀 안전하게 멈췄습니다.');}
    }
  }
  getRobotVisuals(){return this.robots.map(r=>({id:r.id,x:r.x,z:r.z,bodySign:r.bodySign,onGrid:r.onGrid,available:r.available,status:r.status,carryingBinId:r.carryingBinId,travelSpeedMps:r.currentOperation?.type==='move'?r.speedMps:0,
    route:getRemainingRobotRoute(r),jobTargetBinId:r.job?.binId??null,wheels:getWheelTravelState(r.currentOperation,r.job?.elapsed??0),
    jobRole:r.job?.kind??'idle',parentOrderId:r.job?.order.id??null,customerOrderId:r.job?.order.customerOrderId??null,
    hoist:{phase:r.currentOperation?.phase||'idle',gripperY:r.gripperY,binY:r.carryingBinId?r.gripperY-this.config.binHeightM/2:null,binId:r.carryingBinId,loaded:!!r.carryingBinId,
      progress:r.progress,speedMps:r.currentOperation?.type==='hoist'?r.speedMps:0,operation:r.currentOperation?.type||'idle',sourceKey:r.currentOperation?.sourceKey??null,targetKey:r.currentOperation?.targetKey??null}}));}
  getPortVisuals(){return this.ports.map(p=>{const layout=this._portLayout(p),active=p.entries.find(e=>e.requestId===p.activeEntryId),reserved=p.entries.filter(e=>e.status==='reserved').length;
      const bins=p.entries.filter(e=>this.bins.get(e.binId)?.location.type==='port').map(e=>{const pos=this._portEntryPosition(p,e);return{id:e.binId,binId:e.binId,...pos,slot:e.slot,role:e.status==='picking'?'work':e.atShaft?'intake':'buffer',status:e.status,requestId:e.requestId,pickQuantity:this.orders.find(o=>o.id===e.requestId)?.qty||1,progress:e.status==='picking'?e.pickElapsed/e.pickDuration:0};});
      const slots=Array.from({length:p.capacity},(_,index)=>{const e=p.entries.find(e=>e.slot===index);return{index,...this._slotPosition(p,index,layout.angle),role:index===0?'work':'buffer',binId:e?.binId??null,status:e?.status??'empty',requestId:e?.requestId??null};});
      return{id:p.id,type:p.type,x:p.x,z:p.z,capacity:p.capacity,occupied:bins.length,reserved,usedSlots:p.entries.length,presentedBinId:active?.binId??(!p.rotation?p.entries.find(e=>e.slot===0)?.binId:null)??null,
        operational:p.operational,operationalReason:p.operationalReason,footprintReservedKeys:p.footprintReservedKeys,installationBounds:p.installationBounds,
        rotationProgress:p.rotation?smoothMotion(p.rotation.elapsed/p.rotation.duration):1,rotating:!!p.rotation,aperture:{...p.aperture},presentation:{...p.presentation},accessibleBinId:p.aperture.state==='open'&&p.presentation.pickAllowed&&!p.rotation?active?.binId??null:null,
        activeRequestId:p.activeEntryId,status:p.status,progress:active?active.pickElapsed/active.pickDuration:p.rotation?p.rotation.elapsed/p.rotation.duration:p.shuttle?p.shuttle.elapsed/p.shuttle.duration:0,
        binBaseY:this.getMotionConfig().portBaseY,layout,bins,slots};});}
  refreshWeights(binId=null){if(this._runtime)return this._rpc('refreshWeights',{binId});for(const b of binId?[this.bins.get(binId)]:this.bins.values())if(b)b.weightKg=+b.skuIds.reduce((n,id)=>{const s=this.skuMap.get(id);return n+s.qty*s.unitWeightKg;},0).toFixed(3);}
  getSkuRows(catalog=this.catalog){const reserved=new Map();for(const o of this.orders)if(o.status==='queued'||o.status==='inProgress')reserved.set(o.skuId,(reserved.get(o.skuId)||0)+Math.max(0,o.qty-o.pickedQty));return catalog.map(s=>{const b=this.bins.get(s.binId),loc=b?.location;return {...s,quantity:s.qty,weight:s.unitWeightKg,location:loc?{...loc}:null,x:loc?.x??null,z:loc?.z??null,level:loc?.type==='grid'?loc.level+1:null,
    locationLabel:!b?'미배정':loc.type==='grid'?`(${loc.x+1}, ${loc.z+1}) · ${loc.level+1}층`:loc.type==='robot'?`${loc.robotId} 인양·운반 중`:`${loc.portId} 포트`,
    reservedQty:reserved.get(s.id)||0};});}
  _prioritySummary(order){if(!order)return null;
    const robots=this.robots.filter(r=>r.job?.order===order),claim=this.binClaims.get(order.binId),owner=claim&&claim!==order.id?this.orders.find(o=>o.id===claim):null;
    const port=this.ports.find(p=>p.entries.some(e=>e.requestId===order.id)),entry=port?.entries.find(e=>e.requestId===order.id);
    let reason='';
    if(owner){reason=owner.portId||owner.pickedQty?'같은 빈의 선행 반출·복귀 대기':'진행 중 안전 이송 마무리 대기';}
    else if(!robots.length&&entry?.status!=='picking'){
      if(entry?.status==='waiting')reason=port.activeEntryId?'진행 중인 포트 피킹 완료 대기':port.rotation||port.aperture.state==='closing'?'포트 안전 교환 중':'포트 표시 준비 중';
      else if(order.pickedQty)reason='피킹 완료 빈의 안전한 복귀 경로 확보 중';
      else if(this.ports.some(p=>this._priorityNeedsPortSpace(p,[order])))reason='포트 자리 확보 중';
      else if(this.robots.some(r=>r.job&&r.job.order.priority!=='urgent'))reason='진행 중 안전 이송 마무리 대기';
      else reason='가용 로봇·경로 확보 대기';
    }
    return {id:order.id,skuId:order.skuId,binId:order.binId,stage:order.stage,qty:order.qty,pickedQty:order.pickedQty,portId:order.portId,robotIds:robots.length?robots.map(r=>r.id):[...order.robotIds],reason};}
  getStats(){let assigned=0,reachable=0,noPort=0,operationalSkus=0,currentQty=0,initialQty=0;
    // One pass avoids six temporary 100k-entry scans on every HUD refresh.
    for(const sku of this.catalog){currentQty+=sku.qty;initialQty+=sku.initialQty;if(!sku.assigned)continue;assigned++;if(sku.reachable)reachable++;else if(sku.accessReason==='연결된 포트 없음')noPort++;if(sku.operational)operationalSkus++;}
    const queuedOrders=this.orders.filter(o=>o.status==='queued').length,activeOrders=this.orders.filter(o=>o.status==='inProgress').length,blockedOrders=this.orders.filter(o=>o.status==='blocked').length;
    const operationalPortCount=this.ports.filter(p=>p.operational).length,operational=operationalPortCount>0,operationalReason=operational?'':this.ports[0]?.operationalReason||'운영할 포트를 배치해 주세요.';
    const priorityOrders=this._priorityRequests(),priorityRequestCount=priorityOrders.length,priorityQueuedCount=priorityOrders.filter(o=>o.status==='queued').length,priorityActiveCount=priorityRequestCount-priorityQueuedCount,priorityRequest=this._prioritySummary(priorityOrders[0]);
    const optimizingRobotCount=this.robots.filter(r=>r.job?.kind==='optimize').length,systemState=!operational?'installation_blocked':!this.running?this.paused?'paused':'ready':priorityRequestCount?'priority':queuedOrders||activeOrders?'processing':optimizingRobotCount||this.optimizationPlan?'optimizing':'waiting';
    const systemStateLabel={installation_blocked:'설치 조건 확인',paused:'일시정지',ready:'운영 시작 대기',priority:'우선순위 반출 중',processing:'주문 처리 중',optimizing:'유휴 재고 최적화',waiting:'운영 대기'}[systemState];
    const priorityStages={queued:'우선 요청 배정 대기',digging:'상부 빈 협업 디깅 중',awaiting_dig:'다음 디깅 로봇 배정 중',delivering:'요청 빈을 포트로 반출 중',port_queue:'포트 표시 순서 대기',picking:'요청 수량 피킹 중',awaiting_return:'피킹 완료 빈 복귀 준비 중',returning:'요청 빈을 그리드로 복귀 중'};
    const systemStateDetail=systemState==='installation_blocked'?operationalReason:systemState==='paused'?'로봇·포트·유휴 최적화가 함께 멈췄습니다.':systemState==='priority'?`${priorityRequest.id} · ${priorityRequest.binId} · ${priorityRequest.reason||priorityStages[priorityRequest.stage]||'우선 작업 진행 중'}`:systemState==='optimizing'?'기존 주문에서 자주 요청한 빈을 실제로 꺼내 다른 열 맨 위에 배치합니다.':systemState==='waiting'?this.demandWeights.size?'추가로 개선할 배치가 없습니다. 새 주문을 기다립니다.':'주문 빈도 자료 또는 새 출고 요청을 기다립니다.':systemState==='processing'?'출고 요청을 우선 처리합니다. 진행 중인 재배치는 안전하게 마무리합니다.':'시작하면 출고와 유휴 최적화를 실행합니다.';
    return {systemState,systemStateLabel,systemStateDetail,priorityRequestCount,priorityQueuedCount,priorityActiveCount,priorityRequest,optimizationMoves:this.metrics.optimizationMoves,optimizingRobotCount,optimizedBinCount:this.optimizedBins.size,demandSampleSize:this.demandSampleSize,hasOptimizationWork:this._hasOptimizationWork||!!this.optimizationPlan,
      operational,operationalReason,operationalPortCount,operationalSkuCount:operationalSkus,minimumOperationalLevels:this.binSpec.minimumLevels,minimumOperationalHeightM:+(this.binSpec.minimumLevels*this.config.binHeightM).toFixed(3),maxBinLevels:this.binSpec.maximumLevels,equipmentReservedCellCount:[...this.cells.values()].filter(c=>c.isEquipment).length,
      inventoryEditable:this.canAddSkus(),cooperativeRequestCount:this.orders.filter(o=>o.diggingRobotIds.length>1).length,portBinCount:this.ports.reduce((n,p)=>n+p.entries.filter(e=>this.bins.get(e.binId)?.location.type==='port').length,0),portReservedCount:this.ports.reduce((n,p)=>n+p.entries.filter(e=>e.status==='reserved').length,0),skuCount:this.catalog.length,assignedSkuCount:assigned,unassignedSkuCount:this.catalog.length-assigned,reachableSkuCount:reachable,unservedSkuCount:assigned-reachable,noPortSkuCount:noPort,robotInaccessibleSkuCount:assigned-reachable-noPort,
      rawBinCapacity:this.rawBinCapacity,usableBinCapacity:this.usableBinCapacity,capacitySkus:this.usableBinCapacity*this.config.compartments,binCount:this.bins.size,occupiedBinCount:this.bins.size,reserveSlots:this.rawBinCapacity-this.usableBinCapacity,
      accessReservedCellCount:[...this.cells.values()].filter(c=>c.storageExcluded).length,
      cellCount:this.cells.size,storageCellCount:this.components.reduce((n,c)=>n+c.storageKeys.length,0),portCount:this.ports.length,robotCount:this.robots.length,placedRobotCount:this.robots.filter(r=>r.available).length,unplacedRobotCount:this.robots.filter(r=>!r.available).length,
      levels:this.levels,actualHeightM:this.actualHeightM,binHeightM:this.config.binHeightM,footprintM2:+(this.cells.size*.705*.480).toFixed(2),occupancy:this.rawBinCapacity?this.bins.size/this.rawBinCapacity:0,
      simTime:this.time,queuedOrders,activeOrders,blockedOrders,completedOrders:this.metrics.completedOrders,pickedUnits:this.metrics.pickedUnits,relocations:this.metrics.relocations,travelMeters:+this.metrics.travelMeters.toFixed(1),robotMoves:this.metrics.robotMoves,
      avgOrderSec:this.metrics.completedOrders?this.metrics.totalOrderSec/this.metrics.completedOrders:0,currentQty,initialQty,
      deletedSkuCount:this.deletedSkuCount,deletedCurrentQty:this.deletedCurrentQty,deletedInitialQty:this.deletedInitialQty,
      componentCount:this.components.length,activeRobotCount:this.robots.filter(r=>r.job).length};}
  getWarnings(){const s=this.getStats(),out=[];if(!s.cellCount)out.push('그리드 셀을 배치해 주세요.');if(!s.portCount)out.push('포트가 없어 출고를 실행할 수 없습니다.');
    if(this.ports.length&&this.levels<this.binSpec.minimumLevels)out.push(`보관 설계만 가능: ${this.config.binHeightM*1000} mm 빈의 출고 설비는 최소 ${this.binSpec.minimumLevels}층이 필요합니다.`);
    else for(const p of this.ports)if(!p.operational)out.push(`${p.id} 설치 불가: ${p.operationalReason}`);
    if(Math.floor((this.config.maxHeightM+1e-8)/this.config.binHeightM)>this.binSpec.maximumLevels)out.push(`빈 규격의 최대 ${this.binSpec.maximumLevels}층을 적용했습니다. 실제 적층 높이 ${this.actualHeightM} m.`);
    if(s.unassignedSkuCount)out.push(`${s.unassignedSkuCount.toLocaleString()} SKU는 출고 가능한 저장 공간이 부족하여 미배정입니다.`);
    if(s.noPortSkuCount)out.push(`${s.noPortSkuCount.toLocaleString()} SKU가 포트 없는 구역에 있습니다.`);
    if(s.robotInaccessibleSkuCount)out.push(`${s.robotInaccessibleSkuCount.toLocaleString()} SKU는 2칸 차체·상부 대기점 때문에 출고 경로가 없습니다.`);
    if(s.unplacedRobotCount)out.push(`로봇 ${s.unplacedRobotCount}대 미배치: 안전한 2칸 상부 주차 공간이 부족합니다.`);
    if(s.blockedOrders)out.push(`${s.blockedOrders}건이 재고·2칸 경로·재배치 공간 문제로 보류되었습니다.`);if(this.stalled)out.push('상부 로봇 또는 포트 회수 경로가 막혀 시뮬레이션이 멈췄습니다.');return out;}
  snapshot(){return {config:this.config,levels:this.levels,actualHeightM:this.actualHeightM,running:this.running,time:this.time,revision:this.revision,cells:[...this.cells.values()],bins:[...this.bins.values()],robots:this.robots,ports:this.ports,orders:this.orders,stats:this.getStats(),logs:this.logs,warnings:this.getWarnings(),motion:this.getMotionConfig()};}
  assertInvariants(){const seen=new Set(),bh=this.config.binHeightM,mc=this.getMotionConfig();
    for(const c of this.cells.values()){if(c.isEquipment&&c.stack.length)throw new Error('storage inside reserved station footprint');if(c.storageExcluded&&c.stack.length)throw new Error('storage inside access-reserved column');if(c.stack.length>this.levels)throw new Error('stack capacity exceeded');for(let i=0;i<c.stack.length;i++){const id=c.stack[i];if(seen.has(id))throw new Error('duplicate bin');seen.add(id);const b=this.bins.get(id);if(b.location.type!=='grid'||b.location.key!==c.key||b.location.level!==i)throw new Error('bin location mismatch');}}
    for(const r of this.robots){if(r.carryingBinId){if(seen.has(r.carryingBinId))throw new Error('duplicate carried bin');seen.add(r.carryingBinId);const b=this.bins.get(r.carryingBinId);if(b.location.robotId!==r.id)throw new Error('carrier mismatch');if(Math.abs(b.location.y-(r.gripperY-bh/2))>1e-7)throw new Error('carried bin pose mismatch');}
      if(r.available){if(!r.onGrid||!Number.isFinite(r.x)||!Number.isFinite(r.z))throw new Error('available robot left grid');
        // Every point swept by the fixed two-cell rectangle must remain over active grid cells.
        const xLow=Math.floor(r.x+1e-8),xHigh=Math.ceil(r.x-1e-8),zLow=Math.floor(r.z+1e-8),zHigh=Math.ceil(r.z-1e-8);
        for(let x=xLow;x<=xHigh;x++)for(let z=zLow;z<=zHigh;z++){const k=keyOf(x,z);if(!this.validPosition(k,r.bodySign))throw new Error('two-cell footprint outside grid');
          if(r.job&&this.footprint(k,r.bodySign).some(f=>r.job.traffic?!r.job.traffic.windows.some(w=>w.key===f&&w.start<=this.time+1e-6&&w.end>=this.time-1e-6):(this.locks.get(f)!==r.id||!r.job.locked.has(f))))throw new Error('moving two-cell footprint lost its reservation');}
        if(r.gripperY<.014||r.gripperY>mc.restGripperY+1e-7)throw new Error('gripper outside motion envelope');
        if(!r.job&&(Math.abs(r.gripperY-mc.restGripperY)>1e-7||r.carryingBinId))throw new Error('idle hoist not retracted');
      }else if(r.onGrid||r.job)throw new Error('unavailable robot rendered or assigned');
    }
    for(const o of this.orders){const ids=this.robots.filter(r=>r.job?.order===o).map(r=>r.job.id);
      if(ids.length!==(o.activeJobIds||[]).length||ids.some(id=>!o.activeJobIds.includes(id))||(ids.length?!ids.includes(o.activeJobId):o.activeJobId!==null))throw new Error('request active job tracking mismatch');}
    for(const [key,owner]of this.locks)if(!this.robots.some(r=>r.id===owner&&r.job?.locked.has(key)))throw new Error('orphan robot route reservation');
    for(const p of this.ports){
      if(p.entries.length>p.capacity)throw new Error('port reservation capacity exceeded');
      if(!p.operational&&p.entries.length)throw new Error('bin sent to an uninstalled station');
      if(p.rotation){
        const reveal=smoothMotion(p.rotation.elapsed/p.rotation.duration)>=.8&&p.entries.some(e=>e.status==='waiting'&&(e.slot+p.rotation.delta+3)%3===0&&e.binId===p.presentation.binId);
        const closing=p.aperture.state==='closing'&&p.aperture.to===0&&p.rotation.elapsed<=.8+1e-7;
        if(p.inletReservation||p.activeEntryId||p.presentation.pickAllowed||(!reveal&&!closing&&(p.aperture.openness!==0||p.aperture.state!=='closed')))throw new Error('carousel access interlock violated');
      }
      if(p.entries.filter(e=>e.status==='picking').length>1)throw new Error('multiple active picks at one port');
      const slots=new Set();for(const e of p.entries){if(e.slot!==null){if(slots.has(e.slot))throw new Error('duplicate occupied buffer slot');slots.add(e.slot);}
        const b=this.bins.get(e.binId);if(b.location.type==='port'){if(seen.has(e.binId))throw new Error('duplicate port bin');seen.add(e.binId);if(b.location.portId!==p.id)throw new Error('port ownership mismatch');const pos=this._portEntryPosition(p,e);if(!pos||Math.abs(b.location.x-pos.x)>1e-7||Math.abs(b.location.z-pos.z)>1e-7||Math.abs(b.location.y-pos.binY)>1e-7)throw new Error('port visual pose mismatch');}
        else if(e.status!=='reserved')throw new Error('buffer entry has no physical bin');}
      if(p.activeEntryId&&!p.entries.some(e=>e.requestId===p.activeEntryId&&e.status==='picking'))throw new Error('active port request mismatch');
      if(p.activeEntryId&&(p.aperture.state!=='open'||p.aperture.openness!==1||!p.presentation.pickAllowed))throw new Error('picking through a closed access opening');
      const physical=p.entries.filter(e=>this.bins.get(e.binId)?.location.type==='port').map(e=>this.bins.get(e.binId));
      for(let i=0;i<physical.length;i++){const a=physical[i].location,x=a.x*GRID_X,z=a.z*GRID_Z;
        for(let j=i+1;j<physical.length;j++){const b=physical[j].location;if(Math.abs(x-b.x*GRID_X)<BIN_X-1e-7&&Math.abs(z-b.z*GRID_Z)<BIN_Z-1e-7&&Math.abs(a.y-b.y)<bh-1e-7)throw new Error('physical bins overlap inside carousel');}
        for(let gx=Math.floor((x-BIN_X)/GRID_X);gx<=Math.ceil((x+BIN_X)/GRID_X);gx++)for(let gz=Math.floor((z-BIN_Z)/GRID_Z);gz<=Math.ceil((z+BIN_Z)/GRID_Z);gz++){
          const c=this.cells.get(keyOf(gx,gz));if(c?.stack.length&&Math.abs(x-gx*GRID_X)<BIN_X-1e-7&&Math.abs(z-gz*GRID_Z)<BIN_Z-1e-7&&a.y-bh/2<mc.stackBaseY+c.stack.length*bh-1e-7)throw new Error('station bin intersects adjacent stored bins');
        }
      }
    }
    if(seen.size!==this.bins.size)throw new Error('missing bin');const s=this.getStats();if(s.currentQty+s.deletedCurrentQty+s.pickedUnits!==s.initialQty+s.deletedInitialQty)throw new Error('inventory conservation violated');
    const catalogIds=this.catalog.map(sku=>sku.id);
    if(new Set(catalogIds).size!==this.catalog.length||this.skuMap.size!==this.catalog.length||JSON.stringify(catalogIds)!==JSON.stringify(this.config.catalogIds))throw new Error('catalog identity mismatch');
    const assignedIds=new Set();for(const b of this.bins.values()){
      if(b.weightKg>30.0001)throw new Error('bin overweight');
      const compartments=new Set();for(const id of b.skuIds){const sku=this.skuMap.get(id);
        if(!sku||assignedIds.has(id)||!sku.assigned||sku.binId!==b.id||!Number.isInteger(sku.compartment)||sku.compartment<1||sku.compartment>b.compartments||compartments.has(sku.compartment))throw new Error('bin SKU compartment mismatch');
        assignedIds.add(id);compartments.add(sku.compartment);
      }
    }
    for(const sku of this.catalog)if(this.skuMap.get(sku.id)!==sku||sku.assigned!==assignedIds.has(sku.id))throw new Error('SKU assignment mismatch');
    const robots=this.robots.filter(r=>r.available);for(let i=0;i<robots.length;i++)for(let j=i+1;j<robots.length;j++){const a=robots[i],b=robots[j],ax0=a.x-.5,ax1=a.x+.5,bx0=b.x-.5,bx1=b.x+.5,
      az0=Math.min(a.z,a.z+a.bodySign)-.5,az1=Math.max(a.z,a.z+a.bodySign)+.5,bz0=Math.min(b.z,b.z+b.bodySign)-.5,bz1=Math.max(b.z,b.z+b.bodySign)+.5;
      if(Math.min(ax1,bx1)-Math.max(ax0,bx0)>1e-7&&Math.min(az1,bz1)-Math.max(az0,bz0)>1e-7)throw new Error('two-cell robot collision');}
    return true;
  }
}
