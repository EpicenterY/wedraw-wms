import assert from 'node:assert/strict';
import test from 'node:test';
import {AutoStoreSim,createDefaultConfig,normalizeConfig,MAX_ROBOTS} from '../dist/engine.js';

const EPS=1e-7;
const rectangular=(width,depth,robotCount,extra={})=>new AutoStoreSim({...createDefaultConfig(),width,depth,robotCount,
  maxHeightM:1.32,skuCount:160,activeCells:Array.from({length:width*depth},(_,i)=>`${i%width},${Math.floor(i/width)}`),
  ports:[{id:'P1',x:0,z:depth-1,type:'single'},{id:'P2',x:width-1,z:0,type:'single'}],...extra});

function runToCompletion(sim,{observe=()=>{},step=.2}={}){
  const stock=new Map(sim.catalog.map(s=>[s.id,s.qty])),binIds=[...sim.bins.keys()].sort();
  assert.equal(sim.start(),true);let ticks=0;
  while(sim.running&&ticks++<15000){sim.tick(step);sim.assertInvariants();observe();}
  assert.ok(ticks<15000,'accepted requests must not deadlock behind an idle body');
  assert.equal(sim.stalled,false);assert.ok(sim.orders.every(o=>o.status==='complete'),JSON.stringify(sim.orders.filter(o=>o.status!=='complete')));
  assert.equal(sim.locks.size,0);assert.equal(sim.binClaims.size,0);
  assert.ok(sim.robots.every(r=>!r.job&&!r.carryingBinId));assert.ok(sim.ports.every(p=>!p.entries.length));
  assert.deepEqual([...sim.bins.keys()].sort(),binIds);
  for(const [id,qty]of stock)assert.equal(sim.skuMap.get(id).qty+sim.orders.filter(o=>o.skuId===id).reduce((sum,o)=>sum+o.pickedQty,0),qty);
}

test('digging resumes from the actual placement instead of returning home, with the hoist fully retracted',()=>{
  const sim=new AutoStoreSim(createDefaultConfig()),source=[...sim.cells.values()].filter(c=>c.operational&&c.robotIds.length>=2&&c.stack.length>=3).sort((a,b)=>b.stack.length-a.stack.length)[0];
  const target=sim.bins.get(source.stack[0]),request=sim.enqueueSku(target.skuIds[0],1),finished=new Map(),jobs=[];
  let directContinuation=0,sameOrderContinuation=0,maxConcurrent=0;
  const assign=sim._assignJob.bind(sim),finish=sim._finish.bind(sim),start=sim._operationStart.bind(sim);
  sim._assignJob=(robot,job)=>{
    assert.equal(job.startKey,`${robot.x},${robot.z}`,'new work starts at the physical anchor');
    assert.ok(Math.abs(robot.gripperY-sim.getMotionConfig().restGripperY)<EPS,'dispatch waits for full hoist retraction');
    assert.equal(robot.carryingBinId,null);
    const previous=finished.get(robot.id);
    if(previous?.kind==='dig'&&previous.endKey!==robot.homeKey){
      assert.equal(job.startKey,previous.endKey);directContinuation++;
      if(previous.order===job.order)sameOrderContinuation++;
    }
    jobs.push(job);return assign(robot,job);
  };
  sim._finish=robot=>{const job=robot.job,value=finish(robot);finished.set(robot.id,{kind:job.kind,endKey:job.endKey,order:job.order});assert.equal(`${robot.x},${robot.z}`,job.endKey);return value;};
  sim._operationStart=(robot,op)=>{if(op.type==='move')assert.ok(Math.abs(robot.gripperY-sim.getMotionConfig().restGripperY)<EPS,'horizontal moves cannot interrupt a hoist');return start(robot,op);};
  runToCompletion(sim,{step:.1,observe:()=>{maxConcurrent=Math.max(maxConcurrent,sim.robots.filter(r=>r.job?.order===request).length);}});
  assert.ok(directContinuation>0);assert.ok(sameOrderContinuation>0,'a recent helper remains eligible for the next nearby extraction');
  assert.ok(jobs.some(job=>job.kind==='dig'&&job.endKey===job.toKey&&job.ops.at(-1).phase==='raise-empty'),'an unobstructing placement ends exactly where the bin was put down');
  assert.ok(jobs.every(job=>job.ops.every(op=>op.purpose!=='상부 대기점 복귀')),'home is not an unconditional mission suffix');
  assert.ok(maxConcurrent>=2,'direct reuse preserves real overlapping helper work');
});

for(const [width,depth,count]of[[4,4,3],[5,4,4],[4,8,6]])test(`${width}×${depth} layout clears blocked footprints without falsely blocking accepted orders`,()=>{
  const sim=rectangular(width,depth,count);let clearances=0;
  const assign=sim._assignJob.bind(sim);sim._assignJob=(robot,job)=>{clearances+=job.ops.filter(op=>op.purpose==='인출·통로 확보 대기').length;return assign(robot,job);};
  assert.equal(sim.enqueueRandom(8).length,8);assert.ok(sim.orders.every(o=>o.status==='queued'));
  runToCompletion(sim);assert.ok(clearances>0,'tight layouts need actual reserved move-aside paths');
});

test('fixed-carrier requests keep their own target and port reachable after nearby robots move aside',()=>{
  const sim=rectangular(5,4,4,{cooperativeDigging:false});sim.enqueueRandom(12);runToCompletion(sim);
  for(const order of sim.orders){assert.equal(order.robotIds.length,1);assert.equal(order.robotIds[0],order.soloRobotId);}
});

test('30 requested robots retain honest placement limits and a larger grid can operate all 30',()=>{
  assert.equal(MAX_ROBOTS,30);assert.equal(normalizeConfig({robotCount:30}).robotCount,30);assert.equal(normalizeConfig({robotCount:31}).robotCount,30);
  const tight=rectangular(4,4,30),small=tight.getStats();assert.equal(small.robotCount,30);assert.ok(small.placedRobotCount>0&&small.placedRobotCount<30);
  assert.equal(small.placedRobotCount+small.unplacedRobotCount,30);assert.ok(tight.robots.filter(r=>!r.available).every(r=>!r.onGrid));tight.assertInvariants();
  const large=rectangular(16,12,30),stats=large.getStats();assert.equal(stats.placedRobotCount,30);assert.equal(stats.unplacedRobotCount,0);
  large.enqueueRandom(6);runToCompletion(large,{step:.5});
});
