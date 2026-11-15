import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {analyzeLayout,LayoutEditor,paintCells,resizeLayout,makePortCandidate,compareLayouts} from '../dist/layout-editor.js';

const defaultConfig=()=>createDefaultConfig();

test('layout capacity shares runtime equipment, digging reserve, height and compartment rules',()=>{
  const config=defaultConfig(),original=JSON.stringify(config),base=analyzeLayout(config);
  assert.equal(base.stats.capacitySkus,2256);
  assert.equal(base.stats.usableBinCapacity,564);
  assert.equal(base.stats.equipmentReservedCellCount,10);
  assert.equal(base.stats.reserveSlots,124);
  assert.equal(base.stats.operationalSkuCount,1000);
  assert.equal(analyzeLayout({...config,maxHeightM:3.3}).stats.capacitySkus,2820);
  assert.equal(analyzeLayout({...config,compartments:8}).stats.capacitySkus,4512);
  const noPorts=analyzeLayout({...config,ports:[]});
  assert.equal(noPorts.stats.capacitySkus,0,'without an exit route, stock stays unassigned');
  assert.equal(noPorts.stats.operationalSkuCount,0);
  assert.ok(noPorts.inaccessibleKeys.length>0);
  assert.equal(analyzeLayout(config),base,'identical previews reuse analysis');
  assert.equal(JSON.stringify(config),original,'analysis never modifies its input');
});

test('draft previews, undo, redo and slider groups have independent transactional state',()=>{
  const editor=new LayoutEditor(defaultConfig());
  const initial=editor.config;
  const preview=editor.preview({...initial,maxHeightM:3.3});
  assert.equal(preview.stats.capacitySkus,2820);
  assert.equal(editor.config,initial);
  assert.equal(editor.dirty,false);
  assert.equal(editor.canUndo,false);
  assert.ok(Object.isFrozen(editor.baseConfig));
  assert.ok(Object.isFrozen(editor.baseConfig.activeCells));
  editor.replace(preview.config);
  assert.equal(editor.dirty,true);
  editor.beginGroup();
  for(const maxHeightM of[3.63,3.96,4.29])editor.replace({...editor.config,maxHeightM});
  assert.equal(editor.endGroup(),true);
  assert.equal(editor.undo(),true);
  assert.equal(editor.config.maxHeightM,3.3,'one undo restores the whole slider gesture');
  assert.equal(editor.canRedo,true);
  editor.beginGroup();editor.replace({...editor.config,maxHeightM:4.62});
  assert.equal(editor.cancelGroup(),true);
  assert.equal(editor.config.maxHeightM,3.3);
  assert.equal(editor.canRedo,true,'cancelled gesture retains the redo branch');
  editor.redo();assert.equal(editor.config.maxHeightM,4.29);
  editor.undo();editor.undo();
  assert.equal(editor.dirty,false);
  assert.equal(editor.config.maxHeightM,initial.maxHeightM);
  assert.equal(editor.canUndo,false);
  editor.replace({...editor.config,compartments:8});
  assert.equal(editor.canRedo,false,'a committed branch clears redo');
});

test('brush strokes and rectangles are one history step; adjacent shaft deletion reports port impact',()=>{
  const editor=new LayoutEditor(defaultConfig());
  const stroke=[{x:4,z:4},{x:5,z:4},'6,4','100,100'];
  const next=paintCells(editor.config,stroke,'erase');
  assert.equal(next.activeCells.length,93);
  editor.replace(next);editor.undo();
  assert.equal(editor.config.activeCells.length,96);
  assert.equal(editor.canUndo,false);
  const after=editor.preview(paintCells(editor.config,[{x:0,z:6}],'erase'));
  const impact=compareLayouts(editor.analysis,after);
  assert.ok(after.config.ports.some(port=>port.id==='P1'),'deleting a neighbouring shaft/rail keeps the port identity');
  assert.equal(after.sim.ports.find(port=>port.id==='P1').operational,false);
  assert.ok(impact.affectedPortIds.includes('P1'));
  assert.deepEqual(impact.removedKeys,['0,6']);
  assert.ok(impact.inaccessibleKeys.length>0);
  const removed=editor.preview(paintCells(editor.config,['0,7'],'erase'));
  assert.deepEqual(compareLayouts(editor.analysis,removed).removedPortIds,['P1']);
});

test('edge expansion preserves existing holes and shrinking removes only outside cells and ports',()=>{
  const base=paintCells(defaultConfig(),['4,4'],'erase');
  const expanded=resizeLayout(base,13,9);
  assert.equal(expanded.width,13);assert.equal(expanded.depth,9);
  assert.equal(expanded.activeCells.length,95);
  assert.ok(!expanded.activeCells.includes('4,4'));
  assert.equal(expanded.activeCells.includes('12,8'),false);
  assert.deepEqual(expanded.ports,base.ports);
  const small=resizeLayout(expanded,6,4);
  assert.equal(small.activeCells.length,24);assert.equal(small.ports.length,0);
  const clamped=resizeLayout(base,100,-5);
  assert.equal(clamped.width,100);assert.equal(clamped.depth,base.depth);
});

test('port candidates preserve moved identities, share real geometry and distinguish blocked from incomplete designs',()=>{
  const base=defaultConfig(),original=JSON.stringify(base);
  const moved=makePortCandidate(base,{x:3,z:7,portId:'P1',type:'single',snap:false});
  assert.equal(moved.canPlace,true);
  assert.equal(moved.port.id,'P1');assert.equal(moved.port.type,'buffer3');
  assert.equal(moved.port.x,3);assert.equal(moved.port.z,7);
  assert.equal(moved.port.layout.shafts.length,2);
  assert.equal(moved.port.layout.station.widthM,2.114);
  const occupied=makePortCandidate(base,{x:11,z:0,portId:'P1',snap:false});
  assert.equal(occupied.status,'invalid');assert.equal(occupied.canPlace,false);
  assert.match(occupied.reason,/P2/);assert.equal(occupied.port.id,'P1');
  const overlap=makePortCandidate(base,{x:1,z:7,snap:false});
  assert.equal(overlap.status,'invalid');assert.equal(overlap.canPlace,false);
  assert.match(overlap.reason,/겹/);
  const low=makePortCandidate({...base,maxHeightM:.33},{x:3,z:7,portId:'P1',snap:false});
  assert.equal(low.status,'warning');assert.equal(low.canPlace,true);
  assert.match(low.reason,/최소/);
  const nearEdge=makePortCandidate(base,{x:1,z:3});
  assert.deepEqual(nearEdge.placement,{x:0,z:3});assert.equal(nearEdge.snapped,true);
  const interior=makePortCandidate(base,{x:5,z:3});
  assert.deepEqual(interior.placement,{x:5,z:3});assert.equal(interior.snapped,false);
  assert.equal(interior.status,'warning');
  const missing=makePortCandidate(paintCells(base,['5,3'],'erase'),{x:5,z:3,snap:false});
  assert.equal(missing.status,'invalid');assert.equal(missing.canPlace,false);
  assert.ok(missing.port?.layout,'invalid empty-cell candidate still has an accurately sized ghost');
  assert.equal(JSON.stringify(base),original);
});

test('editing and previewing a paused warehouse preserve completed picks, active jobs, inventory, orders and exact bin positions',()=>{
  const live=new AutoStoreSim(defaultConfig());
  const sku=live.catalog.find(sku=>sku.operational),initialQty=sku.qty;
  const request=live.enqueueSku(sku.id,1);live.start();
  let iterations=0;while(!request.pickedQty&&iterations++<4000)live.tick(.5);
  assert.ok(request.pickedQty>0);assert.equal(sku.qty,initialQty-1);live.pause();
  const capture=()=>JSON.stringify({config:live.config,time:live.time,metrics:live.metrics,orders:live.orders,
    stock:live.catalog.map(sku=>[sku.id,sku.qty,sku.binId,sku.compartment]),bins:[...live.bins.values()],
    robots:live.robots,ports:live.ports,locks:[...live.locks],claims:[...live.binClaims]});
  const before=capture(),editor=new LayoutEditor(live.config);
  editor.replace(resizeLayout(editor.config,13,9));
  editor.preview(paintCells(editor.config,['0,7','0,6'],'erase'));
  editor.beginGroup();editor.replace({...editor.config,maxHeightM:3.3});editor.cancelGroup();
  makePortCandidate(editor.config,{x:4,z:8,portId:'P1'});
  editor.undo();editor.redo();
  assert.equal(capture(),before,'all editor operations leave the live warehouse untouched');
  assert.equal(Object.isFrozen(live.config),false,'the caller retains ownership of its runtime config');
  live.assertInvariants();
});
