import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {OrderBook} from '../dist/orders.js';
import {AutoStoreSim as PreviousSim} from './baseline/engine.js';
import {OrderBook as PreviousBook} from './baseline/orders.js';

// The four new telemetry counters are independently checked by strategy tests.
const stable=value=>JSON.parse(JSON.stringify(value,(k,v)=>['prioritySequence','emptyTravelMeters','portStarvedSec','portIdleDemandSec','trafficScheduledJobs','trafficWaitSec'].includes(k)?undefined:typeof v==='number'?Math.round(v*1e7)/1e7:v instanceof Set?[...v]:v));
const state=(sim,book)=>stable({
  requests:sim.orders,customerOrders:book.orders,metrics:sim.metrics,
  cells:[...sim.cells.values()].map(c=>({key:c.key,stack:c.stack})),
  bins:[...sim.bins.values()],skus:sim.catalog.map(s=>({id:s.id,qty:s.qty,binId:s.binId,compartment:s.compartment})),
  ports:sim.ports,claims:[...sim.binClaims],locks:[...sim.locks].sort((a,b)=>a[0].localeCompare(b[0])),
  robots:sim.robots.map(r=>({id:r.id,x:r.x,z:r.z,gripperY:r.gripperY,carryingBinId:r.carryingBinId,completed:r.completed,
    job:r.job?{id:r.job.id,kind:r.job.kind,binId:r.job.binId,index:r.job.index,elapsed:r.job.elapsed}:null})),
});
function difference(a,b,path='state'){
  if(Object.is(a,b))return null;
  if(typeof a!==typeof b||a===null||b===null||typeof a!=='object')return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  const keys=[...new Set([...Object.keys(a),...Object.keys(b)])];
  for(const key of keys){const d=difference(a[key],b[key],path+'.'+key);if(d)return d;}return null;
}
for(const [label,patch]of[['buffer and cooperative digging',{}],['solo digging',{cooperativeDigging:false}],['30 robots',{width:16,depth:12,robotCount:30,skuCount:160,maxHeightM:1.32,
  activeCells:Array.from({length:192},(_,i)=>`${i%16},${Math.floor(i/16)}`),ports:[{id:'P1',x:0,z:11,type:'single'},{id:'P2',x:15,z:0,type:'single'}]}]]){
  test(`Rust state transitions match independent JS reference with v1.9 mechanical policy: ${label}`,()=>{
    const config={...createDefaultConfig(),...patch},current=new AutoStoreSim(config),previous=new PreviousSim(config);
    const book=new OrderBook(current),oldBook=new PreviousBook(previous);
    for(const [s,b]of[[current,book],[previous,oldBook]]){
      b.generate(4,{seed:'rust-phase-two'});b.submitAll();
      const c=[...s.cells.values()].filter(c=>c.operational&&c.stack.length>1).sort((a,b)=>b.stack.length-a.stack.length)[0];
      if(c)s.enqueueSku(s.bins.get(c.stack[0]).skuIds[0],1,{priority:'urgent'});
      s.start();
    }
    let ticks=0;while((current.running||previous.running)&&ticks++<16000){
      current.tick(.5);previous.tick(.5);book.update();oldBook.update();
      if(ticks%40===0){assert.equal(difference(state(current,book),state(previous,oldBook)),null,`at tick ${ticks}`);current.assertInvariants();previous.assertInvariants();}
    }
    assert.ok(ticks<16000);assert.ok(book.orders.every(o=>o.status==='shipped'));
    assert.equal(difference(state(current,book),state(previous,oldBook)),null);
    assert.equal(current._rpc('inspect').authority,'rust');assert.equal(current._rpc('inspect').assignments,0);
    current._runtime.dispose();current._navigator.dispose();previous._navigator.dispose();
  });
}

test('Rust owns stock reservations even if a web read model is changed; stores remain isolated',()=>{
  const first=new AutoStoreSim(),second=new AutoStoreSim();first._ensureRuntime();second._ensureRuntime();
  const sku=first.catalog.find(s=>s.operational),quantity=sku.qty;sku.qty=0;
  const request=first.enqueueSku(sku.id,1);assert.equal(request.status,'queued');
  request.status='complete';assert.equal(first.reservedQuantity(sku.id),1);assert.equal(second.reservedQuantity(sku.id),0);
  sku.qty=quantity;request.status='queued';
  const before=first.catalog.length;assert.throws(()=>first.removeSkus([sku.id]),/피킹 요청/);assert.equal(first.catalog.length,before);
  first.reset();assert.equal(first.reservedQuantity(sku.id),0);
  first._runtime.dispose();second._runtime.dispose();first._navigator.dispose();second._navigator.dispose();
});
