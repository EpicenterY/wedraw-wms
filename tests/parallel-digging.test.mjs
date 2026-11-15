import assert from 'node:assert/strict';
import test from 'node:test';
import {AutoStoreSim, createDefaultConfig} from '../dist/engine.js';

const EPS=1e-7;
const poses=sim=>sim.robots.filter(r=>r.available).map(r=>({id:r.id,x:r.x,z:r.z+r.bodySign/2}));

// Check the relative swept rectangles between observations as well as the
// engine's instantaneous invariants. The fixed chassis occupies 1 × 2 cells.
function assertSweptClear(previous,current){
  for(let i=0;i<current.length;i++)for(let j=i+1;j<current.length;j++){
    let entry=0,exit=1;
    for(const [axis,extent] of [['x',1-EPS],['z',2-EPS]]){
      const start=previous[i][axis]-previous[j][axis],end=current[i][axis]-current[j][axis],delta=end-start;
      if(Math.abs(delta)<EPS){if(Math.abs(start)>=extent){exit=-1;break;}continue;}
      const a=(-extent-start)/delta,b=(extent-start)/delta;
      entry=Math.max(entry,Math.min(a,b));exit=Math.min(exit,Math.max(a,b));
    }
    assert.ok(exit<=entry+EPS,`${current[i].id} and ${current[j].id} must not cross between ticks`);
  }
}

function deepFixture(cooperativeDigging=true){
  // A genuinely deep column keeps the first blocker in flight long enough for
  // the next helper to grip a second one. The normal 2.64 m layout can finish
  // its shorter placements first, while still overlapping real helper motion.
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:3.3,cooperativeDigging});
  const source=[...sim.cells.values()].filter(c=>c.operational&&c.robotIds.length>=2&&c.stack.length>=3)
    .sort((a,b)=>b.stack.length-a.stack.length)[0];
  assert.ok(source,'fixture needs a deep column accessible by multiple robots');
  const target=sim.bins.get(source.stack[0]);
  return {sim,source,target};
}

function nextObservationStep(sim){
  let step=.1;
  // Never replace an actual right-angle turn with a diagonal interpolation:
  // observe its corner first, then check the next straight segment separately.
  for(const r of sim.robots){
    if(r.currentOperation?.type!=='move'||!r.job)continue;
    let end=0;
    for(const segment of r.currentOperation.segments){
      end+=segment.duration;const left=end-r.job.elapsed;
      if(left>1e-8){step=Math.min(step,left);break;}
    }
  }
  return step;
}

function observeRun(sim,{source,request,pauseAtOverlap=false,fixedStep=null}={}){
  const result={maxSameOrderJobs:0,maxSameOrderMoving:0,maxSameOrderLoaded:0,maxActiveOrders:0,overlapSeconds:0,pipelinedHoist:false,paused:false};
  let previous=poses(sim),steps=0;
  assert.equal(sim.start(),true);
  while(sim.running&&steps++<30000){
    const step=fixedStep??nextObservationStep(sim);sim.tick(step);sim.assertInvariants();
    const current=poses(sim);
    // Fixed-step scheduling is checked separately below. Its samples can
    // straddle corners, so only the boundary-aligned run interpolates paths.
    if(fixedStep===null)assertSweptClear(previous,current);
    previous=current;
    const active=sim.robots.filter(r=>r.job),same=active.filter(r=>r.job.order===request);
    result.maxActiveOrders=Math.max(result.maxActiveOrders,new Set(active.map(r=>r.job.order.id)).size);
    result.maxSameOrderJobs=Math.max(result.maxSameOrderJobs,same.length);
    result.maxSameOrderMoving=Math.max(result.maxSameOrderMoving,same.filter(r=>r.speedMps>EPS).length);
    result.maxSameOrderLoaded=Math.max(result.maxSameOrderLoaded,same.filter(r=>r.carryingBinId).length);
    if(same.length>1)result.overlapSeconds+=step;
    if(source){
      const taking=same.filter(r=>r.currentOperation?.sourceKey===source.key&&['lower-empty','grip','raise-loaded'].includes(r.currentOperation.phase));
      assert.ok(taking.length<=1,'only one robot can lower/grip/lift in the source shaft');
      result.pipelinedHoist ||= taking.some(next=>next.speedMps>EPS&&same.some(previous=>previous!==next&&previous.job.kind==='dig'&&previous.carryingBinId&&previous.speedMps>EPS));
    }
    if(pauseAtOverlap&&!result.paused&&same.length>1){
      sim.pause();
      const snapshot=()=>JSON.stringify({time:sim.time,robots:sim.getRobotVisuals(),ports:sim.getPortVisuals(),bins:[...sim.bins.values()],orders:sim.orders});
      const frozen=snapshot();sim.tick(30);assert.equal(snapshot(),frozen,'pause freezes every parallel job together');
      assert.equal(sim.start(),true);result.paused=true;
    }
  }
  assert.ok(steps<30000,'requests must finish without a deadlock');
  assert.equal(sim.stalled,false,'completed work must not be a safety stop');
  assert.ok(sim.orders.every(o=>o.status==='complete'),'all accepted requests complete and return their bins');
  assert.equal(sim.locks.size,0,'all route reservations are released');
  assert.equal(sim.binClaims.size,0,'no target bin claim remains after completion');
  assert.ok(sim.robots.every(r=>!r.job&&!r.carryingBinId),'no orphan parallel mission or carried bin remains');
  sim.assertInvariants();
  return {...result,time:sim.time};
}

function assertStock(sim,initial,requested){
  for(const sku of sim.catalog)assert.equal(sku.qty,initial.get(sku.id)-(requested.get(sku.id)||0),`exact final stock for ${sku.id}`);
}

test('deep-bin helpers overlap real transport and next extraction, preserve two-cell clearance, and beat solo execution',()=>{
  const results={};
  for(const cooperative of [false,true]){
    const {sim,source,target}=deepFixture(cooperative),initial=new Map(sim.catalog.map(s=>[s.id,s.qty]));
    const initialBinIds=[...sim.bins.keys()].sort(),blockers=source.stack.length-1,skuId=target.skuIds[0];
    const request=sim.enqueueSku(skuId,1);
    results[cooperative?'cooperative':'solo']=observeRun(sim,{source,request,pauseAtOverlap:cooperative});
    assert.equal(request.pickedQty,1);assert.equal(sim.metrics.pickedUnits,1);
    assert.equal(request.digMoves.length,blockers,'each original blocker is relocated once');
    assert.equal(new Set(request.digMoves.map(m=>m.binId)).size,blockers,'parallel helpers never duplicate a blocker');
    assert.deepEqual([...sim.bins.keys()].sort(),initialBinIds,'no bin is created or lost');
    assert.equal(target.location.type,'grid');assertStock(sim,initial,new Map([[skuId,1]]));
    if(cooperative){
      assert.ok(request.diggingRobotIds.length>=2,'distinct robots physically handle blockers');
      assert.ok(results.cooperative.maxSameOrderJobs>=2,'one request must have simultaneous robot work');
      assert.ok(results.cooperative.maxSameOrderMoving>=2,'multiple helpers must physically move together, not merely hold active jobs');
      assert.ok(results.cooperative.pipelinedHoist,'the next source hoist overlaps the previous blocker transport or placement');
      assert.ok(results.cooperative.paused,'pause/resume must be exercised while helpers overlap');
    }else{
      assert.equal(results.solo.maxSameOrderJobs,1);assert.equal(request.robotIds.length,1,'solo mode retains one carrier throughout');
    }
  }
  assert.ok(results.cooperative.time<results.solo.time,'parallel assistance must improve this deep-column fixture');
  console.log(`deep-bin timing: solo ${results.solo.time.toFixed(1)}s, parallel ${results.cooperative.time.toFixed(1)}s; same-order jobs ${results.cooperative.maxSameOrderJobs}, carried bins ${results.cooperative.maxSameOrderLoaded}, overlap ${results.cooperative.overlapSeconds.toFixed(1)}s`);

  // Preserve the fixed 100 ms schedule used for the reported benchmark too:
  // this schedule has a period with two distinct blockers physically loaded.
  const {sim,source,target}=deepFixture(true),initial=new Map(sim.catalog.map(s=>[s.id,s.qty]));
  const request=sim.enqueueSku(target.skuIds[0],1),fixed=observeRun(sim,{source,request,fixedStep:.1});
  assert.ok(fixed.maxSameOrderLoaded>=2,'fixed 100 ms scheduling must retain simultaneous transport of two physical bins');
  assert.ok(fixed.pipelinedHoist,'fixed-step cooperation also overlaps source hoisting with loaded transport');
  assertStock(sim,initial,new Map([[target.skuIds[0],1]]));
  console.log(`fixed 100 ms parallel timing: ${fixed.time.toFixed(1)}s; same-order jobs ${fixed.maxSameOrderJobs}, carried bins ${fixed.maxSameOrderLoaded}`);
});

test('parallel helpers coexist with other orders and repeated requests for the same bin without losing claims or stock',()=>{
  const {sim,source,target}=deepFixture(true),initial=new Map(sim.catalog.map(s=>[s.id,s.qty])),requested=new Map();
  const otherSource=[...sim.cells.values()].filter(c=>c.operational&&c.key!==source.key&&c.stack.length>=3)
    .sort((a,b)=>b.stack.length-a.stack.length)[0];
  assert.ok(otherSource);const other=sim.bins.get(otherSource.stack[0]);
  const skuIds=[target.skuIds[0],other.skuIds[0],target.skuIds[1],target.skuIds[0]];
  for(const skuId of skuIds){assert.equal(sim.enqueueSku(skuId,1).status,'queued');requested.set(skuId,(requested.get(skuId)||0)+1);}
  const result=observeRun(sim,{source,request:sim.orders[0]});
  assert.ok(result.maxActiveOrders>=2,'independent requests can make progress concurrently');
  assert.equal(sim.metrics.completedOrders,4);assert.equal(sim.metrics.pickedUnits,4);
  assertStock(sim,initial,requested);
});
