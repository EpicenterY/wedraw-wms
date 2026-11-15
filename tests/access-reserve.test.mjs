import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {analyzeLayout} from '../dist/layout-editor.js';
import {OrderBook} from '../dist/orders.js';

const sameSide={...createDefaultConfig(),ports:[{id:'P1',x:0,z:7,type:'single'},{id:'P2',x:11,z:7,type:'single'}]};
function assertReserved(sim){
  const excluded=[...sim.cells.values()].filter(c=>c.storageExcluded);
  assert.ok(excluded.length>0);assert.ok(excluded.every(c=>c.stack.length===0));
  assert.equal(sim.getStats().robotInaccessibleSkuCount,0);
  assert.ok(sim.catalog.filter(s=>s.assigned).every(s=>s.reachable));
  sim.assertInvariants();return excluded;
}
test('waiting-position and two-cell inaccessible columns are excluded before initial and incremental allocation',()=>{
  const sim=new AutoStoreSim(sameSide),excluded=assertReserved(sim);
  assert.equal(sim.getStats().accessReservedCellCount,excluded.length);
  assert.equal(analyzeLayout(sameSide).stats.capacitySkus,sim.getStats().capacitySkus);
  sim.addSkus(4000);assertReserved(sim);
  assert.equal(sim.getStats().assignedSkuCount,sim.getStats().capacitySkus);
  assert.ok(sim.getStats().unassignedSkuCount>0);
  sim.removeSkus(sim.catalog.filter(s=>s.assigned).slice(0,20).map(s=>s.id));sim.addSkus(20);assertReserved(sim);
  const restored=new AutoStoreSim(sim.config);assertReserved(restored);
});
test('reserved columns remain empty during digging, return and idle optimization',()=>{
  const sim=new AutoStoreSim({...sameSide,maxHeightM:1.32,skuCount:500,idleOptimization:true}),book=new OrderBook(sim);
  assertReserved(sim);const deep=[...sim.cells.values()].filter(c=>c.operational&&c.stack.length>1).sort((a,b)=>b.stack.length-a.stack.length)[0];assert.ok(deep);
  const bin=sim.bins.get(deep.stack[0]);sim.setDemandWeights([{binId:bin.id,orderCount:10}]);
  book.generate(3,{seed:'safe-columns'});book.submitAll();sim.start();let ticks=0;
  while(ticks++<15000){sim.tick(.5);book.update();if(ticks%25===0)assertReserved(sim);if(book.orders.every(o=>o.status==='shipped')&&sim.orders.every(o=>o.status==='complete')&&sim.getStats().systemState==='waiting')break;}
  assert.ok(ticks<15000);assertReserved(sim);assert.equal(sim.metrics.pickedUnits,book.orders.reduce((n,o)=>n+o.totalQty,0));
});
test('a disconnected area or a layout without a two-cell exit keeps stock unassigned',()=>{
  for(const patch of [{ports:[]},{width:8,depth:1,activeCells:Array.from({length:8},(_,i)=>`${i},0`),ports:[{id:'P1',x:0,z:0,type:'single'}]}]){
    const sim=new AutoStoreSim({...createDefaultConfig(),...patch});assert.equal(sim.bins.size,0);assert.equal(sim.getStats().capacitySkus,0);assert.equal(sim.getStats().unassignedSkuCount,1000);sim.addSkus(10);assert.equal(sim.bins.size,0);
  }
});
