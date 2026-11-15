import assert from 'node:assert/strict';
import test from 'node:test';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';

const STEP=.1,EPS=1e-7;
const urgent=(sim,skuId,qty=1)=>sim.enqueueSku(skuId,qty,{priority:'urgent',source:'inventory'});
const pending=request=>request.status==='queued'||request.status==='inProgress';
const onePort=overrides=>new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.32,
  ports:[{id:'P1',x:0,z:7,type:'buffer3'}],...overrides});

function topSkus(sim,count,exclude=new Set()){
  const p=sim.ports[0];
  const skus=[...sim.cells.values()].filter(c=>c.operational&&c.stack.length&&!exclude.has(c.key))
    .sort((a,b)=>(a.x-p.x)**2+(a.z-p.z)**2-((b.x-p.x)**2+(b.z-p.z)**2))
    .map(c=>sim.bins.get(c.stack.at(-1)).skuIds.map(id=>sim.skuMap.get(id)).sort((a,b)=>b.qty-a.qty)[0]);
  assert.ok(skus.length>=count,'fixture needs distinct accessible top bins');
  return skus.slice(0,count);
}

function deepFixture(){
  const sim=new AutoStoreSim(createDefaultConfig());
  const source=[...sim.cells.values()].filter(c=>c.operational&&c.robotIds.length>=2&&c.stack.length>=4)
    .sort((a,b)=>b.stack.length-a.stack.length)[0];
  assert.ok(source,'fixture needs a deep column accessible to several robots');
  return {sim,source,bottom:sim.bins.get(source.stack[0]),second:sim.bins.get(source.stack[1])};
}

function diagnostic(sim){
  return JSON.stringify({time:sim.time,stalled:sim.stalled,
    requests:sim.orders.map(({id,priority,status,stage,binId,pickedQty,reason})=>({id,priority,status,stage,binId,pickedQty,reason})),
    jobs:sim.robots.filter(r=>r.job).map(r=>({robot:r.id,job:r.job.id,kind:r.job.kind,request:r.job.order.id,loaded:r.carryingBinId})),
    claims:[...sim.binClaims],ports:sim.ports.map(p=>({id:p.id,cover:p.aperture.state,active:p.activeEntryId,inlet:p.inletReservation,entries:p.entries.map(e=>({request:e.requestId,status:e.status,slot:e.slot}))}))});
}

function assertPriorityStats(sim){
  const waiting=sim.orders.filter(o=>o.priority==='urgent'&&pending(o)).sort((a,b)=>a.sequence-b.sequence),s=sim.getStats();
  assert.equal(s.priorityRequestCount,waiting.length,'priority count includes retrieval, picking and bin return');
  assert.equal(s.priorityQueuedCount,waiting.filter(o=>o.status==='queued').length);
  assert.equal(s.priorityActiveCount,waiting.filter(o=>o.status==='inProgress').length);
  assert.equal(s.priorityRequest?.id??null,waiting[0]?.id??null,'the HUD follows the earliest unfinished priority request');
  if(waiting.length){
    const focus=waiting[0];
    for(const field of ['skuId','binId','stage','qty','pickedQty','portId'])assert.equal(s.priorityRequest[field],focus[field],`live priority ${field}`);
    const activeRobots=sim.robots.filter(r=>r.job?.order===focus).map(r=>r.id),involved=new Set([...focus.robotIds,...activeRobots]);
    assert.equal(new Set(s.priorityRequest.robotIds).size,s.priorityRequest.robotIds.length);
    assert.ok(s.priorityRequest.robotIds.every(id=>involved.has(id)),'HUD robot IDs belong to the focused request');
    assert.ok(activeRobots.every(id=>s.priorityRequest.robotIds.includes(id)),'the HUD includes currently assigned robots before they physically grip a bin');
    if(sim.running){assert.equal(s.systemState,'priority');assert.equal(s.systemStateLabel,'우선순위 반출 중');}
  }else assert.notEqual(s.systemState,'priority','no stale priority status after return completion');
  if(sim.paused&&!sim.running)assert.equal(s.systemState,'paused','pause remains truthful even with urgent work queued');
}

// Observe the actual scheduler and physical simulation. No planner, job or port
// state is fabricated; all fixtures reach their boundary through normal ticks.
function observe(sim){
  const trace={sim,assignments:[],picks:[],finishes:[],stock:new Map(sim.catalog.map(s=>[s.id,s.qty])),binIds:[...sim.bins.keys()].sort(),steps:0};
  const assign=sim._assignJob.bind(sim),pick=sim._startPicking.bind(sim),finish=sim._finish.bind(sim);
  sim._assignJob=(robot,job)=>{
    const record={time:sim.time,jobId:job.id,robotId:robot.id,request:job.order,kind:job.kind,binId:job.binId,
      pendingPriority:sim.orders.filter(o=>o.priority==='urgent'&&pending(o)).map(o=>o.id)};
    const value=assign(robot,job);trace.assignments.push(record);return value;
  };
  sim._startPicking=(port,entry)=>{
    assert.ok(!trace.picks.some(event=>event.requestId===entry.requestId),'each request is picked only once');
    const value=pick(port,entry);trace.picks.push({time:sim.time,portId:port.id,requestId:entry.requestId});return value;
  };
  sim._finish=robot=>{
    const record={time:sim.time,jobId:robot.job.id,requestId:robot.job.order.id,kind:robot.job.kind,binId:robot.job.binId};
    const value=finish(robot);trace.finishes.push(record);return value;
  };
  trace.step=()=>{
    const previous=sim.robots.map(r=>({x:r.x,z:r.z,y:r.gripperY,bodySign:r.bodySign,jobId:r.job?.id,binId:r.carryingBinId}));
    sim.tick(STEP);trace.steps++;
    for(let i=0;i<sim.robots.length;i++){
      const r=sim.robots[i],before=previous[i];if(!r.available)continue;
      assert.equal(r.onGrid,true);assert.equal(r.bodySign,before.bodySign);
      assert.ok(Math.hypot((r.x-before.x)*.705,(r.z-before.z)*.480)<=1.8*STEP+EPS,'priority changes cannot teleport a robot');
      assert.ok(Math.abs(r.gripperY-before.y)<=1.15*STEP+EPS,'a loaded hoist continues with bounded vertical movement');
      if(before.binId&&r.job?.id!==before.jobId)assert.ok(trace.finishes.some(e=>e.jobId===before.jobId),'a loaded mission must finish through its normal completion boundary');
      if(r.job&&r.job.kind!=='optimize')assert.equal(sim.binClaims.get(r.job.order.binId),r.job.order.id,'an active mission retains its target-bin claim');
      for(let j=i+1;j<sim.robots.length;j++){
        const other=sim.robots[j];if(!other.available)continue;
        assert.ok(Math.abs(r.x-other.x)>=1-EPS||Math.abs((r.z+r.bodySign/2)-(other.z+other.bodySign/2))>=2-EPS,'two-cell robot bodies remain separate');
      }
    }
    for(const p of sim.ports){
      assert.ok(p.entries.length<=p.capacity&&p.capacity<=3,'a priority request never creates a fourth buffer slot');
      assert.ok(p.entries.filter(e=>e.status==='picking').length<=1,'one operator access has one active pick');
      if(p.rotation){if(p.aperture.openness>0)assert.ok(p.presentation.binId&&!p.presentation.pickAllowed);assert.equal(p.activeEntryId,null);assert.equal(p.inletReservation,null);}
      if(p.activeEntryId){assert.equal(p.aperture.state,'open');assert.equal(p.aperture.openness,1);assert.equal(p.presentation.pickAllowed,true);}
    }
    const picked=new Map();
    for(const o of sim.orders){assert.ok(o.pickedQty<=o.qty);picked.set(o.skuId,(picked.get(o.skuId)||0)+o.pickedQty);}
    for(const [id,qty] of picked)assert.equal(sim.skuMap.get(id).qty+qty,trace.stock.get(id),`stock is conserved at every observed pick: ${id}`);
    assert.equal(sim.metrics.pickedUnits,[...picked.values()].reduce((a,b)=>a+b,0),'picking is never counted twice');
    assertPriorityStats(sim);
    if(trace.steps%5===0)sim.assertInvariants();
  };
  trace.until=(predicate,label,limit=15000)=>{
    let steps=0;
    while(!predicate()&&steps++<limit){assert.equal(sim.running,true,`${label}: simulation stopped before its goal. ${diagnostic(sim)}`);trace.step();}
    assert.ok(steps<limit,`${label}: no deadlock. ${diagnostic(sim)}`);
    assert.equal(sim.stalled,false,`${label}: no safety stall`);sim.assertInvariants();
  };
  return trace;
}

function finishAll(trace){
  const {sim}=trace;
  trace.until(()=>sim.orders.every(o=>o.status==='complete'),'all accepted requests complete');
  if(sim.config.idleOptimization)sim.enableIdleOptimization(false);
  trace.step();
  assert.equal(sim.running,false);assert.equal(sim.locks.size,0);assert.equal(sim.binClaims.size,0);
  assert.ok(sim.robots.every(r=>!r.job&&!r.carryingBinId));assert.ok(sim.ports.every(p=>!p.entries.length));
  assert.deepEqual([...sim.bins.keys()].sort(),trace.binIds,'no bin is created, duplicated or lost');
  for(const [id,qty] of trace.stock){
    const picked=sim.orders.filter(o=>o.skuId===id).reduce((sum,o)=>sum+o.pickedQty,0);
    assert.equal(sim.skuMap.get(id).qty+picked,qty,`exact final quantity for ${id}`);
  }
  assert.equal(trace.picks.length,sim.orders.length);sim.assertInvariants();
}

function assertNewNormalHeld(trace,index){
  const prohibited=trace.assignments.slice(index).filter(e=>e.request.priority!=='urgent'&&e.pendingPriority.length&&['dig','deliver','optimize'].includes(e.kind));
  assert.deepEqual(prohibited.map(e=>({request:e.request.id,kind:e.kind,time:e.time})),[],'no new normal retrieval or idle transfer starts while urgent work remains');
}

test('inventory priority beats older normal requests, identical-time urgent requests stay FIFO, and status lasts through bin return',()=>{
  const sim=onePort({robotCount:1,ports:[{id:'P1',x:0,z:7,type:'single'}]}),trace=observe(sim),[a,b,c]=topSkus(sim,3);
  const normal1=sim.enqueueSku(a.id,1),normal2=sim.enqueueSku(b.id,1),first=urgent(sim,c.id),second=urgent(sim,c.id);
  assert.equal(normal1.priority,'normal');assert.equal(normal2.priority,'normal');assert.equal(first.source,'inventory');
  assert.ok(sim.orders.every(o=>o.createdAt===0),'all four requests deliberately share one timestamp');
  assert.ok(sim.orders.every((o,i)=>Number.isSafeInteger(o.sequence)&&(i===0||o.sequence>sim.orders[i-1].sequence)),'stable request order is independent of timestamp resolution');
  assertPriorityStats(sim);assert.equal(sim.getStats().priorityQueuedCount,2);assert.equal(sim.start(),true);
  trace.until(()=>sim.robots.some(r=>r.job?.order===first&&r.carryingBinId),'first urgent physically loaded');
  sim.pause();assertPriorityStats(sim);
  const frozen=JSON.stringify({time:sim.time,robots:sim.getRobotVisuals(),ports:sim.getPortVisuals(),orders:sim.orders,bins:[...sim.bins.values()]});
  sim.tick(10);assert.equal(JSON.stringify({time:sim.time,robots:sim.getRobotVisuals(),ports:sim.getPortVisuals(),orders:sim.orders,bins:[...sim.bins.values()]}),frozen);
  assert.equal(sim.start(),true);
  trace.until(()=>first.pickedQty===first.qty&&first.status!=='complete','priority remains during the physical return');
  assert.equal(sim.getStats().systemState,'priority');assert.equal(sim.getStats().priorityRequest.id,first.id);
  finishAll(trace);
  const firstAssignments=trace.assignments.filter((e,i,all)=>all.findIndex(previous=>previous.request.id===e.request.id)===i).map(e=>e.request.id);
  assert.deepEqual(firstAssignments,[first.id,second.id,normal1.id,normal2.id]);
  assert.deepEqual(trace.picks.map(e=>e.requestId),[first.id,second.id,normal1.id,normal2.id]);
  assertNewNormalHeld(trace,0);
});

test('a loaded idle-optimization transfer finishes safely before subsequent urgent and normal scheduling',()=>{
  const {sim,source,bottom}=deepFixture(),trace=observe(sim);
  sim.setDemandWeights([{binId:bottom.id,orderCount:20}],{sampleSize:20});sim.enableIdleOptimization(true);assert.equal(sim.start(),true);
  trace.until(()=>sim.robots.some(r=>r.job?.kind==='optimize'&&r.carryingBinId),'real optimization blocker loaded');
  const loaded=sim.robots.find(r=>r.job?.kind==='optimize'&&r.carryingBinId),oldJob=loaded.job,oldBin=loaded.carryingBinId;
  const [a,b]=topSkus(sim,2,new Set([source.key,oldJob.toKey])),normal=sim.enqueueSku(a.id,1),priority=urgent(sim,b.id),index=trace.assignments.length;
  assert.equal(loaded.job,oldJob);assert.equal(loaded.carryingBinId,oldBin,'enqueue does not detach an in-flight bin');
  finishAll(trace);
  assert.ok(trace.finishes.some(e=>e.jobId===oldJob.id),'the existing transfer reaches its ordinary safe completion');
  assert.ok(trace.picks.findIndex(e=>e.requestId===priority.id)<trace.picks.findIndex(e=>e.requestId===normal.id));
  assertNewNormalHeld(trace,index);
});

test('urgent retrieval interrupts the next normal digging assignment while all already loaded helpers finish their missions',()=>{
  const {sim,source,bottom}=deepFixture(),trace=observe(sim),normal=sim.enqueueSku(bottom.skuIds[0],1);
  assert.equal(sim.start(),true);trace.until(()=>sim.robots.some(r=>r.job?.order===normal&&r.job.kind==='dig'&&r.carryingBinId),'normal digging blocker loaded');
  const jobs=sim.robots.filter(r=>r.job).map(r=>r.job.id),excluded=new Set([source.key,...sim.robots.filter(r=>r.job).map(r=>r.job.toKey)]);
  const [a,b]=topSkus(sim,2,excluded),anotherNormal=sim.enqueueSku(a.id,1),priority=urgent(sim,b.id),index=trace.assignments.length;
  finishAll(trace);
  for(const id of jobs)assert.ok(trace.finishes.some(e=>e.jobId===id),`existing helper ${id} finishes without cancellation or teleportation`);
  assert.equal(trace.picks[0].requestId,priority.id);assert.ok(normal.status==='complete'&&anotherNormal.status==='complete','both paused and queued normal work resumes');
  assertNewNormalHeld(trace,index);
});

for(const sameBin of [true,false])test(`${sameBin?'the same bin claim':'an older normal target in the same column'} cannot deadlock an urgent deep retrieval`,()=>{
  const {sim,source,bottom,second}=deepFixture(),trace=observe(sim);
  const normalBin=sameBin?bottom:second,normal=sim.enqueueSku(normalBin.skuIds[0],1);
  assert.equal(sim.start(),true);trace.until(()=>sim.robots.some(r=>r.job?.order===normal&&r.job.kind==='dig'&&r.carryingBinId),'normal has acquired its target claim');
  assert.equal(sim.binClaims.get(normalBin.id),normal.id);assert.equal(bottom.location.type,'grid');assert.ok(source.stack.length>=2);
  const priority=urgent(sim,bottom.skuIds[sameBin?1:0]),index=trace.assignments.length;
  finishAll(trace);
  assert.equal(trace.picks[0].requestId,priority.id,'urgent target is picked before the suspended normal target');
  assert.equal(trace.picks[1].requestId,normal.id);assertNewNormalHeld(trace,index);
});

test('a three-bin buffer finishes the active pick, then presents an arriving urgent bin before the older waiting normal bin',()=>{
  const sim=onePort(),trace=observe(sim),[a,b,c]=topSkus(sim,3),p=sim.ports[0];
  const active=sim.enqueueSku(a.id,Math.min(100,a.qty)),waiting=sim.enqueueSku(b.id,1);assert.equal(sim.start(),true);
  trace.until(()=>p.activeEntryId===active.id&&p.entries.some(e=>e.requestId===waiting.id&&e.status==='waiting'),'one normal pick and one physically waiting bin');
  const priority=urgent(sim,c.id),index=trace.assignments.length;
  trace.until(()=>p.entries.some(e=>e.requestId===priority.id&&e.status==='waiting'),'urgent bin physically received by the buffer');
  assert.equal(p.entries.length,3);assert.equal(p.activeEntryId,active.id,'the already active operator pick is not interrupted');assert.equal(active.pickedQty,0);
  finishAll(trace);
  assert.deepEqual(trace.picks.map(e=>e.requestId),[active.id,priority.id,waiting.id]);assertNewNormalHeld(trace,index);
});

test('a full three-bin port allows the required normal-bin return to create space for a new urgent delivery',()=>{
  const sim=onePort(),trace=observe(sim),[a,b,c,d]=topSkus(sim,4),p=sim.ports[0];
  const normal=[sim.enqueueSku(a.id,Math.min(100,a.qty)),sim.enqueueSku(b.id,1),sim.enqueueSku(c.id,1)];assert.equal(sim.start(),true);
  trace.until(()=>p.activeEntryId===normal[0].id&&p.entries.length===3&&p.entries.filter(e=>e.status==='waiting').length===2,'three real bins occupy the station');
  const priority=urgent(sim,d.id),index=trace.assignments.length;
  finishAll(trace);
  const urgentDelivery=trace.assignments.find(e=>e.request===priority&&e.kind==='deliver');assert.ok(urgentDelivery);
  assert.ok(trace.assignments.slice(index).some(e=>e.kind==='return'&&e.request.priority==='normal'&&e.pendingPriority.includes(priority.id)&&e.time<urgentDelivery.time),'normal return is allowed as the physical prerequisite for urgent capacity');
  assertNewNormalHeld(trace,index);
});

test('a one-robot buffer uses reachable transfer shafts for urgent capacity and for both completed-bin returns',()=>{
  const sim=onePort({robotCount:1}),trace=observe(sim),[a,b]=topSkus(sim,2),p=sim.ports[0],normal=sim.enqueueSku(a.id,1);
  assert.equal(sim.robots[0].serviceKeys.has(p.intakeBySlot[2]),true);assert.equal(sim.robots[0].serviceKeys.has(p.intakeBySlot[1]),false);
  assert.equal(sim.start(),true);
  trace.until(()=>p.entries.some(entry=>entry.requestId===normal.id&&entry.status==='waiting'&&entry.slot===2),'normal bin occupies the only reachable rear shaft');
  assert.ok(!p.entries.some(entry=>entry.slot===1),'the other rear tray is empty but this single robot cannot service it');
  const priority=urgent(sim,b.id),index=trace.assignments.length;
  finishAll(trace);
  assert.equal(priority.pickedQty,priority.qty);assert.equal(normal.pickedQty,normal.qty);
  for(const request of [normal,priority]){
    assert.equal(sim.bins.get(request.binId).location.type,'grid');
    assert.ok(trace.assignments.some(event=>event.request===request&&event.kind==='return'),'a completed pick is followed by a reachable physical return');
  }
  assertNewNormalHeld(trace,index);
});

test('a one-robot buffer stops indexing long enough to return every bin from five normal requests',()=>{
  const sim=onePort({robotCount:1}),trace=observe(sim),requests=topSkus(sim,5).map(sku=>sim.enqueueSku(sku.id,1));
  assert.equal(sim.start(),true);
  trace.until(()=>requests.every(request=>request.status==='complete'),'all five normal bins return instead of endlessly rotating',5000);
  finishAll(trace);
  assert.equal(sim.metrics.pickedUnits,5);assert.equal(sim.metrics.completedOrders,5);
  for(const request of requests){
    assert.equal(sim.bins.get(request.binId).location.type,'grid');
    assert.ok(trace.finishes.some(event=>event.requestId===request.id&&event.kind==='return'),'each ready bin receives and completes its physical return mission');
  }
});

for(const boundary of ['opening','rotation'])test(`urgent arrival during port ${boundary} preserves cover and carousel interlocks`,()=>{
  const sim=onePort(),trace=observe(sim),[a,b]=topSkus(sim,2),p=sim.ports[0],normal=sim.enqueueSku(a.id,1);assert.equal(sim.start(),true);
  trace.until(()=>boundary==='opening'?p.aperture.state==='opening':!!p.rotation,`normal presentation reaches ${boundary}`);
  assert.equal(p.activeEntryId,null);const originalRotation=p.rotation,priority=urgent(sim,b.id),index=trace.assignments.length;
  let sawOpenBeforeUrgentPick=false,sawClosingBeforeUrgentPick=false,sawRotationFinish=!originalRotation;
  const step=trace.step;
  trace.step=()=>{
    const rotating=p.rotation,elapsed=rotating?.elapsed;step();
    if(rotating===originalRotation&&originalRotation){
      if(p.rotation===originalRotation)assert.ok(p.rotation.elapsed>=elapsed,'an in-progress carousel rotation is never reversed or restarted');
      else{sawRotationFinish=true;assert.ok(originalRotation.elapsed>=originalRotation.duration-EPS,'the original indexing movement finishes normally');}
    }
    if(!trace.picks.length){sawOpenBeforeUrgentPick ||= p.aperture.state==='open';sawClosingBeforeUrgentPick ||= p.aperture.state==='closing';}
  };
  trace.until(()=>priority.pickedQty>0,`urgent completes its ${boundary} boundary pick`,15000);
  if(boundary==='opening'){
    assert.ok(sawOpenBeforeUrgentPick,'the real incoming delivery holds normal picking while its cover reaches open');
    assert.ok(sawClosingBeforeUrgentPick,'the cover closes before replacing the presented normal bin with the urgent bin');
  }else assert.ok(sawRotationFinish,'the in-flight indexing movement reaches its safe endpoint');
  assert.equal(trace.picks[0].requestId,priority.id,'a normal bin whose cover has only begun opening has not started picking');
  finishAll(trace);assertNewNormalHeld(trace,index);
});

test('an urgent request for an already active normal port bin waits for that safe pick and return, then resumes without a stale claim',()=>{
  const sim=onePort(),trace=observe(sim),[a,b]=topSkus(sim,2),p=sim.ports[0],active=sim.enqueueSku(a.id,2);assert.equal(sim.start(),true);
  trace.until(()=>p.activeEntryId===active.id,'normal bin is already accessible to the operator');
  const anotherNormal=sim.enqueueSku(b.id,1),priority=urgent(sim,a.id,1),index=trace.assignments.length;
  assert.equal(sim.binClaims.get(active.binId),active.id,'a port-owned bin cannot be reassigned before safe return');
  finishAll(trace);
  assert.deepEqual(trace.picks.map(e=>e.requestId),[active.id,priority.id,anotherNormal.id]);
  assert.ok(trace.assignments.slice(index).some(e=>e.request===active&&e.kind==='return'&&e.pendingPriority.includes(priority.id)),'the prior request may return the exact bin required by urgent work');
  assertNewNormalHeld(trace,index);
});
