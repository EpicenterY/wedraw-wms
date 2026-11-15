import assert from 'node:assert/strict';
import test from 'node:test';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {getDiggingContext} from '../dist/digging-focus.js';

const sorted=values=>[...values].sort();
const snapshot=sim=>JSON.stringify(sim,(_key,value)=>value instanceof Map?[...value]:value instanceof Set?[...value]:value);

function readOnly(sim,ids){
  const before=snapshot(sim),context=getDiggingContext(sim,ids);
  assert.equal(snapshot(sim),before,'viewing digging requirements must not dispatch, move, reserve or pick anything');
  assert.deepEqual(getDiggingContext(sim,ids),context,'repeated reads retain the same physical facts');
  assert.equal(snapshot(sim),before,'repeated observations remain read-only');
  return context;
}

function fixture(){
  // A deeper operational stack keeps two real payloads airborne long enough
  // to observe their overlap even when the nearest relocation is very short.
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:3.3});
  const source=[...sim.cells.values()].filter(cell=>cell.operational&&cell.robotIds.length>=2&&cell.stack.length>=4)
    .sort((a,b)=>b.stack.length-a.stack.length)[0];
  assert.ok(source,'a reachable deep column is required');
  return {sim,source,target:sim.bins.get(source.stack[0])};
}

function expectedAbove(sim,binId){
  const location=sim.bins.get(binId)?.location;
  if(location?.type!=='grid')return [];
  const cell=sim.cells.get(location.key),index=cell?.stack.indexOf(binId)??-1;
  return index<0?[]:cell.stack.slice(index+1);
}

function assertPhysicalContext(sim,ids,context){
  const targetIds=new Set(ids),allAbove=new Set();
  for(const target of context.targets){
    const above=expectedAbove(sim,target.binId);
    assert.deepEqual(target.blockerBinIds,above,'remaining blockers follow the actual stack in bottom-to-top order');
    assert.equal(target.remainingCount,above.length);
    assert.equal(target.locationType,sim.bins.get(target.binId).location.type);
    for(const id of above)allAbove.add(id);
  }
  assert.equal(context.remainingBlockerCount,allAbove.size,'overlapping shafts are counted only once in the combined total');
  assert.deepEqual(sorted(context.blockerBinIds),sorted([...allAbove].filter(id=>!targetIds.has(id))));
  assert.equal(context.selectedBlockerCount,[...allAbove].filter(id=>targetIds.has(id)).length);
  const digJobs=sim.robots.filter(robot=>robot.job?.kind==='dig'&&targetIds.has(robot.job.order.binId));
  for(const robot of digJobs.filter(value=>!targetIds.has(value.job.binId)))assert.ok(context.robots.some(value=>value.robotId===robot.id),'every current upper-bin helper stays visible');
  const carriers=sim.robots.filter(robot=>targetIds.has(robot.carryingBinId));
  for(const robot of carriers)assert.ok(context.robots.some(value=>value.robotId===robot.id&&value.role==='target'),'a selected bin never loses its actual carrier after digging ends');
  assert.deepEqual(sorted(context.movingTargetBinIds),sorted(new Set(carriers.map(robot=>robot.carryingBinId))));
  const carried=digJobs.filter(robot=>robot.carryingBinId===robot.job.binId&&sim.bins.get(robot.job.binId).location.type==='robot'
    &&sim.bins.get(robot.job.binId).location.robotId===robot.id).map(robot=>robot.job.binId);
  assert.deepEqual(sorted(context.movingBlockerBinIds),sorted(new Set(carried)),'a removed blocker remains visible only while actually carried');
  for(const target of context.targets)assert.deepEqual(sorted(target.robotIds),sorted(context.robots.filter(robot=>robot.targetBinIds.includes(target.binId)).map(robot=>robot.robotId)));
  for(const detail of context.robots){
    const robot=sim.robots.find(robot=>robot.id===detail.robotId);
    assert.ok(robot?.job,'past participants with no assigned job cannot remain highlighted');
    assert.equal(detail.number,robot.id.slice(1).padStart(3,'0'));
    assert.equal(detail.relatedBinId,robot.job.binId);assert.equal(detail.taskKind,robot.job.kind);
    if(detail.role==='target'){
      assert.ok(targetIds.has(robot.job.binId));assert.equal(detail.targetBinId,robot.job.binId);
      assert.equal(detail.blockerBinId,null,'target handlers are never presented as an upper blocker');
      assert.ok(!detail.phaseLabel.includes('상부 빈'));
    }else{
      assert.equal(detail.role,'blocker');assert.equal(robot.job.kind,'dig');assert.ok(targetIds.has(robot.job.order.binId));
      assert.equal(detail.targetBinId,robot.job.order.binId);assert.equal(detail.blockerBinId,robot.job.binId);
    }
    assert.equal(detail.requestId,robot.job.order.id);
    assert.ok(detail.phaseLabel&&/[가-힣]/.test(detail.phaseLabel));
  }
}

test('digging selection reads real blockers without scheduling, tolerates absent IDs and preserves top-bin zero depth',()=>{
  const {sim,source,target}=fixture(),top=source.stack.at(-1),before=source.stack.slice();
  const context=readOnly(sim,[target.id,target.id,'MISSING',null,17,{},top]);
  assert.deepEqual(context.targetBinIds,[target.id,top]);
  assertPhysicalContext(sim,[target.id,top],context);
  assert.equal(context.targets.find(value=>value.binId===target.id).remainingCount,before.length-1);
  assert.equal(context.targets.find(value=>value.binId===top).remainingCount,0);
  assert.equal(context.selectedBlockerCount,1,'an upper selected target stays red but still physically blocks the lower target');
  assert.ok(!context.blockerBinIds.includes(top),'selected target red has precedence over grey blocker styling');
  assert.deepEqual(context.robots,[],'merely selecting a deep bin never invents or assigns a digger');
  assert.deepEqual(context.movingBlockerBinIds,[]);
  for(const ids of [[],null,undefined,{},new Set(['MISSING'])]){
    const empty=readOnly(sim,ids);
    for(const key of ['targetBinIds','targets','blockerBinIds','movingBlockerBinIds','movingTargetBinIds','robots'])assert.deepEqual(empty[key],[]);
    assert.equal(empty.remainingBlockerCount,0);assert.equal(empty.selectedBlockerCount,0);
  }
  assert.deepEqual(readOnly(sim,target.id),readOnly(sim,new Set([target.id])));
  context.targets[0].blockerBinIds.pop();context.blockerBinIds.length=0;context.targetBinIds.length=0;
  assert.deepEqual(source.stack,before,'returned arrays never alias physical stacks');
  assert.equal(readOnly(sim,[target.id]).remainingBlockerCount,before.length-1);
});

test('multiple tracked targets share one physical blocker union while retaining every per-target depth',()=>{
  const {sim,source,target}=fixture(),middle=source.stack[2],top=source.stack.at(-1);
  const other=[...sim.cells.values()].find(cell=>cell.operational&&cell.key!==source.key&&cell.stack.length>=3);
  assert.ok(other);
  const ids=[target.id,middle,top,other.stack[0]],context=readOnly(sim,ids);
  assertPhysicalContext(sim,ids,context);
  assert.equal(context.remainingBlockerCount,source.stack.length-1+other.stack.length-1);
  assert.equal(context.selectedBlockerCount,2);
  assert.equal(new Set(context.blockerBinIds).size,context.blockerBinIds.length);
  assert.ok(context.targets.reduce((sum,value)=>sum+value.remainingCount,0)>context.remainingBlockerCount,'per-target depth may overlap but the overall physical-bin count must not');
});

test('live cooperative digging continues highlighting the final target carrier through port handoff and return',()=>{
  const {sim,source,target}=fixture(),initialBlockerCount=source.stack.length-1;
  const request=sim.enqueueSku(target.skuIds[0],1);
  assert.deepEqual(readOnly(sim,[target.id]).robots,[],'queued requests are not yet assigned robots');
  assert.equal(sim.start(),true);
  let steps=0,checkpoint='',checkpoints=0,maxDiggers=0,maxCarried=0,paused=false,sawPlacedReturn=false,sawApproachBeforeGrip=false,sawTargetGripperClearing=false;
  const phases=new Set(),targetStages=new Set(),locations=new Set(),initialQty=sim.skuMap.get(target.skuIds[0]).qty;
  while(sim.running&&steps++<10000){
    sim.tick(.1);
    const next=sim.robots.map(robot=>`${robot.job?.id}:${robot.job?.index}:${robot.carryingBinId}`).join('|')+`|${target.location.type}`;
    const context=next===checkpoint?getDiggingContext(sim,[target.id]):readOnly(sim,[target.id]);
    if(next!==checkpoint){checkpoint=next;checkpoints++;}
    assertPhysicalContext(sim,[target.id],context);
    maxDiggers=Math.max(maxDiggers,context.robots.filter(robot=>robot.role==='blocker').length);maxCarried=Math.max(maxCarried,context.movingBlockerBinIds.length);
    locations.add(target.location.type);
    for(const detail of context.robots){
      if(detail.role==='target'){targetStages.add(`${detail.taskKind}:${detail.phase}`);continue;}
      phases.add(detail.phase);
      const robot=sim.robots.find(robot=>robot.id===detail.robotId),operation=robot.job.ops[robot.job.index]||robot.currentOperation;
      if(detail.phase==='approaching'){
        assert.equal(operation.type,'move');assert.equal(robot.carryingBinId,null);
        assert.ok(context.targets[0].blockerBinIds.includes(detail.blockerBinId),'an assigned but ungripped blocker remains in the actual stack count');
        sawApproachBeforeGrip=true;
      }
      if(detail.phase==='extracting')assert.ok(['lower-empty','grip','raise-loaded'].includes(operation.phase));
      if(detail.phase==='relocating'){assert.equal(operation.type,'move');assert.equal(robot.carryingBinId,detail.blockerBinId);}
      if(detail.phase==='placing')assert.ok(['lower-loaded','release'].includes(operation.phase));
      if(detail.phase==='returning'){
        assert.equal(robot.carryingBinId,null);assert.ok(!context.movingBlockerBinIds.includes(detail.blockerBinId));
        assert.equal(sim.bins.get(detail.blockerBinId).location.type,'grid');sawPlacedReturn=true;
      }
    }
    if(target.location.type!=='grid'){
      assert.equal(context.targets[0].remainingCount,0);assert.deepEqual(context.targets[0].blockerBinIds,[]);
    }
    for(const robot of sim.robots.filter(robot=>robot.job?.order===request&&robot.job.kind!=='dig')){
      const job=robot.job,op=job.ops[job.index],release=job.ops.findIndex(value=>value.type==='release'),emptyExit=!robot.carryingBinId&&job.index>release&&op.type==='move';
      const detail=context.robots.find(value=>value.robotId===robot.id);
      if(emptyExit)assert.equal(detail,undefined,'after the gripper clears, an empty traffic/parking move is no longer the tracked bin carrier');
      else{
        assert.equal(detail?.role,'target','the actual final handler stays highlighted during extraction, delivery and return');
        assert.equal(detail.relatedBinId,target.id);assert.equal(detail.blockerBinId,null);
        if(op.phase==='raise-empty')sawTargetGripperClearing=true;
      }
    }
    if(context.robots.length>1&&!paused){
      sim.pause();const before=readOnly(sim,[target.id]);sim.tick(30);
      assert.deepEqual(readOnly(sim,[target.id]),before,'paused work preserves exact live ownership and assigned helpers');
      assert.deepEqual(readOnly(sim,[]).robots,[],'clearing selection removes every helper without changing its job');
      const unrelated=[...sim.cells.values()].find(cell=>cell.operational&&cell.key!==source.key&&cell.stack.length).stack[0];
      assert.deepEqual(readOnly(sim,[unrelated]).robots,[],'changing the selection cannot retain old highlighted helpers');
      sim.start();paused=true;
    }
    assert.equal(sim.skuMap.get(target.skuIds[0]).qty,initialQty-request.pickedQty);
    if(steps%25===0)sim.assertInvariants();
  }
  assert.ok(steps<10000);assert.equal(sim.stalled,false);assert.equal(request.status,'complete');
  assert.ok(maxDiggers>=2,'real cooperative extraction must show multiple assigned diggers together');
  assert.ok(maxCarried>=2,'the 100 ms schedule includes two real blockers carried at once');
  assert.ok(paused&&sawApproachBeforeGrip&&sawPlacedReturn&&sawTargetGripperClearing);
  assert.deepEqual(sorted(phases),['approaching','extracting','placing','relocating','returning']);
  for(const kind of ['deliver','return'])for(const phase of ['extracting','relocating','placing','returning'])assert.ok(targetStages.has(`${kind}:${phase}`),`${kind} ${phase} remains highlighted`);
  assert.deepEqual(sorted(locations),['grid','port','robot']);
  assert.ok(checkpoints>20,'read-only assertions cover every distinct operation and ownership transition');
  assert.equal(request.digMoves.length,initialBlockerCount);
  assert.ok(request.diggingRobotIds.length>=2,'historical participants exist after the actual dig ends');
  const complete=readOnly(sim,[target.id]);assert.deepEqual(complete.robots,[]);assert.deepEqual(complete.movingBlockerBinIds,[]);
  assertPhysicalContext(sim,[target.id],complete);sim.assertInvariants();
});

test('concurrent requests highlight their own current diggers and combine only when both targets are selected',()=>{
  const {sim,source,target}=fixture();
  const otherCell=[...sim.cells.values()].filter(cell=>cell.operational&&cell.key!==source.key&&cell.stack.length>=3)
    .sort((a,b)=>b.stack.length-a.stack.length)[0];
  const other=sim.bins.get(otherCell.stack[0]);
  const first=sim.enqueueSku(target.skuIds[0],1),second=sim.enqueueSku(other.skuIds[0],1);
  sim.start();let found=false;
  for(let steps=0;sim.running&&steps<3000;steps++){
    sim.tick(.1);
    if(!sim.robots.some(robot=>robot.job?.kind==='dig'&&robot.job.order===first)||!sim.robots.some(robot=>robot.job?.kind==='dig'&&robot.job.order===second))continue;
    const left=readOnly(sim,[target.id]),right=readOnly(sim,[other.id]),both=readOnly(sim,[target.id,other.id]);
    assertPhysicalContext(sim,[target.id],left);assertPhysicalContext(sim,[other.id],right);assertPhysicalContext(sim,[target.id,other.id],both);
    assert.ok(left.robots.every(robot=>robot.requestId===first.id));assert.ok(right.robots.every(robot=>robot.requestId===second.id));
    assert.deepEqual(sorted(both.robots.map(robot=>robot.robotId)),sorted([...left.robots,...right.robots].map(robot=>robot.robotId)));
    found=true;break;
  }
  assert.ok(found,'the real engine must reach independent active diggers for both requests');sim.assertInvariants();
});

test('only the actual selected optimization payload highlights its carrier without inventing an outbound assignment',()=>{
  const {sim,target}=fixture();
  sim.setDemandWeights([{binId:target.id,orderCount:20}],{sampleSize:20});sim.enableIdleOptimization(true);sim.start();
  let loaded=null;
  for(let steps=0;sim.running&&steps<1500;steps++){
    sim.tick(.1);loaded=sim.robots.find(robot=>robot.job?.kind==='optimize'&&robot.carryingBinId);if(loaded)break;
  }
  assert.ok(loaded,'the fixture must physically carry an optimization blocker');
  const context=readOnly(sim,[target.id]);assertPhysicalContext(sim,[target.id],context);
  assert.deepEqual(context.robots,[]);assert.deepEqual(context.movingBlockerBinIds,[]);
  const payload=loaded.carryingBinId,carried=readOnly(sim,[payload,target.id]);assertPhysicalContext(sim,[payload,target.id],carried);
  assert.equal(carried.robots.length,1);assert.equal(carried.robots[0].robotId,loaded.id);
  assert.equal(carried.robots[0].role,'target');assert.equal(carried.robots[0].taskKind,'optimize');
  assert.equal(carried.robots[0].relatedBinId,payload);assert.match(carried.robots[0].phaseLabel,/최적화/);
  assert.ok(!carried.robots[0].phaseLabel.includes('반출'));assert.deepEqual(carried.movingTargetBinIds,[payload]);
  while(loaded.carryingBinId)sim.tick(.1);
  assert.deepEqual(readOnly(sim,[payload]).robots,[],'an optimizer stops being the actual payload carrier when it releases the selected bin');
  sim.assertInvariants();
});

test('a top-level selected bin highlights its assigned final robot before the first grip without any digging',()=>{
  const sim=new AutoStoreSim(createDefaultConfig());
  const cell=[...sim.cells.values()].find(value=>value.operational&&value.stack.length&&!sim.robots.some(robot=>robot.x===value.x&&robot.z===value.z));
  const target=sim.bins.get(cell.stack.at(-1)),request=sim.enqueueSku(target.skuIds[0],1);
  assert.deepEqual(readOnly(sim,[target.id]).robots,[]);sim.start();sim.tick(.1);
  const robot=sim.robots.find(value=>value.job?.order===request),context=readOnly(sim,[target.id]);
  assert.ok(robot);assert.equal(robot.job.kind,'deliver');assert.equal(robot.carryingBinId,null);
  assertPhysicalContext(sim,[target.id],context);assert.equal(context.remainingBlockerCount,0);
  assert.equal(context.robots.length,1);assert.equal(context.robots[0].role,'target');assert.equal(context.robots[0].phase,'approaching');
  assert.match(context.robots[0].phaseLabel,/목표 빈/);assert.deepEqual(context.movingBlockerBinIds,[]);
  sim.assertInvariants();
});
