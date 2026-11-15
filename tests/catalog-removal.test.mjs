import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AutoStoreSim,createDefaultConfig,makeCatalog,normalizeConfig} from '../dist/engine.js';
import {LayoutEditor} from '../dist/layout-editor.js';

const config=count=>({...createDefaultConfig(),skuCount:count});
const poses=sim=>JSON.stringify({bins:[...sim.bins].map(([id,bin])=>[id,bin.location]),stacks:[...sim.cells].map(([key,cell])=>[key,cell.stack])});
const inventory=sim=>JSON.stringify({catalog:sim.catalog,config:sim.config,orders:sim.orders,stats:sim.getStats(),bins:[...sim.bins]});
function finish(sim){let ticks=0;while(sim.running&&ticks++<4000)sim.tick(.5);assert.ok(ticks<4000);assert.equal(sim.running,false);sim.assertInvariants();}

test('stable sparse catalog generation retains all original deterministic product data',()=>{
  const expected=new Map([
    [20261114,'ce5af65732ba49d2469266f543752836550172be000b81c7cb540a01f20144da'],
    [7,'3349c0b24dc3fbdcd8438c7b45775ecc0a81263014c20d94e746f4bfe80c7856'],
    [-12345,'33a5b51150d486156d2cc4e8e363cdf23a88d47941ec888a95d39888e594fad6'],
  ]);
  for(const [seed,hash]of expected)assert.equal(createHash('sha256').update(JSON.stringify(makeCatalog(10000,seed))).digest('hex'),hash);
  assert.deepEqual(makeCatalog(0),[]);
  const legacy=normalizeConfig(config(7));assert.equal(legacy.skuCount,7);assert.equal(legacy.catalogIds.at(-1),'HW-0007');assert.equal(legacy.nextSkuNumber,8);
  const sparse=new AutoStoreSim({...config(1000),catalogIds:['HW-0002','HW-0047','HW-0500'],nextSkuNumber:1001});
  assert.equal(sparse.catalog.length,3);
  const original=makeCatalog(500);
  for(const sku of sparse.catalog){const expected=original[Number(sku.id.slice(3))-1];for(const field of['id','name','spec','category','qty','initialQty','unitWeightKg'])assert.equal(sku[field],expected[field]);}
  sparse.assertInvariants();
});

test('selected removal preserves all remaining compartments and physical bins; new IDs reuse only vacant compartments',()=>{
  const sim=new AutoStoreSim(config(8)),first=sim.bins.values().next().value;
  const removedId=first.skuIds[1],hole=sim.skuMap.get(removedId).compartment;
  const kept=new Map(sim.catalog.filter(sku=>sku.id!==removedId).map(sku=>[sku.id,JSON.stringify(sku)]));
  const beforePose=poses(sim),binCount=sim.bins.size,next=sim.config.nextSkuNumber;
  const result=sim.removeSkus([removedId,removedId]);
  assert.equal(result.removed,1);assert.equal(result.total,7);
  assert.equal(sim.skuMap.has(removedId),false);assert.equal(poses(sim),beforePose);
  assert.equal(sim.bins.size,binCount);
  for(const [id,expected]of kept)assert.equal(JSON.stringify(sim.skuMap.get(id)),expected);
  sim.assertInvariants();
  assert.equal(sim.addSkus(1).added,1);
  const added=sim.skuMap.get(`HW-${String(next).padStart(4,'0')}`);
  assert.ok(added);assert.equal(added.binId,first.id);assert.equal(added.compartment,hole);
  assert.equal(sim.skuMap.has(removedId),false);assert.equal(poses(sim),beforePose);
  for(const [id,expected]of kept)assert.equal(JSON.stringify(sim.skuMap.get(id)),expected);
  sim.assertInvariants();
});

test('decreasing the target deletes from the end and selected membership survives draft analysis and reload',()=>{
  const sim=new AutoStoreSim(config(20));
  sim.removeSkus(['HW-0002','HW-0008','HW-0020']);
  const keptIds=sim.catalog.slice(0,10).map(sku=>sku.id),kept=sim.catalog.slice(0,10).map(sku=>({...sku}));
  assert.equal(sim.setSkuCount(10).removed,7);
  assert.deepEqual(sim.catalog,kept);
  assert.deepEqual(sim.config.catalogIds,keptIds);
  const persisted=JSON.parse(JSON.stringify(sim.config));
  const editor=new LayoutEditor(persisted);editor.replace({...editor.config,maxHeightM:3.3});
  assert.deepEqual(editor.config.catalogIds,keptIds);assert.equal(editor.config.nextSkuNumber,21);
  const restored=new AutoStoreSim(editor.config);
  assert.deepEqual(restored.catalog.map(sku=>sku.id),keptIds);
  restored.addSkus(3);
  assert.deepEqual(restored.catalog.slice(-3).map(sku=>sku.id),['HW-0021','HW-0022','HW-0023']);
  for(const id of['HW-0002','HW-0008','HW-0020'])assert.equal(restored.skuMap.has(id),false);
  restored.assertInvariants();
});

test('zero SKU catalogs remain empty after reload and can grow past retired identifier ranges',()=>{
  const sim=new AutoStoreSim(config(10000)),beforePose=poses(sim);
  assert.equal(sim.setSkuCount(0).removed,10000);
  assert.equal(sim.catalog.length,0);assert.deepEqual(sim.config.catalogIds,[]);assert.equal(sim.config.nextSkuNumber,10001);
  assert.equal(poses(sim),beforePose,'deleting stock keeps its empty bins physically in place');
  assert.ok([...sim.bins.values()].every(bin=>!bin.skuIds.length&&bin.weightKg===0));
  sim.assertInvariants();
  const restored=new AutoStoreSim(JSON.parse(JSON.stringify(sim.config)));
  assert.equal(restored.catalog.length,0);assert.equal(restored.getStats().skuCount,0);
  assert.equal(restored.getStats().capacitySkus,2256);
  restored.setSkuCount(2);
  assert.deepEqual(restored.catalog.map(sku=>sku.id),['HW-10001','HW-10002']);
  assert.equal(restored.config.nextSkuNumber,10003);restored.assertInvariants();
  assert.equal(new AutoStoreSim(config(0)).catalog.length,0,'legacy explicit zero is not replaced with the default 1000');
});

test('completed picking history and stock conservation remain correct when a picked SKU is removed',()=>{
  const sim=new AutoStoreSim(config(16)),sku=sim.catalog.find(sku=>sku.operational);
  const request=sim.enqueueSku(sku.id,2);sim.start();finish(sim);
  assert.equal(request.status,'complete');assert.equal(request.pickedQty,2);
  const beforeHistory=JSON.stringify(sim.orders),beforePicked=sim.metrics.pickedUnits,beforePose=poses(sim);
  const remaining=sim.catalog.filter(value=>value.id!==sku.id).map(value=>({...value}));
  const initial=sku.initialQty,current=sku.qty;
  sim.removeSkus([sku.id]);
  assert.equal(JSON.stringify(sim.orders),beforeHistory);assert.equal(sim.metrics.pickedUnits,beforePicked);
  assert.deepEqual(sim.catalog,remaining);assert.equal(poses(sim),beforePose);
  let stats=sim.getStats();
  assert.equal(stats.deletedInitialQty,initial);assert.equal(stats.deletedCurrentQty,current);
  assert.equal(stats.currentQty+stats.deletedCurrentQty+stats.pickedUnits,stats.initialQty+stats.deletedInitialQty);
  sim.addSkus(2);stats=sim.getStats();
  assert.equal(stats.currentQty+stats.deletedCurrentQty+stats.pickedUnits,stats.initialQty+stats.deletedInitialQty);
  assert.equal(sim.metrics.pickedUnits,2);sim.assertInvariants();
});

test('removal is atomic for unknown IDs, accepted requests and active robot or port work',()=>{
  const sim=new AutoStoreSim(config(12)),target=sim.catalog.find(sku=>sku.operational),other=sim.catalog.find(sku=>sku.id!==target.id);
  let before=inventory(sim);
  assert.throws(()=>sim.removeSkus([other.id,'HW-9999']),/없는 품목/);assert.equal(inventory(sim),before);
  sim.enqueueSku(target.id,1);before=inventory(sim);
  assert.throws(()=>sim.removeSkus([other.id,target.id]),/피킹 요청/);assert.equal(inventory(sim),before);
  sim.start();before=inventory(sim);
  assert.throws(()=>sim.removeSkus([other.id]),/로봇·포트/);assert.equal(inventory(sim),before);
  sim.tick(1);sim.pause();before=inventory(sim);
  assert.ok(sim.robots.some(robot=>robot.job));
  assert.throws(()=>sim.removeSkus([other.id]),/로봇·포트/);assert.equal(inventory(sim),before);
  sim.start();let ticks=0;while(!sim.ports.some(port=>port.entries.length)&&ticks++<2000)sim.tick(.5);
  assert.ok(sim.ports.some(port=>port.entries.length));sim.pause();before=inventory(sim);
  assert.throws(()=>sim.setSkuCount(0),/로봇·포트/);assert.equal(inventory(sim),before);
  sim.start();finish(sim);assert.equal(sim.removeSkus([target.id]).removed,1);sim.assertInvariants();
});

test('normalization deduplicates membership and sparse high identifiers do not require generating missing products',()=>{
  const normalized=normalizeConfig({...config(1000),catalogIds:['HW-0001','HW-1','invalid',null],nextSkuNumber:99});
  assert.deepEqual(normalized.catalogIds,['HW-0001']);assert.equal(normalized.skuCount,1);assert.equal(normalized.nextSkuNumber,99);
  const sparse=new AutoStoreSim({...config(1),catalogIds:['HW-1000000000'],nextSkuNumber:1000000001});
  sparse.addSkus(1);assert.deepEqual(sparse.catalog.map(sku=>sku.id),['HW-1000000000','HW-1000000001']);
  sparse.assertInvariants();
});
