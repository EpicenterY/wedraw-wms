import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {OrderBook} from '../dist/orders.js';
const strategies={completionTime:true,portPacing:true,timeReservations:true};
function complete(sim,book,observe=()=>{}){sim.start();let ticks=0;while(sim.running&&ticks++<12000){sim.tick(.2);book?.update();observe();if(ticks%10===0)sim.assertInvariants();}assert.ok(ticks<12000);assert.equal(sim.stalled,false);assert.ok(sim.orders.every(o=>o.status==='complete'),JSON.stringify(sim.orders.filter(o=>o.status!=='complete')));assert.equal(sim.locks.size,0);assert.equal(sim.binClaims.size,0);sim.assertInvariants();}
test('queued carriers leave both shafts clear, hold exact payloads, and never lose their delivery turn',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.98,skuCount:480,strategies,orderPrefetch:true,pickingSeconds:3}),book=new OrderBook(sim);
 book.generate(10,{combinedRatio:.4,seed:'pipeline-c'});book.submitAll();let queued=0,near=0,source=0,delivered=0;
 const assign=sim._assignJob.bind(sim);sim._assignJob=(r,j)=>{
  if(j.kind==='prelift'){
   const p=sim.ports.find(p=>p.id===j.plannedPortId),footprint=sim.footprint(j.endKey,r.bodySign);
   const approaches=new Set(sim.ports.filter(p=>p.operational).flatMap(p=>p.intakeKeys.flatMap(k=>sim.robots.filter(r=>r.available&&sim.validPosition(k,r.bodySign)).flatMap(r=>sim.footprint(k,r.bodySign)))));
   assert.ok(footprint.every(k=>!approaches.has(k)),'queue leaves full chassis approach clear');
   const distance=k=>{const[x,z]=k.split(',').map(Number);return Math.min(...p.intakeKeys.map(k=>{const[a,b]=k.split(',').map(Number);return Math.abs(x-a)*.705+Math.abs(z-b)*.480;}));};
   near+=distance(j.endKey);source+=distance(j.fromKey);queued++;
   assert.ok(!p.inletReservation||p.inletReservation.robotId!==r.id,'lifting does not reserve a shaft');
  }
  if(j.kind==='deliver'){
   if(r.job?.prepared){assert.equal(j.port.id,r.job.plannedPortId);assert.equal(j.binId,r.carryingBinId);delivered++;}
   else assert.ok(!sim.robots.some(other=>other.job?.kind==='prelift'&&other.job.plannedPortId===j.port.id),'new work must not jump a lifted queue');
  }
  return assign(r,j);
 };
 complete(sim,book,()=>{for(const r of sim.robots)if(r.job?.prepared){assert.equal(sim.bins.get(r.carryingBinId).location.robotId,r.id);assert.equal(sim.binClaims.get(r.carryingBinId),r.job.order.id);}});
 assert.ok(queued>0);assert.equal(delivered,queued);assert.ok(near<source/2,'queued carriers wait substantially closer to their target ports');
});
for(const [width,depth]of [[4,4],[5,4],[4,8]])test('prefetch and prompt returns finish in constrained '+width+'x'+depth+' layouts',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),width,depth,robotCount:4,skuCount:120,maxHeightM:1.32,
 activeCells:Array.from({length:width*depth},(_,i)=>(i%width)+','+Math.floor(i/width)),ports:[{id:'P1',x:0,z:depth-1,type:'single'},{id:'P2',x:width-1,z:0,type:'single'}],strategies,orderPrefetch:true,pickingSeconds:3});sim.enqueueRandom(6);complete(sim);
});
test('urgent promotion during picking and noncooperative jobs do not strand a standby carrier',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),skuCount:240,maxHeightM:1.32,strategies,orderPrefetch:true,pickingSeconds:8,cooperativeDigging:false}),book=new OrderBook(sim);book.generate(7,{seed:'queue-urgent'});book.submitAll();let promoted=false;
 complete(sim,book,()=>{if(!promoted&&sim.ports.some(p=>p.activeEntryId)){book.prioritize(book.orders.at(-1).id);promoted=true;}});assert.ok(promoted);assert.ok(book.orders.every(o=>o.status==='shipped'));
});

test('a lifted urgent bin can require removal of a completed bin from its planned port',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.98,skuCount:480,strategies,orderPrefetch:true,pickingSeconds:3}),book=new OrderBook(sim);book.generate(10,{combinedRatio:.4,seed:'pipeline-c'});book.submitAll();sim.start();let queued,ticks=0;
 while(sim.running&&!queued&&ticks++<4000){sim.tick(.1);book.update();queued=sim.robots.find(r=>r.job?.prepared&&sim.ports.some(p=>p.id===r.job.plannedPortId&&p.entries.length===p.capacity&&p.entries.some(e=>e.status==='outbound')&&p.entries.every(e=>sim.orders.find(o=>o.id===e.requestId)?.customerOrderId!==r.job.order.customerOrderId)));}
 assert.ok(queued);const portId=queued.job.plannedPortId,customerId=queued.job.order.customerOrderId;book.prioritize(customerId);
 const plan=sim._rpc('dispatchPlan');assert.ok(plan.tasks.some(t=>t.kind==='return'&&t.portId===portId&&t.prerequisite),JSON.stringify({portId,customerId,request:queued.job.order,access:queued.operationalPortKeys,location:sim.bins.get(queued.carryingBinId).location,planned:queued.job.plannedPortId,plan,ports:sim.ports.map(p=>({id:p.id,entries:p.entries.map(e=>({o:e.requestId,status:e.status,priority:sim.orders.find(o=>o.id===e.requestId)?.priority}))}))}));complete(sim,book);
});
test('near-port preparation also completes with conventional whole-route locks',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),skuCount:240,maxHeightM:1.32,robotCount:2,orderPrefetch:true,pickingSeconds:3});sim.enqueueRandom(6);complete(sim);
});
