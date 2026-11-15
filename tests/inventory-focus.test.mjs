import test from 'node:test';
import assert from 'node:assert/strict';
import {InventoryFocus} from '../dist/inventory-focus.js';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';

const state=sim=>JSON.stringify({catalog:sim.catalog,bins:[...sim.bins],orders:sim.orders,
  robots:sim.robots,time:sim.time,revision:sim.revision,running:sim.running});

test('inventory selection is read-only, rejects missing/unassigned SKUs and clears independently',()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),skuCount:3000});
  const focus=new InventoryFocus(sim),sku=sim.catalog.find(value=>value.assigned);
  const missing=sim.catalog.find(value=>!value.assigned),before=state(sim);
  assert.ok(missing);assert.equal(focus.snapshot(),null);
  const selected=focus.select(sku.id),location=sim.bins.get(sku.binId).location;
  assert.equal(selected.available,true);assert.equal(selected.skuId,sku.id);
  assert.equal(selected.binId,sku.binId);assert.equal(selected.qty,sku.qty);
  assert.deepEqual(selected.cell,{x:location.x,z:location.z,level:location.level+1});
  assert.match(selected.locationLabel,/셀 .*층/);
  assert.equal(state(sim),before);
  assert.throws(()=>focus.select('MISSING'),/찾을 수/);
  assert.throws(()=>focus.select(missing.id),/배정되지/);
  assert.equal(focus.snapshot().skuId,sku.id,'a failed selection preserves the previous target');
  focus.clear();assert.equal(focus.snapshot(),null);assert.equal(state(sim),before);
});

test('removed SKU or bin never leaves a stale available highlight or silently changes physical identity',()=>{
  const sim=new AutoStoreSim(createDefaultConfig()),focus=new InventoryFocus(sim);
  const sku=sim.catalog[0],binId=sku.binId;
  focus.select(sku.id);sim.removeSkus([sku.id]);
  assert.equal(focus.snapshot().available,false);assert.equal(focus.snapshot().locationType,'missing');
  assert.equal(focus.snapshot().binId,binId);assert.match(focus.snapshot().locationLabel,/삭제/);
  const next=sim.catalog.find(value=>value.assigned);focus.select(next.id);
  const nextBin=sim.bins.get(next.binId);sim.bins.delete(nextBin.id);
  assert.equal(focus.snapshot().available,false);
  sim.bins.set(nextBin.id,nextBin);
  assert.equal(focus.snapshot().available,true);
  next.binId=[...sim.bins.keys()].find(id=>id!==nextBin.id);
  assert.equal(focus.snapshot().available,false);assert.equal(focus.snapshot().binId,nextBin.id);
  assert.match(focus.snapshot().locationLabel,/배정이 변경/);
});

test('one inventory bin follows actual deep digging, hoists, port picking and return even when its SKU becomes empty',()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.32});
  const column=[...sim.cells.values()].filter(cell=>cell.reachable&&cell.stack.length>=3)
    .sort((a,b)=>b.stack.length-a.stack.length)[0];
  assert.ok(column,'there must be a reachable buried bin');
  const bin=sim.bins.get(column.stack[0]),sku=sim.skuMap.get(bin.skuIds[0]);
  const focus=new InventoryFocus(sim),quantity=sku.qty,seen=new Set();
  focus.select(sku.id);assert.equal(sim.orders.length,0);
  const request=sim.enqueueSku(sku.id,quantity);assert.equal(sim.start(),true);
  let steps=0,sawEmptyAtPort=false;
  while(sim.running&&steps++<12000){
    sim.tick(.5);
    const snapshot=focus.snapshot(),actual=sim.bins.get(bin.id).location;
    assert.equal(snapshot.available,true);assert.equal(snapshot.binId,bin.id);
    assert.equal(snapshot.skuId,sku.id);assert.equal(snapshot.locationType,actual.type);
    assert.equal(snapshot.qty,quantity-request.pickedQty);
    seen.add(snapshot.locationType);
    if(actual.type==='grid')assert.deepEqual(snapshot.cell,{x:actual.x,z:actual.z,level:actual.level+1});
    else assert.equal(snapshot.cell,null,'moving and port bins must not pretend to occupy a stored cell');
    if(actual.type==='robot'){
      assert.equal(snapshot.robotId,actual.robotId);assert.match(snapshot.locationLabel,/로봇/);
      assert.equal(snapshot.statusLabel,sim.robots.find(robot=>robot.id===actual.robotId).status);
    }
    if(actual.type==='port'){
      assert.equal(snapshot.portId,actual.portId);assert.match(snapshot.locationLabel,/포트/);
      sawEmptyAtPort ||= snapshot.qty===0;
    }
    if(steps%100===0)sim.assertInvariants();
  }
  assert.ok(steps<12000,'the complete pick and return must finish');
  assert.deepEqual([...seen].sort(),['grid','port','robot']);
  assert.equal(request.status,'complete');assert.equal(request.pickedQty,quantity);
  assert.ok(request.digMoves.length>0,'the chosen bin requires real digging');
  assert.ok(sawEmptyAtPort,'tracking continues after all selected stock was picked');
  const returned=focus.snapshot();assert.equal(returned.available,true);
  assert.equal(returned.qty,0);assert.equal(returned.locationType,'grid');
  assert.equal(returned.binId,bin.id);sim.assertInvariants();
});
