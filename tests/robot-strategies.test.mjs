import assert from 'node:assert/strict';
import test from 'node:test';
import {AutoStoreSim,createDefaultConfig,normalizeConfig} from '../dist/engine.js';

const flags=n=>({completionTime:!!(n&1),portPacing:!!(n&2),timeReservations:!!(n&4)});
function run(sim,{toggle=false,step=.2}={}){
  const stock=new Map(sim.catalog.map(s=>[s.id,s.qty]));let steps=0,shared=0;
  const assign=sim._assignJob.bind(sim);
  sim._assignJob=(r,j)=>{if(j.traffic)for(const other of sim.robots)if(other.job?.traffic){
    const keys=new Set(other.job.traffic.windows.filter(w=>w.end>sim.time&&w.end<1e12).map(w=>w.key));
    if(j.traffic.windows.some(w=>w.end<1e12&&keys.has(w.key)))shared++;
  }return assign(r,j);};
  sim.start();
  while(sim.running&&steps++<14000){
    sim.tick(step);sim.assertInvariants();
    if(toggle&&steps===80){sim.pause();const at=sim.time;sim.setStrategies(flags(0));sim.tick(4);assert.equal(sim.time,at);sim.start();}
    if(toggle&&steps===200)sim.setStrategies(flags(7));
  }
  assert.ok(steps<14000,'bounded completion');assert.equal(sim.stalled,false);
  assert.ok(sim.orders.every(o=>o.status==='complete'),sim.orders.filter(o=>o.status!=='complete').map(o=>o.id+':'+o.status+':'+o.reason).join(','));
  assert.equal(sim.locks.size,0);assert.equal(sim.binClaims.size,0);assert.ok(sim.robots.every(r=>!r.job&&!r.carryingBinId));
  for(const s of sim.catalog)assert.equal(s.qty,stock.get(s.id)-sim.orders.filter(o=>o.skuId===s.id).reduce((v,o)=>v+o.qty,0));
  return {time:sim.time,shared};
}

test('options are independent and absent flags preserve the original scheduler',()=>{
  assert.deepEqual(normalizeConfig().strategies,flags(0));
  for(let n=0;n<8;n++)assert.deepEqual(normalizeConfig({strategies:flags(n)}).strategies,flags(n));
});

for(let n=0;n<8;n++)test('strategy combination '+n+' completes identical demand with exact inventory',()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),skuCount:180,maxHeightM:1.32,strategies:flags(n)});
  sim.enqueueRandom(6);const out=run(sim);if(n===4)assert.ok(out.shared>0,'different robots must share route cells in separate time slots');console.log('strategies',n,out,sim.metrics);
});

test('switching strategies during motion and pause preserves ongoing contracts',()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),skuCount:240,maxHeightM:1.32,strategies:flags(7)});sim.enqueueRandom(8);run(sim,{toggle:true});
});


// Independent continuous-body oracle; split observations at path corners.
function swept(previous,current){
  for(let i=0;i<current.length;i++)for(let j=i+1;j<current.length;j++){
    let enter=0,exit=1;
    for(const [axis,size]of [['x',1-1e-7],['z',2-1e-7]]){
      const begin=previous[i][axis]-previous[j][axis],finish=current[i][axis]-current[j][axis],d=finish-begin;
      if(Math.abs(d)<1e-9){if(Math.abs(begin)>=size){exit=-1;break;}continue;}
      const a=(-size-begin)/d,b=(size-begin)/d;enter=Math.max(enter,Math.min(a,b));exit=Math.min(exit,Math.max(a,b));
    }
    assert.ok(exit<=enter+1e-7,'swept chassis collision '+i+'/'+j);
  }
}
const poses=sim=>sim.robots.filter(r=>r.available).map(r=>({x:r.x,z:r.z+r.bodySign/2}));
for(const orderPrefetch of[false,true])test('timed traffic remains collision-free during deep digging; prefetch '+orderPrefetch,()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:3.3,strategies:flags(7),orderPrefetch});
  const source=[...sim.cells.values()].filter(c=>c.operational&&c.stack.length>=3).sort((a,b)=>b.stack.length-a.stack.length)[0];
  sim.enqueueSku(sim.bins.get(source.stack[0]).skuIds[0],1);sim.enqueueRandom(5);
  let previous=poses(sim),ticks=0;sim.start();
  while(sim.running&&ticks++<30000){let step=.1;
    for(const r of sim.robots)if(r.job&&r.currentOperation?.type==='move'){let end=0;for(const segment of r.currentOperation.segments){end+=segment.duration;const dt=end-r.job.elapsed;if(dt>1e-8){step=Math.min(step,dt);break;}}}
    sim.tick(step);sim.assertInvariants();const current=poses(sim);swept(previous,current);previous=current;
  }
  assert.ok(ticks<30000);assert.equal(sim.stalled,false);assert.ok(sim.orders.every(o=>o.status==='complete'));
  assert.ok(sim.metrics.trafficScheduledJobs>0);assert.equal(sim.locks.size,0);
});

for(const count of [1,8,30])test('all strategies finish with '+count+' robots and preserve urgent priority',()=>{
  const large=count===30;const base=createDefaultConfig();
  const sim=new AutoStoreSim({...base,width:large?16:12,depth:large?12:8,
    activeCells:large?Array.from({length:192},(_,i)=>(i%16)+','+Math.floor(i/16)):base.activeCells,
    ports:large?[{id:'P1',x:0,z:11,type:'single'},{id:'P2',x:15,z:0,type:'single'}]:base.ports,
    skuCount:large?360:240,maxHeightM:1.32,robotCount:count,strategies:flags(7)});
  sim.enqueueRandom(8);const sku=sim.catalog.find(s=>s.operational);const urgent=sim.enqueueSku(sku.id,1,{priority:'urgent'});
  const assign=sim._assignJob.bind(sim);let first;
  sim._assignJob=(r,j)=>{first??=j.order.id;return assign(r,j);};run(sim,{step:.5});assert.equal(first,urgent.id);
});

for(const [width,depth]of [[4,4],[5,4],[4,8]])test('constrained '+width+'x'+depth+' layout works with all strategies',()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),width,depth,robotCount:4,skuCount:120,maxHeightM:1.32,
    activeCells:Array.from({length:width*depth},(_,i)=>(i%width)+','+Math.floor(i/width)),
    ports:[{id:'P1',x:0,z:depth-1,type:'single'},{id:'P2',x:width-1,z:0,type:'single'}],strategies:flags(7)});
  sim.enqueueRandom(8);run(sim,{step:.5});
});

test('combined orders, repeated bins and urgent promotion complete once with all strategies',async()=>{
  const {OrderBook}=await import('../dist/orders.js');
  const sim=new AutoStoreSim({...createDefaultConfig(),strategies:flags(7)}),book=new OrderBook(sim);
  book.generate(8,{seed:'strategy-combined'});book.submitAll();sim.start();sim.tick(3);
  book.prioritize(book.orders.at(-1).id);run(sim,{step:.5});book.update();
  assert.ok(book.orders.every(o=>o.status==='shipped'));assert.ok(book.orders.some(o=>o.kind==='combined'));
  assert.equal(sim.metrics.pickedUnits,book.orders.reduce((v,o)=>v+o.lines.reduce((n,l)=>n+l.qty,0),0));
});
