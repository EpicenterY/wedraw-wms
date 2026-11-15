import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {OrderBook} from '../dist/orders.js';

function fixture(){
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.32});
  const skus=[...sim.cells.values()].filter(c=>c.operational&&c.stack.length)
    .map(c=>sim.skuMap.get(sim.bins.get(c.stack.at(-1)).skuIds[0])).filter(s=>s.qty>=3);
  const book=new OrderBook(sim);
  book.importDefinitions({version:1,type:'evio-customer-orders',orders:[
    {id:'NORMAL',kind:'single',lines:[{skuId:skus[0].id,qty:1}]},
    {id:'PACKAGE',kind:'combined',lines:[{skuId:skus[1].id,qty:1},{skuId:skus[2].id,qty:2}]},
  ]});
  return {sim,book,skus};
}
function finish(sim,book){
  sim.start();let ticks=0;
  while(sim.running&&ticks++<12000){sim.tick(.5);book.update();if(ticks%30===0)sim.assertInvariants();}
  assert.ok(ticks<12000);assert.ok(sim.orders.every(r=>r.status==='complete'));
  assert.ok(book.orders.every(o=>o.status==='shipped'));sim.assertInvariants();
}
test('selected combined order is promoted as a package, once, and finishes with conserved stock',()=>{
  const {sim,book}=fixture(),stock=new Map(sim.catalog.map(s=>[s.id,s.qty]));
  book.submit('NORMAL');const selected=book.prioritize('PACKAGE');
  assert.equal(selected.priority,'urgent');
  assert.ok(selected.lines.every(l=>sim.orders.find(r=>r.id===l.requestId).priority==='urgent'));
  const ids=sim.orders.map(r=>r.id),reservations=[...book.getReservedMap()];
  book.prioritize('PACKAGE');assert.deepEqual(sim.orders.map(r=>r.id),ids);assert.deepEqual([...book.getReservedMap()],reservations);
  const tasks=sim._rpc('dispatchPlan').tasks.filter(t=>t.kind==='retrieve');
  assert.deepEqual(tasks.map(t=>t.orderId),selected.lines.map(l=>l.requestId));
  finish(sim,book);assert.equal(selected.packageCount,1);
  for(const sku of sim.catalog){const picked=sim.orders.filter(r=>r.skuId===sku.id).reduce((n,r)=>n+r.pickedQty,0);assert.equal(sku.qty+picked,stock.get(sku.id));}
  assert.throws(()=>book.prioritize('PACKAGE'),/완료/);
  sim.reset();book.resetExecution();assert.ok(book.orders.every(o=>o.priority===undefined));
});
test('promoting an active order retains jobs, bin claims and request identities',()=>{
  const {sim,book}=fixture();book.submitAll();sim.start();
  for(let i=0;i<100&&!sim.robots.some(r=>r.job);i++)sim.tick(.1);
  const active=sim.robots.find(r=>r.job);assert.ok(active);
  const id=active.job.order.customerOrderId;
  const before=JSON.stringify({jobs:sim.robots.map(r=>r.job),claims:[...sim.binClaims],locks:[...sim.locks],bins:[...sim.bins],stock:sim.catalog.map(s=>s.qty)});
  const requests=sim.orders.map(r=>r.id);book.prioritize(id);
  // Jobs hold the same request object; compare their stable identity and physics.
  const after=JSON.stringify({jobs:sim.robots.map(r=>r.job),claims:[...sim.binClaims],locks:[...sim.locks],bins:[...sim.bins],stock:sim.catalog.map(s=>s.qty)});
  const strip=s=>JSON.parse(s,(k,v)=>['priority','prioritySequence'].includes(k)?undefined:v);
  assert.deepEqual(strip(after),strip(before));assert.deepEqual(sim.orders.map(r=>r.id),requests);
  finish(sim,book);
});
test('promotion joins existing urgent requests in FIFO order and later urgent requests stay behind it',()=>{
  const {sim,book,skus}=fixture();book.submit('PACKAGE');
  const first=sim.enqueueSku(skus[3].id,1,{priority:'urgent'});
  const selected=book.prioritize('PACKAGE');
  const last=sim.enqueueSku(skus[4].id,1,{priority:'urgent'});
  const tasks=sim._rpc('dispatchPlan').tasks.filter(t=>t.kind==='retrieve');
  assert.deepEqual(tasks.map(t=>t.orderId),[first.id,...selected.lines.map(l=>l.requestId),last.id]);
  assert.equal(sim.getStats().priorityRequest.id,first.id);
});
test('blocked package never becomes a false urgent order or enqueues a partial preflight',()=>{
  const {sim,book,skus}=fixture();
  book.importDefinitions({version:1,type:'evio-customer-orders',orders:[{id:'BAD',kind:'combined',lines:[{skuId:skus[0].id,qty:1},{skuId:skus[1].id,qty:100000}]}]});
  assert.throws(()=>book.prioritize('BAD'),/부족/);assert.equal(sim.orders.length,0);assert.equal(book.orders[0].priority,undefined);
  assert.throws(()=>book.prioritize('MISSING'),/찾을 수/);
});
