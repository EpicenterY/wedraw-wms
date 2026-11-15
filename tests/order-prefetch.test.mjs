import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {OrderBook} from '../dist/orders.js';
const strategies={completionTime:true,portPacing:true,timeReservations:true};
function finish(sim,book,observe=()=>{}){
 let ticks=0;while(sim.running&&ticks++<16000){sim.tick(.5);book?.update();if(ticks%20===0)sim.assertInvariants();observe();}
 assert.ok(ticks<16000);assert.equal(sim.stalled,false);assert.ok(sim.orders.every(o=>o.status==='complete'));sim.assertInvariants();
 assert.equal(sim.locks.size,0);assert.equal(sim.binClaims.size,0);
}
test('picking seconds update queued and active entries without changing progress or quantity',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.32,skuCount:180,pickingSeconds:15});
 const sku=sim.catalog.find(s=>s.operational&&s.qty>=2),initial=sku.qty;sim.enqueueSku(sku.id,2);sim.start();
 let entry,ticks=0;while(!entry&&ticks++<6000){sim.tick(.2);entry=sim.ports.flatMap(p=>p.entries).find(e=>e.status==='picking');}
 assert.ok(entry);sim.tick(3);assert.equal(entry.pickDuration,30);const ratio=entry.pickElapsed/entry.pickDuration;
 sim.pause();const time=sim.time;sim.setPickingSeconds(3);assert.equal(sim.time,time);assert.equal(sim.running,false);
 assert.equal(entry.pickDuration,6);assert.ok(Math.abs(entry.pickElapsed/entry.pickDuration-ratio)<1e-9);assert.equal(sku.qty,initial);
 for(const value of[0,-1,61,NaN,Infinity])assert.throws(()=>sim.setPickingSeconds(value));
 assert.throws(()=>sim._rpc('setPickingSeconds',{seconds:0}));assert.equal(sim.config.pickingSeconds,3);
 sim.start();finish(sim);assert.equal(sku.qty,initial-2);assert.equal(sim.metrics.pickedUnits,2);
 sim.reset();assert.equal(sim.config.pickingSeconds,3);
});
test('normal items have no customer-list order gate; urgent stays first',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),orderPrefetch:true,pickingSeconds:3}),book=new OrderBook(sim);
 book.generate(6,{combinedRatio:0,seed:'list-order'});for(const order of [...book.orders].reverse())book.submit(order.id);
 const ids=()=>sim._rpc('dispatchPlan').tasks.filter(t=>t.kind==='retrieve').map(t=>sim.orders.find(o=>o.id===t.orderId).customerOrderId);
 assert.deepEqual(ids(),[...book.orders].reverse().map(o=>o.id));book.prioritize(book.orders.at(-1).id);assert.equal(ids()[0],book.orders.at(-1).id);
 sim.setOrderPrefetch(false);assert.equal(sim.config.orderPrefetch,false);
});
for(const seconds of[.5,3,15])test('independent preparation finishes combined demand and respects buffer capacity at '+seconds+'s/unit',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.98,skuCount:480,strategies,orderPrefetch:true,pickingSeconds:seconds}),book=new OrderBook(sim);
 book.generate(8,{seed:'prefetch-mixed'});book.submitAll();const initial=new Map(sim.catalog.map(s=>[s.id,s.qty]));let overlap=false,toggled=false;
 sim.start();finish(sim,book,()=>{for(const p of sim.ports)assert.ok(p.entries.length<=p.capacity);
 if(sim.ports.some(p=>p.entries.some(e=>e.status==='picking'))&&sim.robots.some(r=>r.job&&['dig','deliver'].includes(r.job.kind)))overlap=true;
 if(!toggled&&sim.time>80){sim.setOrderPrefetch(false);sim.setOrderPrefetch(true);toggled=true;}
 });
 assert.ok(overlap,'another bin is prepared while a port picks');assert.ok(book.orders.every(o=>o.status==='shipped'));
 for(const s of sim.catalog)assert.equal(s.qty,initial.get(s.id)-sim.orders.filter(o=>o.skuId===s.id).reduce((n,o)=>n+o.qty,0));
});

test('prefetch works independently with a single robot, one-slot port and repeated-bin urgent work',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),skuCount:180,maxHeightM:1.32,robotCount:1,
  ports:[{id:'P1',x:0,z:7,type:'single'}],orderPrefetch:true,pickingSeconds:3});
 const sku=sim.catalog.find(s=>s.operational&&s.qty>=3);const initial=sku.qty;
 sim.enqueueSku(sku.id,1);sim.enqueueRandom(4);const urgent=sim.enqueueSku(sku.id,2,{priority:'urgent'});
 const assign=sim._assignJob.bind(sim);let first;
 sim._assignJob=(r,j)=>{first??=j.order.id;return assign(r,j);};sim.start();finish(sim);
 assert.equal(first,urgent.id);assert.equal(sku.qty,initial-sim.orders.filter(o=>o.skuId===sku.id).reduce((n,o)=>n+o.qty,0));
});


test('a lifted bin retains its claim across pause, urgent promotion and disabling prefetch',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.98,skuCount:480,strategies,orderPrefetch:true,pickingSeconds:3}),book=new OrderBook(sim);
 book.generate(10,{combinedRatio:.4,seed:'pipeline-c'});book.submitAll();sim.start();let lifted,ticks=0;
 while(!lifted&&sim.running&&ticks++<6000){sim.tick(.1);lifted=sim.robots.find(r=>r.job?.prepared);}
 assert.ok(lifted,'a bin is physically lifted before an inlet is free');
 const binId=lifted.carryingBinId,request=lifted.job.order;assert.equal(sim.bins.get(binId).location.robotId,lifted.id);
 assert.ok(sim.binClaims.has(binId));
 sim.pause();const time=sim.time;sim.setOrderPrefetch(false);sim.setStrategies({completionTime:false,portPacing:false,timeReservations:false});sim.tick(10);assert.equal(sim.time,time);
 book.prioritize(book.orders.at(-1).id);sim.start();finish(sim,book);
 assert.equal(request.status,'complete');assert.equal(sim.bins.get(binId).location.type,'grid');assert.ok(sim.robots.every(r=>!r.job&&!r.carryingBinId));
 // Each request deducts only once; earlier completed picks were already in stock.
 assert.equal(sim.metrics.pickedUnits,sim.orders.reduce((n,o)=>n+o.qty,0));
});

for(const [seed,oldTime,oldIdle,oldSupply,oldDwell]of [['pipeline-a',466.2,765,642.7,697.1],['pipeline-b',345.5,558,475.4,463.1],['pipeline-c',365.2,560.8,467.8,502.2],['pipeline-d',285.4,412,340.6,298.7],['pipeline-e',356.3,535.2,439.7,478.2],['pipeline-f',371.7,596.6,501.6,521.6]])test('near-port preparation reduces supply gaps and completed-bin dwell: '+seed,()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.98,skuCount:480,strategies,orderPrefetch:true,pickingSeconds:3}),book=new OrderBook(sim);
 book.generate(10,{combinedRatio:.4,seed});book.submitAll();sim.start();let idle=0,ticks=0,parallelStart=false,dwell=0,earlyLift=false;
 while(sim.running&&ticks++<9000){
  const demand=sim.orders.some(o=>!o.pickedQty&&['queued','inProgress'].includes(o.status));
  if(demand)idle+=.1*sim.ports.filter(p=>p.operational&&!p.activeEntryId).length;
  const before=new Map(sim.ports.map(p=>[p.id,p.activeEntryId]));sim.tick(.1);book.update();
  for(const p of sim.ports){dwell+=.1*p.entries.filter(e=>['ready','outbound'].includes(e.status)).length;if(p.activeEntryId&&sim.robots.some(r=>r.job?.kind==='prelift'&&r.job.plannedPortId===p.id&&r.carryingBinId))earlyLift=true;}
  for(const p of sim.ports){if(!before.get(p.id)&&p.activeEntryId&&p.inletReservation)parallelStart=true;if(p.rotation)assert.equal(p.inletReservation,null);}
  if(ticks%50===0)sim.assertInvariants();
 }
 assert.ok(sim.orders.every(o=>o.status==='complete'));assert.ok(sim.time<oldTime);assert.ok(idle<oldIdle);assert.ok(sim.metrics.portStarvedSec<oldSupply);assert.ok(dwell<oldDwell);assert.ok(earlyLift,'next payload is lifted before current picking ends');
 assert.ok(Math.abs(idle-sim.metrics.portIdleDemandSec)<.001);assert.ok(sim.metrics.portStarvedSec<=idle);
 assert.ok(parallelStart,'front workstation can start while a rear shaft is reserved');assert.equal(sim.binClaims.size,0);
});

for(const robotCount of[2,8])test('adaptive preparation leaves return capacity with '+robotCount+' robots',()=>{
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.32,skuCount:240,robotCount,strategies,orderPrefetch:true,pickingSeconds:8}),book=new OrderBook(sim);
 book.generate(6,{seed:'adaptive-capacity'});book.submitAll();sim.start();finish(sim,book);
 assert.ok(sim.robots.every(r=>!r.carryingBinId));assert.ok(book.orders.every(o=>o.status==='shipped'));
});
