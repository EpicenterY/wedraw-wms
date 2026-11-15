// Independent JS reference. v1.9 mechanical policy: flush roof and last-20% lid reveal.
/* wedraw WMS — dimension-based simulation; not an OEM controller or certified digital twin. */
import {getPortFootprint,rectanglesOverlap} from '../../dist/port-footprint.js';
import {RustNavigator,smoothMotion,smoothVelocity,motionDuration,storageCapacity} from '../../dist/rust-core.js';
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
    robotCount: 4, skuCount: 1000, seed: 20261114, reserveRatio: 0.18, cooperativeDigging: true,idleOptimization:false,
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
  const width = clamp(Math.floor(+input.width || d.width), 1, 32);
  const depth = clamp(Math.floor(+input.depth || d.depth), 1, 24);
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
  return {width,depth,maxHeightM,binHeightM,ports,activeCells,cooperativeDigging:input.cooperativeDigging!==false,idleOptimization:input.idleOptimization===true,
    compartments:Math.min([1,4,8,16].includes(+input.compartments)?+input.compartments:d.compartments,getBinSpec(binHeightM).maximumCompartments),
    robotCount:clamp(Math.floor(+input.robotCount||d.robotCount),1,MAX_ROBOTS),
    skuCount:catalogIds.length,catalogIds,nextSkuNumber,
    seed:Number.isFinite(+input.seed)?+input.seed:d.seed,
    reserveRatio:clamp(Number.isFinite(+input.reserveRatio)?+input.reserveRatio:d.reserveRatio,.10,.40),
  };
}

// Motion coordinates are metres. gripperY is the lower contact plane (bin top), binY is its centre.
const PHASE_NAMES={'idle':'상부 레일 대기','lower-empty':'그리퍼 하강','grip':'빈 체결','raise-loaded':'빈 인양','move':'상부 레일 운반','lower-loaded':'빈 하강','release':'빈 해제','raise-empty':'그리퍼 복귀','pick':'철물 피킹'};

export class AutoStoreSim {
  constructor(config={}){this.reconfigure(config);}
  reconfigure(input={}) {
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
    this.metrics={completedOrders:0,pickedUnits:0,relocations:0,travelMeters:0,robotMoves:0,totalOrderSec:0,blockedOrders:0,optimizationMoves:0};
    this._parkingCache??=new Map();this._requiredParkingCoverage=null;this._requiredOperationalCoverage=null;this._buildRegions();this._placeRobots();this._updateAccess();
    this._requiredParkingCoverage=new Set([...this.cells.values()].filter(c=>c.reachable&&!c.isEquipment).map(c=>c.key));
    this._requiredOperationalCoverage=new Set([...this.cells.values()].filter(c=>c.operational&&!c.isEquipment).map(c=>c.key));this._allocate();
    this.log('info','설정 적용',`${this.catalog.length.toLocaleString()} SKU · ${this.bins.size.toLocaleString()} 빈 · 상부 로봇 ${this.robots.filter(r=>r.available).length}대`);
    return this;
  }
  getMotionConfig(){const h=this.config.binHeightM,H=this.actualHeightM;return {stackBaseY:.015,portBaseY:WORK_HEIGHT-h,workHeightM:WORK_HEIGHT,restGripperY:H+.602,beltTopY:H+.635,beltBottomOffset:.025,binHeightM:h,binPhysical:getBinSpec(h),stackPitchM:h,gridPitchX:GRID_X,gridPitchZ:GRID_Z,railY:H};}
  _configureStations(){
    for(const p of this.ports){
      const sides=[[p.x*GRID_X,-1,0],[(this.config.width-1-p.x)*GRID_X,1,0],[p.z*GRID_Z,0,-1],[(this.config.depth-1-p.z)*GRID_Z,0,1]].sort((a,b)=>a[0]-b[0]);
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
  _parkingCoverage(robots){const coverage=new Set(),operationalCoverage=new Set(),reachByRobot=new Map(),occupied=new Set(),footprints=new Map();
    for(const r of robots){const footprint=this._motionNodes.get(r.bodySign)?.get(r.homeKey)?.footprint;if(!footprint)return {coverage,operationalCoverage,valid:false,reachByRobot};footprints.set(r,footprint);
      for(const k of footprint){if(occupied.has(k))return {coverage,operationalCoverage,valid:false,reachByRobot};occupied.add(k);}}
    for(const r of robots){const blocked=new Set(occupied);for(const k of footprints.get(r))blocked.delete(k);
      const nodes=this._reachableNodes(r.homeKey,r.bodySign,blocked),hasPort=this.ports.some(p=>p.intakeKeys.some(k=>nodes.has(k))),hasOperationalPort=this.ports.some(p=>p.operational&&p.intakeKeys.some(k=>nodes.has(k)));
      reachByRobot.set(r,nodes);if(hasPort)for(const k of nodes)if(!this.cells.get(k).isEquipment){coverage.add(k);if(hasOperationalPort)operationalCoverage.add(k);}
      if(r.requiresPort&&!hasPort||r.requiresOperationalPort&&!hasOperationalPort)return {coverage,operationalCoverage,valid:false,reachByRobot};
    }return {coverage,operationalCoverage,valid:true,reachByRobot};
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
  }
  _allocate(){const rng=mulberry32(this.config.seed+13);this.rawBinCapacity=0;this.usableBinCapacity=0;
    for(const comp of this.components){const raw=comp.storageKeys.length*this.levels,capacity=storageCapacity(comp.storageKeys.length,this.levels,this.config.reserveRatio);
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
  _blockedFor(robot){const blocked=new Set();for(const[k,owner]of this.locks)if(owner!==robot.id)blocked.add(k);
    for(const other of this.robots)if(other!==robot&&other.available){if(other.job){for(const k of other.job.locked)blocked.add(k);}else for(const k of this.footprint(keyOf(other.x,other.z),other.bodySign))blocked.add(k);}return blocked;}
  path(from,to,blocked=this.locks,bodySign=-1){
    return this._navigator.path(from,to,blocked,bodySign);
  }
  log(type,title,detail=''){this.logs.unshift({id:`L${this.revision}-${this.logs.length}-${this.time}`,time:this.time,type,title,detail});if(this.logs.length>100)this.logs.pop();}
  reservedQuantity(skuId){return this.orders.filter(o=>o.skuId===skuId&&(o.status==='queued'||o.status==='inProgress')).reduce((n,o)=>n+Math.max(0,o.qty-o.pickedQty),0);}
  availableQuantity(skuId){const s=this.skuMap.get(skuId);return s?Math.max(0,s.qty-this.reservedQuantity(skuId)):0;}
  enableIdleOptimization(enabled=true){this.config.idleOptimization=!!enabled;if(!enabled&&this.optimizationPlan){if(this.robots.some(r=>r.job?.kind==='optimize'))this.optimizationPlan.cancelAfterJob=true;else this.optimizationPlan=null;}this.revision++;return this.config.idleOptimization;}
  setDemandWeights(rows=[],{sampleSize}={}){const weights=new Map();for(const row of rows){const count=Math.max(0,Math.floor(Number(row.orderCount)||0));if(count&&this.bins.has(row.binId))weights.set(row.binId,count);}
    const signature=JSON.stringify([...weights].sort((a,b)=>a[0].localeCompare(b[0])));this.demandSampleSize=Number.isFinite(sampleSize)?Math.max(0,Math.floor(sampleSize)):[...weights.values()].reduce((a,b)=>a+b,0);
    if(signature===this._demandSignature)return;this._demandSignature=signature;this.demandWeights=weights;
    if(this.optimizationPlan){if(this.robots.some(r=>r.job?.kind==='optimize'))this.optimizationPlan.cancelAfterJob=true;else this.optimizationPlan=null;}
    this._hasOptimizationWork=!!this._findOptimizationPlan();this.revision++;
  }
  _findOptimizationPlan(){if(!this.ports.some(p=>p.operational)||!this.demandWeights.size)return null;
    const hot=[...this.demandWeights].map(([id,weight])=>{const b=this.bins.get(id),c=b?.location.type==='grid'?this.cells.get(b.location.key):null;return {b,c,weight,depth:c?c.stack.length-1-b.location.level:0};}).filter(v=>v.c?.operational&&v.depth>0).sort((a,b)=>b.weight-a.weight||b.depth-a.depth);
    for(const {b,c,weight,depth}of hot)for(const robot of this.robots){if(!robot.available||!robot.operationalPortKeys.length||!robot.serviceKeys.has(c.key))continue;
      const destinations=[...robot.serviceKeys].map(k=>this.cells.get(k)).filter(d=>d.key!==c.key&&!d.isEquipment&&d.stack.length<this.levels&&!d.stack.some(id=>this.demandWeights.get(id)>0)).map(d=>({key:d.key,height:d.stack.length,protected:false}));
      const moves=[],take=c.stack.slice(b.location.level).reverse();let feasible=true;
      for(const binId of take){const options=destinations.filter(d=>!d.protected&&d.height<this.levels).sort((x,y)=>binId===b.id?x.height-y.height:y.height-x.height);
        const dest=options[0];if(!dest){feasible=false;break;}moves.push({binId,fromKey:c.key,toKey:dest.key});dest.height++;if(this.demandWeights.get(binId)>0)dest.protected=true;}
      if(feasible)return {robotId:robot.id,targetBinId:b.id,weight,initialDepth:depth,moves,index:0,cancelAfterJob:false,order:null};
    }return null;
  }
  _dispatchOptimization(){if(!this.config.idleOptimization||this.robots.some(r=>r.job)||this.ports.some(p=>p.entries.length)||this.orders.some(o=>o.status==='queued'||o.status==='inProgress'))return;
    if(!this.optimizationPlan)this.optimizationPlan=this._findOptimizationPlan();const plan=this.optimizationPlan;this._hasOptimizationWork=!!plan;if(!plan)return;
    const move=plan.moves[plan.index],robot=this.robots.find(r=>r.id===plan.robotId),source=this.cells.get(move.fromKey),dest=this.cells.get(move.toKey);
    if(!robot||source?.stack.at(-1)!==move.binId||dest?.stack.length>=this.levels||dest.stack.some(id=>this.demandWeights.get(id)>0)){this.optimizationPlan=null;this._hasOptimizationWork=false;return;}
    plan.order??={id:`OPT${String(++this._optimizationNumber).padStart(4,'0')}`,binId:plan.targetBinId,qty:0,pickedQty:0,robotIds:[],diggingRobotIds:[],digMoves:[],activeJobId:null,activeJobIds:[],startedAt:null,createdAt:this.time,customerOrderId:null,lineId:null};
    const job=this._buildTransfer(plan.order,robot,move.binId,'grid',move.fromKey,'grid',move.toKey,{kind:'optimize'});if(job){job.optimizationPlan=plan;this._assignJob(robot,job);}
  }
  canAddSkus(){return !this.running&&!this.robots.some(r=>r.job)&&!this.ports.some(p=>p.entries.length||p.shuttle||p.rotation||p.inletReservation);}
  setSkuCount(total){total=Number(total);if(!Number.isInteger(total)||total<0||total>MAX_SKUS)throw new Error(`SKU 수는 0개부터 최대 ${MAX_SKUS.toLocaleString('ko-KR')}개까지 설정할 수 있습니다.`);
    const oldCount=this.catalog.length;
    if(total===oldCount)return {added:0,removed:0,total,assigned:0,unassigned:0};
    if(total<oldCount)return {...this.removeSkus(this.catalog.slice(total).map(sku=>sku.id)),added:0};
    if(!this.canAddSkus())throw new Error('진행 중인 로봇·포트 작업을 완료한 뒤 SKU를 추가해 주세요.');
    const count=total-oldCount,start=this.config.nextSkuNumber;
    if(!Number.isSafeInteger(start+count))throw new Error('새 SKU 식별 번호의 범위를 초과했습니다.');
    const extra=Array.from({length:count},(_,index)=>makeSku(start+index,this.config.seed));
    for(const sku of extra){this.catalog.push(sku);this.skuMap.set(sku.id,sku);}
    this.config.skuCount=total;this.config.catalogIds=this.catalog.map(sku=>sku.id);this.config.nextSkuNumber=start+count;
    const pending=this.catalog.filter(s=>!s.assigned),rng=mulberry32(this.config.seed+oldCount);let cursor=0;
    const assign=(sku,b)=>{const c=this.cells.get(b.location.key),used=new Set(b.skuIds.map(id=>this.skuMap.get(id)?.compartment));let compartment=1;while(used.has(compartment))compartment++;
      sku.binId=b.id;sku.compartment=compartment;sku.assigned=true;sku.reachable=c.reachable;sku.operational=c.operational;sku.accessReason=c.accessReason;b.skuIds.push(sku.id);};
    for(const b of this.bins.values())while(b.location.type==='grid'&&b.skuIds.length<this.config.compartments&&cursor<pending.length)assign(pending[cursor++],b);
    let number=0;for(const id of this.bins.keys())number=Math.max(number,Number(id.slice(1)));
    for(const comp of this.components){while(comp.allocated<comp.capacity&&cursor<pending.length){const options=comp.storageKeys.filter(k=>this.cells.get(k).stack.length<this.levels);if(!options.length)break;
      const k=options[Math.floor(rng()*options.length)],c=this.cells.get(k),id=`B${String(++number).padStart(4,'0')}`,b={id,skuIds:[],compartments:this.config.compartments,location:{type:'grid',key:k,x:c.x,z:c.z,level:c.stack.length,y:.015+(c.stack.length+.5)*this.config.binHeightM},weightKg:0};
      this.bins.set(id,b);c.stack.push(id);comp.allocated++;while(b.skuIds.length<this.config.compartments&&cursor<pending.length)assign(pending[cursor++],b);
    }}this.refreshWeights();this.revision++;this.log('success','철물 SKU 추가',`${oldCount.toLocaleString()} → ${total.toLocaleString()} SKU. 기존 재고·빈·주문을 유지했습니다.`);
    return {added:extra.length,removed:0,total,assigned:extra.filter(s=>s.assigned).length,unassigned:extra.filter(s=>!s.assigned).length};
  }
  addSkus(count){count=Number(count);if(!Number.isInteger(count)||count<1)throw new Error('추가할 SKU 수를 양의 정수로 입력해 주세요.');return this.setSkuCount(this.catalog.length+count);}
  removeSkus(ids){
    if(!Array.isArray(ids))throw new Error('삭제할 SKU 목록을 선택해 주세요.');
    const selected=[...new Set(ids)];
    if(selected.some(id=>typeof id!=='string'||!this.skuMap.has(id)))throw new Error('삭제할 SKU 중 현재 재고에 없는 품목이 있습니다.');
    if(!selected.length)return {removed:0,total:this.catalog.length,removedIds:[],removedQty:0};
    if(!this.canAddSkus())throw new Error('진행 중인 로봇·포트 작업을 완료한 뒤 SKU를 삭제해 주세요.');
    const targets=new Set(selected);
    if(this.orders.some(order=>targets.has(order.skuId)&&(order.status==='queued'||order.status==='inProgress')))throw new Error('대기 또는 진행 중인 피킹 요청에 포함된 SKU는 삭제할 수 없습니다.');
    const removed=this.catalog.filter(sku=>targets.has(sku.id)),removedQty=removed.reduce((sum,sku)=>sum+sku.qty,0);
    this.deletedInitialQty+=removed.reduce((sum,sku)=>sum+sku.initialQty,0);this.deletedCurrentQty+=removedQty;this.deletedSkuCount+=removed.length;
    for(const bin of this.bins.values())bin.skuIds=bin.skuIds.filter(id=>!targets.has(id));
    this.catalog=this.catalog.filter(sku=>!targets.has(sku.id));for(const id of selected)this.skuMap.delete(id);
    this.config.skuCount=this.catalog.length;this.config.catalogIds=this.catalog.map(sku=>sku.id);
    // Keep empty physical bins and the remaining compartment numbers in place.
    // Future additions fill their vacant compartments before creating new bins.
    this.refreshWeights();
    for(const bin of this.bins.values())if(!bin.skuIds.length)this.demandWeights.delete(bin.id);
    this.optimizationPlan=null;this._hasOptimizationWork=false;this.revision++;
    this.log('info','철물 SKU 삭제',`${removed.length.toLocaleString()} SKU 삭제 · 전체 ${this.catalog.length.toLocaleString()} SKU. 남은 재고·빈·피킹 기록을 유지했습니다.`);
    return {removed:removed.length,total:this.catalog.length,removedIds:selected,removedQty};
  }
  enqueueSku(skuId,qty=1,metadata={}){const sku=this.skuMap.get(skuId);if(!sku)return null;
    qty=Number(qty);if(!Number.isInteger(qty)||qty<1||qty>100000)throw new Error('출고 수량은 양의 정수여야 합니다.');
    const sequence=++this._orderNumber;
    const order={id:`O${String(sequence).padStart(4,'0')}`,sequence,priority:metadata?.priority==='urgent'?'urgent':'normal',source:metadata?.source??'order',skuId,binId:sku.binId,name:sku.name,qty,pickedQty:0,status:'queued',stage:'queued',reason:'',createdAt:this.time,startedAt:null,completedAt:null,robotId:null,robotIds:[],diggingRobotIds:[],digMoves:[],activeJobId:null,activeJobIds:[],soloRobotId:null,lastDigRobotId:null,returnKey:null,portId:null,
      customerOrderId:metadata?.customerOrderId??null,lineId:metadata?.lineId??null};
    if(!sku.assigned){order.status='blocked';order.reason='그리드 수용 공간 부족';}else if(!sku.reachable){order.status='blocked';order.reason=sku.accessReason||'2칸 로봇 접근 경로 없음';}else if(!sku.operational){order.status='blocked';order.reason=this.ports.find(p=>!p.operational)?.operationalReason||'운영 가능한 포트로 연결되지 않습니다.';}else if(this.availableQuantity(skuId)<qty){order.status='blocked';order.reason='다른 요청의 예약을 제외한 가용 재고 부족';}
    this.orders.push(order);this.revision++;if(order.status==='blocked')this.log('warning',`${order.id} 보류`,order.reason);else if(order.priority==='urgent')this.log('info','우선순위 반출 접수',`${order.id} · ${order.binId} · ${order.qty}개. 진행 중인 안전 이송 뒤 우선 배정합니다.`);return order;
  }
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
    const safe=key=>{own.homeKey=key;const result=this._parkingCoverage(layout);return result.valid&&(!required||[...required].every(k=>result.coverage.has(k)))&&(!operational||[...operational].every(k=>result.operationalCoverage.has(k)))&&soloNeeds.every(({pose,key,port})=>{
      const nodes=result.reachByRobot.get(pose);return (!key||nodes.has(key))&&(!port||port.intakeKeys.some(k=>nodes.has(k)));});};
    const sharedIntakes=new Set(this.ports.filter(p=>p.operational&&layout.some(r=>r!==own&&r.robot.operationalPortKeys?.some(k=>p.intakeKeys.includes(k)))).flatMap(p=>p.intakeKeys));
    const clearsPorts=key=>this.footprint(key,robot.bodySign).every(k=>!sharedIntakes.has(k));
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
    if(fromKind==='grid'&&(b.location.type!=='grid'||fromCell?.stack.at(-1)!==binId))return null;
    if(fromKind==='port'&&(b.location.type!=='port'||!port||!port.entries.some(e=>e.binId===binId&&e.atShaft)))return null;
    if(toKind==='grid'&&(!toCell||toCell.isEquipment||toCell.stack.length>=this.levels))return null;
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
    if(!addMove(fromKey,options.kind==='optimize'?'유휴 재배치 빈 접근':options.kind==='dig'?'협업 재배치 빈 접근':fromKind==='port'?'피킹 완료 빈 회수 접근':'출고 빈 접근'))return null;
    take(fromKind,fromKey,fromKind==='grid'?mc.stackBaseY+fromCell.stack.length*bh:port.binY+bh/2);
    if(!addMove(toKey,options.kind==='optimize'?'주문 빈도 기반 상부 배치':options.kind==='dig'?'상부 빈 분담 운반':toKind==='port'?'포트 버퍼 반출':'빈 복귀 운반'))return null;
    drop(toKind,toKey,toKind==='grid'?mc.stackBaseY+(toCell.stack.length+1)*bh:port.binY+bh/2);
    const endKey=this._transferEnd(robot,current,startKey,blocked,order,options);if(endKey===null)return null;
    // Usually the next mission starts exactly where this bin was placed. Only
    // move aside when that footprint would obstruct access or a shared intake.
    let exitBlocked=blocked;
    if(endKey!==current&&options.kind==='dig'&&this.config.cooperativeDigging){const avoidSource=new Set([...blocked,...this.footprint(fromKey,sign)]);
      if(this.path(current,endKey,avoidSource,sign))exitBlocked=avoidSource;}
    if(!addMove(endKey,'인출·통로 확보 대기',exitBlocked))return null;
    for(const k of this.footprint(current,sign))locked.add(k);
    return {id:`J${++this._jobNumber}`,kind:options.kind,binId,fromKey,toKey,startKey,endKey,ops,locked,port,portSlot:options.portSlot??null,index:0,elapsed:0,order,startedAt:this.time};
  }
  _robotsFor(order,kind){const bin=this.bins.get(order.binId),port=kind==='return'?this.ports.find(p=>p.entries.some(e=>e.requestId===order.id)):null,entry=port?.entries.find(e=>e.requestId===order.id);
    const source=kind==='return'?port?.intakeBySlot[entry?.slot]:bin?.location.type==='grid'?bin.location.key:null;
    return this.robots.filter(r=>r.available&&r.operationalPortKeys.length&&!r.job&&(!order.soloRobotId||this.config.cooperativeDigging||r.id===order.soloRobotId)).map(robot=>{
      const path=source?this.path(keyOf(robot.x,robot.z),source,this._blockedFor(robot),robot.bodySign):null;
      const distance=path?path.slice(1).reduce((sum,k,i)=>{const[x,z]=xy(k),[a,b]=xy(path[i]);return sum+Math.abs(x-a)*GRID_X+Math.abs(z-b)*GRID_Z;},0):Infinity;
      return {robot,score:distance+robot.completed*.00001+robot.index*.000001};
    }).sort((a,b)=>a.score-b.score).map(v=>v.robot);}
  _isPending(order){return order.status==='queued'||order.status==='inProgress';}
  _compareRequests(a,b){return Number(b.priority==='urgent')-Number(a.priority==='urgent')||(a.sequence??0)-(b.sequence??0);}
  _priorityRequests(){return this.orders.filter(o=>o.priority==='urgent'&&this._isPending(o)).sort((a,b)=>this._compareRequests(a,b));}
  _releaseBinClaim(order){if(this.binClaims.get(order.binId)===order.id)this.binClaims.delete(order.binId);}
  _canUsePortSlot(order,p,slot,retrieving=false){const key=p.intakeBySlot[slot],bin=this.bins.get(order.binId);if(!key||retrieving&&bin?.location.type!=='grid')return false;
    return this.robots.some(r=>r.available&&(!order.soloRobotId||this.config.cooperativeDigging||r.id===order.soloRobotId)&&r.operationalPortKeys.includes(key)&&(!retrieving||r.serviceKeys.has(bin.location.key)));}
  _portHasSpace(p,order=null){return p.entries.length<p.capacity&&(p.type==='single'?[0]:[1,2]).some(slot=>!p.entries.some(e=>(e.slot??e.destinationSlot)===slot)&&(!order||this._canUsePortSlot(order,p,slot,true)));}
  _portCanReceive(p){return p.operational&&this._portHasSpace(p)&&!p.inletReservation&&!p.shuttle&&!p.rotation;}
  _priorityPorts(order){const b=this.bins.get(order.binId);if(b?.location.type!=='grid'||order.pickedQty)return[];
    const robots=this.robots.filter(r=>r.available&&r.serviceKeys.has(b.location.key));
    return this.components[this.cells.get(b.location.key).component].ports.filter(p=>p.operational&&p.intakeKeys.some(k=>robots.some(r=>r.operationalPortKeys.includes(k))));}
  _priorityNeedsPortSpace(port,urgent){return urgent.some(order=>{if(this.ports.some(p=>p.entries.some(e=>e.requestId===order.id)))return false;const ports=this._priorityPorts(order);return ports.includes(port)&&!ports.some(p=>this._portHasSpace(p,order));});}
  _priorityPrerequisite(port,entry,urgent){return urgent.some(o=>o.binId===entry.binId)||this._priorityNeedsPortSpace(port,urgent);}
  _yieldPriorityClaims(urgent){for(const order of urgent){const claim=this.binClaims.get(order.binId);if(!claim||claim===order.id)continue;
      const owner=this.orders.find(o=>o.id===claim),bin=this.bins.get(order.binId);
      // Only a fully settled grid bin may change request ownership. A loaded
      // robot or a port entry must finish its original physical hand-off first.
      if(!owner||this._compareRequests(order,owner)>=0||owner.activeJobIds.length||bin?.location.type!=='grid'||this.ports.some(p=>p.entries.some(e=>e.requestId===owner.id)))continue;
      this._releaseBinClaim(owner);this.revision++;
    }}
  _protectedTargets(order){const keys=new Set();for(const o of this.orders)if(this._compareRequests(o,order)<0&&this._isPending(o)&&!o.pickedQty){const b=this.bins.get(o.binId);if(b?.location.type==='grid')keys.add(b.location.key);}return keys;}
  _planDig(order,robot){const target=this.bins.get(order.binId);if(target?.location.type!=='grid')return null;const source=this.cells.get(target.location.key);if(source.stack.at(-1)===target.id)return null;
    // Higher priority targets, then earlier requests at the same priority, must
    // make monotonic progress without being re-covered by later work.
    const protectedKeys=this._protectedTargets(order);if(protectedKeys.has(source.key))return null;
    const accessible=this._reachableNodes(keyOf(robot.x,robot.z),robot.bodySign,this._blockedFor(robot));if(!accessible.has(source.key))return null;
    const sourceFootprint=new Set(this.footprint(source.key,robot.bodySign));
    const binId=source.stack.at(-1),comp=this.components[source.component],destinations=comp.storageKeys.filter(k=>k!==source.key&&!protectedKeys.has(k)&&accessible.has(k)&&this.cells.get(k).stack.length<this.levels).sort((a,b)=>{
      const score=k=>{const c=this.cells.get(k),overlap=this.config.cooperativeDigging&&this.footprint(k,robot.bodySign).some(f=>sourceFootprint.has(f));return(overlap?20:0)+Math.abs(c.x-source.x)+Math.abs(c.z-source.z)+c.stack.length*.12;};return score(a)-score(b);});
    for(const dest of destinations){const job=this._buildTransfer(order,robot,binId,'grid',source.key,'grid',dest,{kind:'dig'});if(job)return job;}return null;
  }
  _planDelivery(order,robot){const b=this.bins.get(order.binId);if(b?.location.type!=='grid')return null;const c=this.cells.get(b.location.key);if(c.stack.at(-1)!==b.id)return null;
    const accessible=this._reachableNodes(keyOf(robot.x,robot.z),robot.bodySign,this._blockedFor(robot));if(!accessible.has(c.key))return null;
    const ports=this.components[c.component].ports.filter(p=>this._portCanReceive(p)&&p.intakeKeys.some(k=>accessible.has(k))).sort((a,b)=>(a.entries.length/a.capacity)*3+Math.abs(a.x-c.x)+Math.abs(a.z-c.z)-((b.entries.length/b.capacity)*3+Math.abs(b.x-c.x)+Math.abs(b.z-c.z)));
    for(const port of ports)for(const slot of port.type==='single'?[0]:[1,2]){const k=port.intakeBySlot[slot];if(!k||!accessible.has(k)||port.entries.some(e=>e.slot===slot))continue;const job=this._buildTransfer(order,robot,b.id,'grid',c.key,'port',k,{kind:'deliver',port,portSlot:slot});if(job)return job;}return null;
  }
  _planReturn(order,robot,port,entry){if(!entry.atShaft||entry.status!=='outbound'||port.inletReservation||port.shuttle||port.rotation)return null;
    const fromKey=port.intakeBySlot[entry.slot];if(!fromKey)return null;
    const accessible=this._reachableNodes(keyOf(robot.x,robot.z),robot.bodySign,this._blockedFor(robot));if(!accessible.has(fromKey))return null;
    const protectedKeys=this._protectedTargets(order),comp=this.components[this.cells.get(port.key).component],destinations=comp.storageKeys.filter(k=>!protectedKeys.has(k)&&accessible.has(k)&&this.cells.get(k).stack.length<this.levels).sort((a,b)=>{
      if(a===order.returnKey)return-1;if(b===order.returnKey)return 1;const c=this.cells.get(a),d=this.cells.get(b);return(Math.abs(c.x-port.x)+Math.abs(c.z-port.z))-(Math.abs(d.x-port.x)+Math.abs(d.z-port.z));});
    for(const dest of destinations){const job=this._buildTransfer(order,robot,entry.binId,'port',fromKey,'grid',dest,{kind:'return',port,portSlot:entry.slot});if(job)return job;}return null;
  }
  _assignJob(robot,job){const order=job.order;
    if(job.kind==='deliver'){
      const p=job.port,slot=job.portSlot;
      p.entries.push({requestId:order.id,binId:job.binId,status:'reserved',slot:null,destinationSlot:slot,atShaft:false,position:null,sequence:++p.sequence,arrivedAt:null,pickElapsed:0,pickDuration:14+order.qty*.8});
      p.inletReservation={requestId:order.id,robotId:robot.id,kind:'deliver'};order.portId=p.id;order.returnKey=job.fromKey;
    }else if(job.kind==='return')job.port.inletReservation={requestId:order.id,robotId:robot.id,kind:'return'};
    for(const k of job.locked)this.locks.set(k,robot.id);this.binClaims.set(order.binId,order.id);
    robot.job=job;robot.currentOperation=job.ops[0];robot.status=job.ops[0]?.purpose||PHASE_NAMES[job.ops[0]?.phase];robot.progress=0;
    order.status=job.kind==='optimize'?'optimizing':'inProgress';order.stage=job.kind==='optimize'?'optimizing':job.kind==='dig'?'digging':job.kind==='deliver'?'delivering':'returning';(order.activeJobIds??=[]).push(job.id);order.activeJobId=job.id;order.startedAt??=this.time;order.robotId=robot.id;
    if(!this.config.cooperativeDigging)order.soloRobotId??=robot.id;
    this._updateAccess();this._lastProgressTime=this.time;this.revision++;this.log('info',`${robot.id} · ${order.id}`,job.kind==='optimize'?`${job.binId} 유휴 재배치 · 주문 빈도 ${this.demandWeights.get(order.binId)||0}회`:job.kind==='dig'?`${job.binId} 상부 빈 분담 재배치`:job.kind==='deliver'?`${job.binId} → ${job.port.id} 인계`:`${job.port.id} → ${job.binId} 회수`);
  }
  _dispatchReturn(order,port,entry,prerequisite=false){if(entry.status!=='outbound'||order.activeJobId)return false;
    for(const r of this._robotsFor(order,'return')){const job=this._planReturn(order,r,port,entry);if(job){job.priorityPrerequisite=prerequisite;this._assignJob(r,job);return true;}}return false;}
  _dispatchRetrieval(order){if(!this._isPending(order)||order.pickedQty>0)return false;
    const active=this.robots.filter(r=>r.job?.order===order);
    // One shaft still has one occupant. Helpers may transport blockers while
    // the next robot enters only a genuinely released two-cell footprint.
    if(active.length&&(!this.config.cooperativeDigging||active.some(r=>r.job.kind!=='dig')))return false;
    const claim=this.binClaims.get(order.binId);if(claim&&claim!==order.id)return false;const b=this.bins.get(order.binId);if(b?.location.type!=='grid')return false;
    if(this.ports.some(p=>p.entries.some(e=>e.requestId===order.id)))return false;
    const c=this.cells.get(b.location.key),kind=c.stack.at(-1)===b.id?'deliver':'dig';
    for(const r of this._robotsFor(order,kind)){const job=kind==='dig'?this._planDig(order,r):this._planDelivery(order,r);if(job){this._assignJob(r,job);return true;}}return false;
  }
  _dispatch(){
    if(this._lastDispatchRevision===this.revision)return;
    const pending=this.orders.filter(o=>this._isPending(o)).sort((a,b)=>this._compareRequests(a,b)),urgent=pending.filter(o=>o.priority==='urgent');
    if(pending.length&&this.optimizationPlan){if(this.robots.some(r=>r.job?.kind==='optimize'))this.optimizationPlan.cancelAfterJob=true;else this.optimizationPlan=null;}
    if(urgent.length){
      this._yieldPriorityClaims(urgent);
      // Existing missions keep their physical reservations through safe
      // completion. Every newly free robot is offered urgent work first.
      for(const order of urgent){
        if(order.pickedQty){for(const p of this.ports){const e=p.entries.find(e=>e.requestId===order.id);if(e)this._dispatchReturn(order,p,e);}}
        else this._dispatchRetrieval(order);
      }
      // A normal bin can still need returning to make room for the urgent bin,
      // or to finish an already started request for that same physical bin.
      for(const p of this.ports)for(const e of p.entries){const order=this.orders.find(o=>o.id===e.requestId);if(order?.priority!=='urgent'&&order&&this._priorityPrerequisite(p,e,urgent))this._dispatchReturn(order,p,e,true);}
    }else{
      // Keep ordinary port throughput and arrival FIFO when no urgent work is pending.
      for(const p of this.ports)for(const e of p.entries){const order=this.orders.find(o=>o.id===e.requestId);if(order)this._dispatchReturn(order,p,e);}
      for(const order of pending)this._dispatchRetrieval(order);
    }
    let retryPriority=false;
    if(!this.robots.some(r=>r.job)&&!this.ports.some(p=>p.entries.length||p.rotation||p.shuttle)){
      // Held normal requests are not failures. Resolve an impossible priority
      // head by itself, then retry the remaining queue on the next substep.
      for(const o of urgent.length?urgent.slice(0,1):pending){o.status='blocked';o.stage='blocked';o.reason='2칸 로봇 경로 또는 재배치 공간 부족';this._releaseBinClaim(o);this.log('warning',`${o.id} 작업 보류`,o.reason);this.revision++;retryPriority=urgent.length>0;}
    }
    this._dispatchOptimization();
    this._lastDispatchRevision=retryPriority?-1:this.revision;
  }
  _operationStart(robot,op){robot.status=op.type==='move'?op.purpose:PHASE_NAMES[op.phase]||op.phase;robot.speedMps=0;if(Number.isFinite(op.fromY))robot.gripperY=op.fromY;this.revision++;}
  _operationEnd(robot,op){robot.speedMps=0;if(Number.isFinite(op.toY))robot.gripperY=op.toY;const job=robot.job,order=job.order;
    if(op.type==='grip'){
      const b=this.bins.get(op.binId);if(robot.carryingBinId)throw new Error('gripper already loaded');
      if(op.kind==='grid'){const c=this.cells.get(op.key);if(c.stack.at(-1)!==op.binId)throw new Error('only the top bin can be gripped');c.stack.pop();this._syncStack(c);}
      else{const p=this.ports.find(p=>p.id===op.portId),entry=p.entries.find(e=>e.binId===op.binId&&e.atShaft);if(!entry)throw new Error('port pickup mismatch');p.entries.splice(p.entries.indexOf(entry),1);if(p.activeEntryId===entry.requestId)throw new Error('cannot pick up active workstation bin');p.binId=null;}
      robot.carryingBinId=op.binId;b.location={type:'robot',robotId:robot.id,x:robot.x,z:robot.z,y:robot.gripperY-this.config.binHeightM/2};
      if(!order.robotIds.includes(robot.id))order.robotIds.push(robot.id);
      if(job.kind==='dig'){if(!order.diggingRobotIds.includes(robot.id))order.diggingRobotIds.push(robot.id);order.lastDigRobotId=robot.id;}
    }else if(op.type==='release'){
      if(robot.carryingBinId!==op.binId)throw new Error('release carried bin mismatch');const b=this.bins.get(op.binId);
      if(op.kind==='grid'){const c=this.cells.get(op.key);if(c.stack.length>=this.levels)throw new Error('stack capacity exceeded');c.stack.push(b.id);this._syncStack(c);
        if(job.kind==='dig'){this.metrics.relocations++;order.digMoves.push({robotId:robot.id,binId:b.id,from:job.fromKey,to:job.toKey,completedAt:this.time});this.log('success',`${robot.id} · 상부 빈 재배치`,`${order.id} · ${b.id}: ${job.fromKey} → ${job.toKey}`);}
        if(job.kind==='optimize'){this.metrics.optimizationMoves++;this.log('success',`${robot.id} · 유휴 재배치`,`${b.id}: ${job.fromKey} → ${job.toKey} · 실제 적재 완료`);}
      }else{const p=this.ports.find(p=>p.id===op.portId),entry=p.entries.find(e=>e.requestId===order.id&&e.status==='reserved');if(!entry)throw new Error('missing reserved port slot');
        entry.status='waiting';entry.slot=entry.destinationSlot;entry.atShaft=true;entry.position={x:robot.x,z:robot.z,binY:p.binY};entry.arrivedAt=this.time;
        b.location={type:'port',portId:p.id,x:robot.x,z:robot.z,y:p.binY,slot:entry.slot};p.binId=b.id;order.stage='port_queue';this.log('success',`${p.id} 빈 인계`,`${b.id} · ${p.entries.length}/${p.capacity}자리 사용`);
      }robot.carryingBinId=null;
    }else if(op.type==='move'){for(const v of op.segments)this.metrics.travelMeters+=v.distance;this.metrics.robotMoves+=op.path.length-1;[robot.x,robot.z]=xy(op.path.at(-1));robot.position={x:robot.x,z:robot.z};}
    if((op.phase==='raise-empty'||op.phase==='raise-loaded')&&op.kind==='port'){const p=this.ports.find(p=>p.id===op.portId);if(p.inletReservation?.requestId===order.id)p.inletReservation=null;}
    this._lastProgressTime=this.time;this.revision++;
  }
  _syncStack(cell){cell.stack.forEach((id,i)=>{this.bins.get(id).location={type:'grid',key:cell.key,x:cell.x,z:cell.z,level:i,y:.015+(i+.5)*this.config.binHeightM};});}
  _finish(robot){const job=robot.job,o=job.order;for(const k of job.locked)if(this.locks.get(k)===robot.id)this.locks.delete(k);o.activeJobIds=(o.activeJobIds||[]).filter(id=>id!==job.id);o.activeJobId=o.activeJobIds.at(-1)??null;
    if(job.kind==='optimize'){const plan=job.optimizationPlan;this._releaseBinClaim(o);plan.index++;
      if(job.binId===plan.targetBinId){this.optimizedBins.add(plan.targetBinId);this.log('success','주문 빈도 기반 배치 완료',`${plan.targetBinId} · 기존 깊이 ${plan.initialDepth} → 맨 위 · 주문 ${plan.weight}회`);}
      if(plan.cancelAfterJob||plan.index>=plan.moves.length){this.optimizationPlan=null;this._hasOptimizationWork=false;}
    }else if(job.kind==='return'){o.status=o.pickedQty===o.qty?'complete':'blocked';o.stage=o.status;o.completedAt=this.time;this._releaseBinClaim(o);
      if(o.status==='complete'){this.metrics.completedOrders++;this.metrics.totalOrderSec+=this.time-o.createdAt;}else o.reason='일부 수량만 피킹됨';this.log('success',`${o.id} 빈 복귀 완료`,'피킹 결과와 그리드 적재를 확인했습니다.');}
    else if(job.kind==='dig'&&!o.activeJobId&&this.bins.get(o.binId)?.location.type==='grid')o.stage='awaiting_dig';
    robot.completed++;robot.job=null;robot.currentOperation=null;robot.carryingBinId=null;robot.status=PHASE_NAMES.idle;robot.progress=0;robot.speedMps=0;this._lastProgressTime=this.time;this.revision++;
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
    let changed=false;for(const k of job.locked)if(!keep.has(k)){job.locked.delete(k);if(this.locks.get(k)===robot.id)this.locks.delete(k);changed=true;}
    if(changed)this.revision++;
  }
  _portLayout(p){return {...p.stationLayout,angle:p.rotation?smoothMotion(p.rotation.elapsed/p.rotation.duration)*p.rotation.delta*2*Math.PI/3:0,
    shafts:Object.entries(p.intakeBySlot).filter(([,k])=>k).map(([index,key])=>{const[x,z]=xy(key);return{index:Number(index),key,x,z,binY:p.binY};}),equipmentCells:p.footprintReservedKeys.map(key=>{const[x,z]=xy(key);return{key,x,z};})};}
  _slotPosition(p,index,angle=0){if(p.type==='single')return {x:p.x,z:p.z,binY:p.binY};const l=p.stationLayout,a=index*2*Math.PI/3+angle;
    return {x:l.hubX+(l.outX*Math.cos(a)+l.tanX*Math.sin(a))*l.radiusM/GRID_X,z:l.hubZ+(l.outZ*Math.cos(a)+l.tanZ*Math.sin(a))*l.radiusM/GRID_Z,binY:p.binY};}
  _portEntryPosition(p,e){return e.slot!==null?this._slotPosition(p,e.slot,this._portLayout(p).angle):e.position;}
  _setAperture(p,open){const a=p.aperture,target=open?1:0;if(a.to===target&&(a.state==='opening'||a.state==='closing'))return;
    if(a.openness===target){a.state=open?'open':'closed';return;}
    Object.assign(a,{from:a.openness,to:target,elapsed:0,duration:.8,state:open?'opening':'closing'});
    p.presentation.state=open?'opening':'closing';p.presentation.pickAllowed=false;this._lastProgressTime=this.time;this.revision++;
  }
  _rotatePort(p,delta){if(p.rotation||p.inletReservation||p.activeEntryId)throw new Error('port exchange interlock violated');
    this._setAperture(p,false);const leaving=p.entries.find(e=>e.slot===0&&e.status!=='reserved')?.binId??null;
    p.rotation={delta,elapsed:0,duration:3.2*Math.abs(delta)};p.presentation={state:p.aperture.openness>0?'closing':'hidden',binId:leaving,pickAllowed:false};p.settleElapsed=0;
    this._lastProgressTime=this.time;this.revision++;
  }
  _startPicking(p,e){if(p.aperture.state!=='open'||p.aperture.openness!==1||p.rotation||e.slot!==0)throw new Error('picking without an accessible stationary bin');
    p.activeEntryId=e.requestId;e.status='picking';e.pickElapsed=0;p.presentation={state:'presented',binId:e.binId,pickAllowed:true};
    const o=this.orders.find(o=>o.id===e.requestId);o.stage='picking';this.log('info',`${p.id} 피킹 시작`,`${o.id} · ${e.binId}`);this._lastProgressTime=this.time;this.revision++;
  }
  _nextPortWaiting(p,urgent){const requests=new Map(p.entries.map(e=>[e.requestId,this.orders.find(o=>o.id===e.requestId)])),reservedUrgent=p.entries.some(e=>e.status==='reserved'&&requests.get(e.requestId)?.priority==='urgent');
    return p.entries.filter(e=>e.status==='waiting'&&(!urgent.length||requests.get(e.requestId)?.priority==='urgent'||(!reservedUrgent&&this._priorityPrerequisite(p,e,urgent)))).sort((a,b)=>{
      const x=requests.get(a.requestId),y=requests.get(b.requestId),rank=Number(y?.priority==='urgent')-Number(x?.priority==='urgent');
      // Urgent requests keep acceptance FIFO even at simulation time zero.
      // Ordinary traffic retains the established physical-arrival FIFO.
      return rank||(x?.priority==='urgent'?this._compareRequests(x,y):a.sequence-b.sequence);
    })[0];}
  _returnPortRotation(p){const entries=p.entries.filter(e=>e.status==='ready'||e.status==='outbound').sort((a,b)=>this._compareRequests(this.orders.find(o=>o.id===a.requestId),this.orders.find(o=>o.id===b.requestId)));
    for(const e of entries){const order=this.orders.find(o=>o.id===e.requestId);
      // Once the first completed bin reaches a serviceable shaft, keep the
      // carousel still so the next dispatch can reserve its physical return.
      if(this._canUsePortSlot(order,p,e.slot))return null;
      // A rear tray can be unreachable for this request's robots. Index toward
      // an actual serviceable shaft, never just a nominally free rear slot.
      for(const delta of[1,-1])if(this._canUsePortSlot(order,p,(e.slot+delta+3)%3))return delta;
    }return null;}
  _syncPort(p){const angle=this._portLayout(p).angle;for(const e of p.entries){const b=this.bins.get(e.binId);if(b?.location.type!=='port')continue;const pos=e.slot!==null?this._slotPosition(p,e.slot,angle):e.position;if(pos)b.location={type:'port',portId:p.id,slot:e.slot,x:pos.x,z:pos.z,y:pos.binY};}
    p.binId=p.entries.find(e=>e.atShaft&&this.bins.get(e.binId)?.location.type==='port')?.binId??null;p.orderId=p.activeEntryId??p.entries.find(e=>e.atShaft)?.requestId??null;
    p.status=!p.operational?'unavailable':p.rotation?'rotating':p.aperture.state==='opening'?'opening':p.aperture.state==='closing'?'closing':p.activeEntryId?'picking':p.presentation.state==='settling'?'settling':p.entries.length?'waiting':'idle';
  }
  _tickPorts(dt){const urgent=this._priorityRequests();for(const p of this.ports){if(!p.operational){this._syncPort(p);continue;}
      const a=p.aperture;
      if(a.state==='opening'||a.state==='closing'){a.elapsed=Math.min(a.duration,a.elapsed+dt);a.openness=a.from+(a.to-a.from)*smoothMotion(a.elapsed/a.duration);
        if(a.elapsed>=a.duration-1e-8){a.openness=a.to;a.state=a.to?'open':'closed';if(!a.to)p.presentation={state:'hidden',binId:null,pickAllowed:false};this._lastProgressTime=this.time;this.revision++;}}
      if(p.rotation){const m=p.rotation;m.elapsed=Math.min(m.duration,m.elapsed+dt);
        if(p.type==='buffer3'&&smoothMotion(m.elapsed/m.duration)>=.8){const next=p.entries.find(e=>e.status==='waiting'&&e.slot!==null&&(e.slot+m.delta+3)%3===0);if(next){p.presentation.binId=next.binId;this._setAperture(p,true);p.presentation.state='approaching';p.presentation.pickAllowed=false;}}
        if(m.elapsed>=m.duration-1e-8){for(const e of p.entries)if(e.slot!==null){e.slot=(e.slot+m.delta+3)%3;e.atShaft=e.slot!==0;if(e.status==='outbound'&&e.slot===0)e.status='ready';}
          p.rotation=null;this._lastProgressTime=this.time;this.revision++;}}
      if(p.activeEntryId){const e=p.entries.find(v=>v.requestId===p.activeEntryId);if(!e)throw new Error('active port entry missing');
        if(a.state!=='open'||!p.presentation.pickAllowed||p.rotation)throw new Error('active pick lost access');
        e.pickElapsed=Math.min(e.pickDuration,e.pickElapsed+dt);
        if(e.pickElapsed>=e.pickDuration-1e-8){const o=this.orders.find(o=>o.id===e.requestId),sku=this.skuMap.get(o.skuId),q=Math.min(o.qty,sku.qty);
          if(o.pickedQty)throw new Error('request picked twice');sku.qty-=q;o.pickedQty=q;o.stage='awaiting_return';e.status='ready';p.activeEntryId=null;this.metrics.pickedUnits+=q;this.refreshWeights(e.binId);
          this._setAperture(p,false);this.log('success',`${p.id} 피킹 확인`,`${o.id} · ${sku.code} ${q}개`);this._lastProgressTime=this.time;this.revision++;}}
      // Rear trays are robot transfer positions, never an invented extra buffer.
      // A transfer reservation holds both indexing and the robot hand-off until
      // the gripper clears. Indexing requires the operator access cover closed.
      if(!p.rotation&&!p.inletReservation){
        for(const e of p.entries)if(e.status==='ready'&&(p.type==='single'?a.state==='closed':e.slot!==0)){e.status='outbound';e.atShaft=true;this.revision++;}
        if(!p.activeEntryId){
          const waiting=this._nextPortWaiting(p,urgent);
          if(waiting){
            if(waiting.slot===0){
              if(p.presentation.binId!==waiting.binId||p.presentation.state==='approaching'){p.presentation={state:'settling',binId:waiting.binId,pickAllowed:false};p.settleElapsed=0;this.revision++;}
              p.settleElapsed+=dt;
              if(p.settleElapsed>=.35){if(a.state==='open')this._startPicking(p,waiting);else if(a.state==='closed')this._setAperture(p,true);}
            }else this._rotatePort(p,waiting.slot===1?-1:1);
          }else if(p.type==='buffer3'){const delta=this._returnPortRotation(p);if(delta!==null)this._rotatePort(p,delta);else this._setAperture(p,false);}
          else this._setAperture(p,false);
        }
      }
      this._syncPort(p);
    }}
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
    jobRole:r.job?.kind??'idle',parentOrderId:r.job?.order.id??null,customerOrderId:r.job?.order.customerOrderId??null,
    hoist:{phase:r.currentOperation?.phase||'idle',gripperY:r.gripperY,binY:r.carryingBinId?r.gripperY-this.config.binHeightM/2:null,binId:r.carryingBinId,loaded:!!r.carryingBinId,
      progress:r.progress,speedMps:r.currentOperation?.type==='hoist'?r.speedMps:0,operation:r.currentOperation?.type||'idle',sourceKey:r.currentOperation?.sourceKey??null,targetKey:r.currentOperation?.targetKey??null}}));}
  getPortVisuals(){return this.ports.map(p=>{const layout=this._portLayout(p),active=p.entries.find(e=>e.requestId===p.activeEntryId),reserved=p.entries.filter(e=>e.status==='reserved').length;
      const bins=p.entries.filter(e=>this.bins.get(e.binId)?.location.type==='port').map(e=>{const pos=this._portEntryPosition(p,e);return{id:e.binId,binId:e.binId,...pos,slot:e.slot,role:e.status==='picking'?'work':e.atShaft?'intake':'buffer',status:e.status,requestId:e.requestId,progress:e.status==='picking'?e.pickElapsed/e.pickDuration:0};});
      const slots=Array.from({length:p.capacity},(_,index)=>{const e=p.entries.find(e=>e.slot===index);return{index,...this._slotPosition(p,index,layout.angle),role:index===0?'work':'buffer',binId:e?.binId??null,status:e?.status??'empty',requestId:e?.requestId??null};});
      return{id:p.id,type:p.type,x:p.x,z:p.z,capacity:p.capacity,occupied:bins.length,reserved,usedSlots:p.entries.length,presentedBinId:active?.binId??(!p.rotation?p.entries.find(e=>e.slot===0)?.binId:null)??null,
        operational:p.operational,operationalReason:p.operationalReason,footprintReservedKeys:p.footprintReservedKeys,installationBounds:p.installationBounds,
        aperture:{...p.aperture},presentation:{...p.presentation},accessibleBinId:p.aperture.state==='open'&&p.presentation.pickAllowed&&!p.rotation?active?.binId??null:null,
        activeRequestId:p.activeEntryId,status:p.status,progress:active?active.pickElapsed/active.pickDuration:p.rotation?p.rotation.elapsed/p.rotation.duration:p.shuttle?p.shuttle.elapsed/p.shuttle.duration:0,
        binBaseY:this.getMotionConfig().portBaseY,layout,bins,slots};});}
  refreshWeights(binId=null){for(const b of binId?[this.bins.get(binId)]:this.bins.values())if(b)b.weightKg=+b.skuIds.reduce((n,id)=>{const s=this.skuMap.get(id);return n+s.qty*s.unitWeightKg;},0).toFixed(3);}
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
    if(s.unassignedSkuCount)out.push(`${s.unassignedSkuCount.toLocaleString()} SKU는 공간 부족으로 미배정입니다.`);
    if(s.noPortSkuCount)out.push(`${s.noPortSkuCount.toLocaleString()} SKU가 포트 없는 구역에 있습니다.`);
    if(s.robotInaccessibleSkuCount)out.push(`${s.robotInaccessibleSkuCount.toLocaleString()} SKU는 2칸 차체·상부 대기점 때문에 출고 경로가 없습니다.`);
    if(s.unplacedRobotCount)out.push(`로봇 ${s.unplacedRobotCount}대 미배치: 안전한 2칸 상부 주차 공간이 부족합니다.`);
    if(s.blockedOrders)out.push(`${s.blockedOrders}건이 재고·2칸 경로·재배치 공간 문제로 보류되었습니다.`);if(this.stalled)out.push('상부 로봇 또는 포트 회수 경로가 막혀 시뮬레이션이 멈췄습니다.');return out;}
  snapshot(){return {config:this.config,levels:this.levels,actualHeightM:this.actualHeightM,running:this.running,time:this.time,revision:this.revision,cells:[...this.cells.values()],bins:[...this.bins.values()],robots:this.robots,ports:this.ports,orders:this.orders,stats:this.getStats(),logs:this.logs,warnings:this.getWarnings(),motion:this.getMotionConfig()};}
  assertInvariants(){const seen=new Set(),bh=this.config.binHeightM,mc=this.getMotionConfig();
    for(const c of this.cells.values()){if(c.isEquipment&&c.stack.length)throw new Error('storage inside reserved station footprint');if(c.stack.length>this.levels)throw new Error('stack capacity exceeded');for(let i=0;i<c.stack.length;i++){const id=c.stack[i];if(seen.has(id))throw new Error('duplicate bin');seen.add(id);const b=this.bins.get(id);if(b.location.type!=='grid'||b.location.key!==c.key||b.location.level!==i)throw new Error('bin location mismatch');}}
    for(const r of this.robots){if(r.carryingBinId){if(seen.has(r.carryingBinId))throw new Error('duplicate carried bin');seen.add(r.carryingBinId);const b=this.bins.get(r.carryingBinId);if(b.location.robotId!==r.id)throw new Error('carrier mismatch');if(Math.abs(b.location.y-(r.gripperY-bh/2))>1e-7)throw new Error('carried bin pose mismatch');}
      if(r.available){if(!r.onGrid||!Number.isFinite(r.x)||!Number.isFinite(r.z))throw new Error('available robot left grid');
        // Every point swept by the fixed two-cell rectangle must remain over active grid cells.
        const xLow=Math.floor(r.x+1e-8),xHigh=Math.ceil(r.x-1e-8),zLow=Math.floor(r.z+1e-8),zHigh=Math.ceil(r.z-1e-8);
        for(let x=xLow;x<=xHigh;x++)for(let z=zLow;z<=zHigh;z++){const k=keyOf(x,z);if(!this.validPosition(k,r.bodySign))throw new Error('two-cell footprint outside grid');
          if(r.job&&this.footprint(k,r.bodySign).some(f=>this.locks.get(f)!==r.id||!r.job.locked.has(f)))throw new Error('moving two-cell footprint lost its reservation');}
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
      if(p.rotation&&(p.inletReservation||p.activeEntryId||p.presentation.pickAllowed||(smoothMotion(p.rotation.elapsed/p.rotation.duration)<.8&&p.aperture.openness!==0&&!(p.aperture.state==='closing'&&p.rotation.elapsed<=.8+1e-7))))throw new Error('carousel access interlock violated');
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
