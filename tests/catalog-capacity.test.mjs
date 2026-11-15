import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig,makeCatalog,normalizeConfig,MAX_SKUS} from '../dist/engine.js';
import {LayoutEditor} from '../dist/layout-editor.js';

test('100,000 distinct SKUs are accepted and configuration/generator caps count rather than identifier value',()=>{
  assert.equal(MAX_SKUS,100000);
  const catalog=makeCatalog(MAX_SKUS+1);
  assert.equal(catalog.length,MAX_SKUS);
  assert.equal(catalog.at(-1).id,'HW-100000');
  assert.equal(new Set(catalog.map(sku=>sku.id)).size,MAX_SKUS);
  assert.equal(new Set(catalog.map(sku=>sku.name)).size,MAX_SKUS);
  const bounded=normalizeConfig({skuCount:MAX_SKUS+1});
  assert.equal(bounded.catalogIds.length,MAX_SKUS);assert.equal(bounded.nextSkuNumber,MAX_SKUS+1);
  const membership=normalizeConfig({catalogIds:['HW-1','HW-0001','invalid',...bounded.catalogIds,'HW-100001']});
  assert.equal(membership.skuCount,MAX_SKUS);assert.equal(membership.catalogIds.at(-1),'HW-100000');
  assert.deepEqual(normalizeConfig({catalogIds:['HW-100001']}).catalogIds,['HW-100001']);
});

test('100k growth, tail lookup, deletion and JSON reload retain identities and physical capacity',()=>{
  const sim=new AutoStoreSim(createDefaultConfig()),kept=sim.catalog.map(sku=>({...sku}));
  const poses=new Map([...sim.bins].map(([id,bin])=>[id,JSON.stringify(bin.location)]));
  assert.equal(sim.setSkuCount(MAX_SKUS).added,99000);
  assert.deepEqual(sim.catalog.slice(0,1000),kept);
  for(const [id,pose]of poses)assert.equal(JSON.stringify(sim.bins.get(id).location),pose);
  const stats=sim.getStats();
  assert.equal(stats.skuCount,MAX_SKUS);assert.equal(stats.capacitySkus,2256);
  assert.equal(stats.assignedSkuCount,stats.capacitySkus);
  assert.equal(stats.unassignedSkuCount,MAX_SKUS-stats.capacitySkus);
  const last=sim.getSkuRows([sim.catalog.at(-1)]);
  assert.equal(last.length,1);assert.equal(last[0].id,'HW-100000');assert.equal(last[0].locationLabel,'미배정');
  assert.throws(()=>sim.addSkus(1),/100,000/);assert.equal(sim.catalog.length,MAX_SKUS);
  assert.throws(()=>sim.setSkuCount(MAX_SKUS+.5),/100,000/);
  assert.equal(sim.removeSkus(['HW-0001','HW-100000']).removed,2);
  assert.equal(sim.addSkus(2).added,2);
  assert.deepEqual(sim.catalog.slice(-2).map(sku=>sku.id),['HW-100001','HW-100002']);
  assert.equal(sim.skuMap.has('HW-0001'),false);assert.equal(sim.skuMap.has('HW-100000'),false);
  const payload=JSON.stringify(sim.config);
  assert.ok(Buffer.byteLength(payload)<5*1024*1024,'100k membership fits the supported design import size');
  const restored=new AutoStoreSim(JSON.parse(payload));
  assert.equal(restored.catalog.length,MAX_SKUS);assert.deepEqual(restored.config.catalogIds,sim.config.catalogIds);
  assert.equal(restored.config.nextSkuNumber,100003);
  assert.equal(restored.skuMap.has('HW-0001'),false);assert.equal(restored.skuMap.has('HW-100000'),false);
  restored.assertInvariants();sim.assertInvariants();
});

test('100k layout edits report capacity shortages and restore full catalog membership through undo',()=>{
  const editor=new LayoutEditor({...createDefaultConfig(),skuCount:MAX_SKUS});
  const baseline=editor.config;
  assert.equal(editor.analysis.stats.skuCount,MAX_SKUS);
  assert.equal(editor.analysis.stats.unassignedSkuCount,97744);
  editor.replace({...editor.config,maxHeightM:3.3});
  assert.equal(editor.analysis.stats.capacitySkus,2820);
  assert.equal(editor.analysis.stats.unassignedSkuCount,MAX_SKUS-2820);
  assert.equal(editor.config.catalogIds.length,MAX_SKUS);assert.equal(editor.dirty,true);
  assert.equal(editor.undo(),true);assert.equal(editor.dirty,false);
  assert.deepEqual(editor.config.catalogIds,baseline.catalogIds);
  assert.equal(editor.analysis.stats.capacitySkus,2256);
});
