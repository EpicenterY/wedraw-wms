import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig,makeCatalog,normalizeConfig,smoothMotion,smoothVelocity,getBinSpec,MAX_SKUS} from '../dist/engine.js';
const config=createDefaultConfig();
const same=(a,b,msg)=>assert.ok(Math.abs(a-b)<1e-7,`${msg}: ${a} != ${b}`);
const stockPose=(s,id)=>{const b=s.bins.get(id);return {x:b.location.x,z:b.location.z,y:b.location.y,type:b.location.type};};

const catalog=makeCatalog();
assert.equal(catalog.length,1000);assert.equal(new Set(catalog.map(s=>s.id)).size,1000);assert.equal(new Set(catalog.map(s=>s.name)).size,1000);
assert.deepEqual(makeCatalog(1000,7),makeCatalog(1000,7));
console.log('PASS deterministic 1,000 SKU catalog');

for(const compartments of[1,4,8,16])for(const height of[.33,1.32,2.64,6]){
  const sim=new AutoStoreSim({...config,compartments,maxHeightM:height}),s=sim.getStats();
  assert.equal(s.skuCount,1000);assert.equal(s.assignedSkuCount+s.unassignedSkuCount,1000);
  assert.equal(s.levels,Math.floor((height+1e-8)/.33));assert.ok(s.actualHeightM<=height+.0001);
  assert.ok(s.binCount<=s.usableBinCapacity);assert.ok(s.assignedSkuCount<=s.capacitySkus);sim.assertInvariants();
  const mc=sim.getMotionConfig();assert.ok(mc.beltTopY-(mc.restGripperY+mc.beltBottomOffset)>=0);
  for(const r of sim.robots)assert.equal(r.onGrid,r.available);
}
assert.ok(new AutoStoreSim({...config,maxHeightM:.33}).getStats().unassignedSkuCount>0);
assert.equal(new AutoStoreSim({...config,maxHeightM:6}).getStats().unassignedSkuCount,0);
for(const binHeightM of[.22,.33,.425]){const s=new AutoStoreSim({...config,binHeightM,maxHeightM:binHeightM}),mc=s.getMotionConfig();same(mc.portBaseY+binHeightM,.96,'station working height does not shrink with grid');assert.equal(s.getStats().operational,false);assert.equal(s.getStats().operationalSkuCount,0);assert.equal(s.start(),false);assert.ok(s.getWarnings().some(w=>w.includes('최소')));s.assertInvariants();}
console.log('PASS 1 layer–6 m capacity, all bin heights, compartment weights and rail-level initial robots');

for(const [binHeightM,min,max]of[[.22,6,26],[.33,4,18],[.425,3,14]]){
  const spec=getBinSpec(binHeightM),s=new AutoStoreSim({...config,binHeightM,maxHeightM:6});
  same(spec.outsideLengthM,.649,'published outer length');same(spec.outsideWidthM,.449,'published outer width');same(spec.insideLengthM,.603,'published inside length');
  assert.equal(spec.minimumLevels,min);assert.equal(spec.maximumLevels,max);assert.equal(s.levels,max);assert.equal(s.getStats().minimumOperationalLevels,min);
  const low=new AutoStoreSim({...config,binHeightM,maxHeightM:(min-1)*binHeightM}),sku=low.catalog.find(s=>s.assigned&&s.reachable);
  assert.ok(sku);assert.equal(sku.operational,false);assert.equal(low.enqueueSku(sku.id).status,'blocked');assert.equal(low.enqueueRandom(20).length,0);assert.equal(low.start(),false);
}
assert.equal(normalizeConfig({...config,binHeightM:.425,compartments:16}).compartments,8);
const dimensions=new AutoStoreSim(config),ds=dimensions.getStats();
assert.equal(ds.storageCellCount+ds.equipmentReservedCellCount,ds.cellCount);assert.ok(ds.equipmentReservedCellCount>ds.portCount);assert.equal(ds.rawBinCapacity,ds.storageCellCount*ds.levels);
for(const p of dimensions.ports){for(const k of p.footprintReservedKeys){const c=dimensions.cells.get(k);assert.equal(c.isEquipment,true);assert.equal(c.stack.length,0);}
  for(const [index,k]of Object.entries(p.intakeBySlot)){if(!k)continue;const[x,z]=k.split(',').map(Number),pos=dimensions._slotPosition(p,Number(index));same(pos.x,x,'rear tray aligned to grid shaft x');same(pos.z,z,'rear tray aligned to grid shaft z');}
}
const inside=new AutoStoreSim({...config,ports:[{id:'P1',x:5,z:4,type:'buffer3'}]});assert.equal(inside.getStats().operational,false);assert.match(inside.getStats().operationalReason,/외부/);
const overlap=new AutoStoreSim({...config,ports:[{id:'P1',x:0,z:7,type:'buffer3'},{id:'P2',x:0,z:5,type:'buffer3'}]});assert.equal(overlap.getStats().operational,false);assert.ok(overlap.getPortVisuals().every(p=>p.operationalReason.includes('겹칩니다')));
console.log('PASS published height limits, real station height, footprint reservation, two aligned shafts and invalid installation rejection');

const empty=new AutoStoreSim({...config,activeCells:[],ports:[]});
assert.equal(empty.getStats().assignedSkuCount,0);assert.equal(empty.getStats().unassignedSkuCount,1000);assert.equal(empty.start(),false);
assert.equal(empty.robots.filter(r=>r.available).length,0);assert.equal(empty.enqueueRandom().length,0);empty.assertInvariants();
const noPort=new AutoStoreSim({...config,ports:[]});assert.equal(noPort.getStats().reachableSkuCount,0);assert.equal(noPort.start(),false);noPort.assertInvariants();
// A one-row grid cannot support a two-cell body aligned on the z axis.
const narrow=new AutoStoreSim({width:8,depth:1,maxHeightM:6,binHeightM:.33,compartments:4,robotCount:4,
  activeCells:Array.from({length:8},(_,i)=>`${i},0`),ports:[{id:'P1',x:0,z:0}]});
assert.equal(narrow.getStats().reachableSkuCount,0);assert.equal(narrow.getStats().placedRobotCount,0);assert.equal(narrow.start(),false);
assert.ok(narrow.getWarnings().some(v=>v.includes('2칸')));narrow.assertInvariants();
const disconnected=new AutoStoreSim({width:8,depth:4,maxHeightM:1.32,binHeightM:.33,compartments:4,robotCount:4,
  activeCells:['0,0','1,0','0,1','1,1','0,2','1,2','5,0','6,0','5,1','6,1','5,2','6,2'],ports:[{id:'P1',x:0,z:0}]});
assert.equal(disconnected.getStats().componentCount,2);assert.equal(disconnected.getStats().unservedSkuCount,0);assert.ok(disconnected.getStats().accessReservedCellCount>0);
const unreachable=disconnected.catalog.find(s=>!s.assigned);assert.ok(unreachable);assert.equal(disconnected.enqueueSku(unreachable.id).status,'blocked');disconnected.assertInvariants();
console.log('PASS empty, no-port, disconnected and physically impossible one-row layouts');

// The two opposite fixed orientations cover the default grid without rotating any chassis.
const initial=new AutoStoreSim(config);assert.equal(initial.getStats().reachableSkuCount,1000);
assert.ok(initial.robots.some(r=>r.bodySign===1)&&initial.robots.some(r=>r.bodySign===-1));
assert.deepEqual(initial.config.ports,[{id:'P1',x:0,z:7,type:'buffer3'},{id:'P2',x:11,z:0,type:'single'}]);
// Preserve an existing same-side port layout. Top-edge inaccessible inventory must not be claimed reachable.
const legacy=new AutoStoreSim({...config,ports:[{id:'P1',x:0,z:7},{id:'P2',x:11,z:7}]});
assert.deepEqual(legacy.config.ports,[{id:'P1',x:0,z:7,type:'single'},{id:'P2',x:11,z:7,type:'single'}]);assert.equal(legacy.getStats().robotInaccessibleSkuCount,0);assert.ok(legacy.getStats().accessReservedCellCount>0);assert.ok([...legacy.cells.values()].filter(c=>c.storageExcluded).every(c=>c.stack.length===0));legacy.assertInvariants();
console.log('PASS fixed two-cell orientations, complete default access and honest legacy-layout rejection');

same(smoothMotion(0),0,'easing start');same(smoothMotion(1),1,'easing end');same(smoothVelocity(0),0,'zero initial velocity');same(smoothVelocity(1),0,'zero final velocity');
const deep=new AutoStoreSim({...config,maxHeightM:1.32});
const column=[...deep.cells.values()].filter(c=>c.reachable&&c.stack.length>=3).sort((a,b)=>b.stack.length-a.stack.length)[0];assert.ok(column);
const target=deep.bins.get(column.stack[0]),blockedAbove=column.stack.length-1;
const order=deep.enqueueSku(target.skuIds[0],2),phases=new Set(),aperturePhases=new Set(),boundaries=[];
const originalStart=deep._operationStart.bind(deep),originalEnd=deep._operationEnd.bind(deep);
deep._operationStart=(r,op)=>{const before=r.gripperY,x=r.x,z=r.z;originalStart(r,op);same(r.gripperY,before,'continuous gripper at operation start');same(r.x,x,'no dispatch x teleport');same(r.z,z,'no dispatch z teleport');phases.add(op.phase);same(r.speedMps,0,'zero operation-boundary speed');};
deep._operationEnd=(r,op)=>{const before=op.binId?stockPose(deep,op.binId):null,gripper=r.gripperY,x=r.x,z=r.z;
  if(op.type==='grip'){assert.equal(r.carryingBinId,null);assert.equal(before.type,op.kind);}
  if(op.type==='release'){assert.equal(r.carryingBinId,op.binId);assert.equal(before.type,'robot');}
  originalEnd(r,op);same(r.gripperY,gripper,'continuous gripper at operation end');same(r.x,x,'continuous x at operation end');same(r.z,z,'continuous z at operation end');same(r.speedMps,0,'zero end velocity');
  if(op.binId){const after=stockPose(deep,op.binId);same(after.y,before.y,'bin ownership boundary y continuity');same(after.x,before.x,'bin ownership x continuity');same(after.z,before.z,'bin ownership z continuity');}
  if(op.type==='grip')assert.equal(r.carryingBinId,op.binId);if(op.type==='release')assert.equal(r.carryingBinId,null);
  boundaries.push(op.phase);
};
deep.start();let loops=0;
while(deep.running&&loops++<30000){const before=deep.getRobotVisuals();deep.tick(.025);deep.assertInvariants();const after=deep.getRobotVisuals();
  for(const p of deep.getPortVisuals()){aperturePhases.add(p.aperture.state);if(p.accessibleBinId){assert.equal(p.aperture.openness,1);assert.equal(p.presentation.pickAllowed,true);assert.equal(p.bins.filter(b=>b.id===p.accessibleBinId).length,1);}if(p.status==='rotating'){if(p.rotationProgress<.8&&p.aperture.state!=='closing')assert.equal(p.aperture.openness,0);assert.equal(p.presentation.pickAllowed,false);assert.equal(p.accessibleBinId,null);}}
  for(let i=0;i<after.length;i++){const r=after[i],p=before[i];if(!r.available)continue;
    assert.equal(r.onGrid,true);assert.equal(r.bodySign,p.bodySign,'no chassis rotation');
    assert.ok(Math.hypot((r.x-p.x)*.705,(r.z-p.z)*.480)<=1.8*.025+1e-5,'horizontal position continuous');
    assert.ok(Math.abs(r.hoist.gripperY-p.hoist.gripperY)<=1.15*.025+1e-5,'hoist position continuous');
    assert.ok(r.hoist.speedMps<=1.15+1e-7);if(r.hoist.operation!=='hoist')same(r.hoist.speedMps,0,'only vertical speed in hoist metrics');
    if(r.hoist.loaded){same(r.hoist.binY,r.hoist.gripperY-deep.config.binHeightM/2,'loaded bin follows gripper');assert.equal(deep.bins.get(r.hoist.binId).location.type,'robot');}
    const belt=deep.getMotionConfig().beltTopY-(r.hoist.gripperY+deep.getMotionConfig().beltBottomOffset);assert.ok(belt>=0);
  }
}
assert.ok(loops<30000);assert.equal(order.status,'complete');assert.ok(deep.metrics.relocations>=blockedAbove);assert.equal(deep.metrics.pickedUnits,2);
assert.deepEqual([...phases].sort(),['lower-empty','grip','raise-loaded','move','lower-loaded','release','raise-empty'].sort());
assert.deepEqual([...aperturePhases].sort(),['closed','closing','open','opening'].sort());
assert.ok(boundaries.length>20);assert.equal(deep.bins.get(target.id).location.type,'grid');
for(const r of deep.robots.filter(r=>r.available)){assert.equal(r.onGrid,true);assert.ok(deep.validPosition(`${r.x},${r.z}`,r.bodySign),'idle robot retains a valid two-cell grid position');same(r.gripperY,deep.getMotionConfig().restGripperY,'idle hoist fully raised');}
console.log('PASS every hoist phase, acceleration, contact-time ownership transfer and continuous full digging cycle');

// Growing the catalog is incremental: even completed picks and existing bin locations survive.
const previousCatalog=deep.catalog.map(s=>({...s})),previousBins=new Map([...deep.bins].map(([id,b])=>[id,JSON.stringify(b)])),previousOrders=JSON.stringify(deep.orders),previousPicked=deep.metrics.pickedUnits;
assert.equal(deep.canAddSkus(),true);assert.equal(deep.addSkus(500).added,500);assert.equal(deep.config.skuCount,1500);
assert.deepEqual(deep.catalog.slice(0,1000),previousCatalog);assert.equal(JSON.stringify(deep.orders),previousOrders);assert.equal(deep.metrics.pickedUnits,previousPicked);
for(const [id,b]of previousBins)assert.equal(JSON.stringify(deep.bins.get(id)),b);
assert.equal(new Set(deep.catalog.map(s=>s.id)).size,1500);assert.ok(deep.bins.size<=deep.usableBinCapacity);deep.assertInvariants();
const partial=new AutoStoreSim({...config,skuCount:999});const partialBin=partial.bins.get(partial.catalog.at(-1).binId),oldBinCount=partial.bins.size;
assert.equal(partialBin.skuIds.length,3);const pending=partial.enqueueSku(partial.catalog[0].id,1,{customerOrderId:'C-TEST',lineId:'LINE-1'});
assert.equal(partial.canAddSkus(),true);partial.addSkus(1);assert.equal(partial.bins.size,oldBinCount);assert.equal(partial.catalog.at(-1).binId,partialBin.id);assert.equal(partialBin.skuIds.length,4);
assert.equal(partial.orders[0],pending);assert.equal(pending.customerOrderId,'C-TEST');assert.equal(pending.lineId,'LINE-1');partial.assertInvariants();
const overflow=new AutoStoreSim({...config,maxHeightM:.33}),beforeOverflow=overflow.catalog.map(s=>({...s}));overflow.setSkuCount(10000);
assert.deepEqual(overflow.catalog.slice(0,1000),beforeOverflow);assert.equal(overflow.getStats().skuCount,10000);assert.ok(overflow.getStats().unassignedSkuCount>9000);assert.ok(overflow.bins.size<=overflow.usableBinCapacity);
assert.throws(()=>overflow.setSkuCount(MAX_SKUS+1),/100,000/);const overflowKept=overflow.catalog.slice(0,9999).map(s=>({...s}));assert.equal(overflow.setSkuCount(9999).removed,1);assert.deepEqual(overflow.catalog,overflowKept);overflow.assertInvariants();
console.log('PASS incremental SKU growth, partial compartments, preserved picks/orders/bin locations, reserve and overflow');

const reserved=new AutoStoreSim(config),reservedSku=reserved.catalog.find(s=>s.assigned&&s.reachable);
const first=reserved.enqueueSku(reservedSku.id,reservedSku.qty-1,{customerOrderId:'ORDER-A',lineId:'A-1'}),second=reserved.enqueueSku(reservedSku.id,1),overbook=reserved.enqueueSku(reservedSku.id,1);
assert.equal(first.status,'queued');assert.equal(second.status,'queued');assert.equal(overbook.status,'blocked');assert.equal(overbook.pickedQty,0);
assert.equal(reserved.reservedQuantity(reservedSku.id),reservedSku.qty);assert.equal(reserved.availableQuantity(reservedSku.id),0);
assert.equal(reserved.getSkuRows().find(s=>s.id===reservedSku.id).reservedQty,reservedSku.qty);assert.equal(first.customerOrderId,'ORDER-A');assert.equal(first.lineId,'A-1');
assert.throws(()=>reserved.enqueueSku(reservedSku.id,1.5),/정수/);assert.throws(()=>reserved.enqueueSku(reservedSku.id,0),/정수/);
console.log('PASS exact quantity reservations, overbooking rejection and customer-line metadata');

for(const cooperativeDigging of[true,false]){
  const relay=new AutoStoreSim({...config,maxHeightM:1.32,cooperativeDigging});
  const source=[...relay.cells.values()].filter(c=>c.stack.length>=3&&c.robotIds.length>=2).sort((a,b)=>b.stack.length-a.stack.length)[0];assert.ok(source);
  const target=relay.bins.get(source.stack[0]),blockers=source.stack.length-1,request=relay.enqueueSku(target.skuIds[0],1),actualCarriers=new Set();relay.start();
  let n=0;while(relay.running&&n++<10000){relay.tick(.2);for(const r of relay.robots)if(r.job?.kind==='dig'&&r.job.order===request&&r.carryingBinId)actualCarriers.add(r.id);relay.assertInvariants();}
  assert.ok(n<10000);assert.equal(request.status,'complete');assert.ok(request.digMoves.length>=blockers);assert.deepEqual(new Set(request.digMoves.map(m=>m.robotId)),actualCarriers);
  if(cooperativeDigging){assert.ok(actualCarriers.size>=2,'helpers must physically transport different blockers');assert.ok(request.diggingRobotIds.length>=2);}
  else{assert.equal(actualCarriers.size,1);assert.equal(request.robotIds.length,1,'solo mode keeps one real robot for the complete request');}
}
console.log('PASS cooperative blocker relay uses actual distinct carriers; solo mode uses one robot');

const sim=new AutoStoreSim({...config,robotCount:8,maxHeightM:1.32});sim.enqueueRandom(50);sim.start();let steps=0,maxActive=0;
while(sim.running&&steps++<30000){sim.tick(.57);maxActive=Math.max(maxActive,sim.getStats().activeRobotCount);sim.assertInvariants();}
assert.ok(steps<30000);assert.equal(sim.metrics.completedOrders,50);assert.equal(sim.orders.filter(o=>o.status==='blocked').length,0);
assert.equal(sim.locks.size,0);assert.ok(sim.robots.every(r=>!r.job&&r.onGrid===r.available));
console.log(`PASS 50 orders, ${maxActive} concurrent two-cell robots, on-grid parking and no collisions`);

const fast=new AutoStoreSim(config);fast.enqueueRandom(20);fast.start();fast.tick(3);
assert.equal(fast.canAddSkus(),false);assert.throws(()=>fast.addSkus(1),/진행 중/);
const freeze=JSON.stringify({robots:fast.getRobotVisuals(),ports:fast.getPortVisuals()}),time=fast.time;fast.pause();fast.tick(60);assert.equal(fast.time,time);assert.equal(JSON.stringify({robots:fast.getRobotVisuals(),ports:fast.getPortVisuals()}),freeze);
assert.equal(fast.canAddSkus(),false);assert.throws(()=>fast.addSkus(1),/진행 중/);
fast.start();fast.tick(7200);fast.assertInvariants();assert.equal(fast.metrics.completedOrders,20);
fast.reset();assert.equal(fast.orders.length,0);assert.equal(fast.getStats().currentQty,fast.getStats().initialQty);fast.assertInvariants();
assert.equal(normalizeConfig({...config,maxHeightM:20}).maxHeightM,6);
console.log('PASS pause, accelerated frame catch-up, 20-order run, reset and maximum height');

// Idle slotting uses real bin transfers, cannot bury another demand-weighted bin,
// yields to newly submitted picks, and remains awake without reshuffling forever.
const idle=new AutoStoreSim(config),hotSource=[...idle.cells.values()].filter(c=>c.operational&&c.stack.length>=4).sort((a,b)=>b.stack.length-a.stack.length)[0];
const hotId=hotSource.stack[0],hotOriginalKey=hotSource.key,secondHot=[...idle.cells.values()].find(c=>c.operational&&c.key!==hotSource.key&&c.stack.length)?.stack.at(-1);
idle.setDemandWeights([{binId:hotId,orderCount:20},{binId:secondHot,orderCount:5}],{sampleSize:25});idle.enableIdleOptimization(true);
assert.equal(idle.getStats().demandSampleSize,25);assert.equal(idle.getStats().hasOptimizationWork,true);assert.equal(idle.getStats().systemState,'ready');
const initialStock=idle.getStats().currentQty;
const demandDepth=()=>[...idle.demandWeights].reduce((n,[id,w])=>{const b=idle.bins.get(id);return n+(b.location.type==='grid'?w*(idle.cells.get(b.location.key).stack.length-1-b.location.level):0);},0);
const beforeDepth=demandDepth(),originalAssign=idle._assignJob.bind(idle);let injected=null,sawLoadedOptimization=false;
idle._assignJob=(r,j)=>{if(j.kind==='optimize'&&injected)assert.equal(injected.status,'complete','new warehouse work precedes any next idle transfer');return originalAssign(r,j);};
assert.equal(idle.start(),true);let idleSteps=0;
while(!sawLoadedOptimization&&idleSteps++<1000){idle.tick(.1);idle.assertInvariants();sawLoadedOptimization=idle.robots.some(r=>r.job?.kind==='optimize'&&r.carryingBinId);}
assert.ok(sawLoadedOptimization,'idle optimization must physically grip a real blocker');
idle.pause();const idleFreeze=JSON.stringify({time:idle.time,robots:idle.getRobotVisuals(),ports:idle.getPortVisuals(),bins:[...idle.bins.values()]});idle.tick(60);
assert.equal(JSON.stringify({time:idle.time,robots:idle.getRobotVisuals(),ports:idle.getPortVisuals(),bins:[...idle.bins.values()]}),idleFreeze);assert.equal(idle.getStats().systemState,'paused');idle.start();
const urgentBin=[...idle.cells.values()].filter(c=>c.operational&&c.key!==hotOriginalKey&&c.stack.length).map(c=>idle.bins.get(c.stack.at(-1))).find(b=>b.id!==secondHot);
injected=idle.enqueueSku(urgentBin.skuIds[0],1);assert.equal(injected.status,'queued');idleSteps=0;
while(idleSteps++<20000){idle.tick(.5);idle.assertInvariants();const s=idle.getStats();if(injected.status==='complete'&&s.optimizedBinCount&&s.systemState==='waiting')break;}
assert.ok(idleSteps<20000);assert.equal(injected.status,'complete');assert.equal(idle.getStats().systemState,'waiting');assert.equal(idle.running,true);
const hot=idle.bins.get(hotId);assert.notEqual(hot.location.key,hotOriginalKey);assert.equal(idle.cells.get(hot.location.key).stack.at(-1),hotId);assert.ok(demandDepth()<beforeDepth);
assert.equal(idle.metrics.pickedUnits,1);assert.equal(idle.getStats().currentQty+1,initialStock);assert.ok(idle.getStats().optimizationMoves>=2);assert.ok(idle.getStats().optimizedBinCount>=1);
const settledMoves=idle.metrics.optimizationMoves,settledPos=JSON.stringify([...idle.bins.values()].map(b=>b.location));idle.tick(180);idle.assertInvariants();
assert.equal(idle.metrics.optimizationMoves,settledMoves);assert.equal(JSON.stringify([...idle.bins.values()].map(b=>b.location)),settledPos);assert.equal(idle.getStats().hasOptimizationWork,false);
idle.enableIdleOptimization(false);idle.tick(.1);assert.equal(idle.running,false);
console.log('PASS real demand-based idle transfers, stock conservation, pause, urgent pick priority and stable operational waiting');
console.log('All inventory, collaborative robot and independent port engine checks passed.');
