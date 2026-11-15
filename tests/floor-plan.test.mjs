import test from 'node:test';
import assert from 'node:assert/strict';
import {floorFromArea,configureFloor,areaInMetres,areaInUnit,floorDimensions} from '../dist/floor-plan.js';
import {normalizeConfig,AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {LayoutEditor,paintCells,resizeLayout} from '../dist/layout-editor.js';
import {RustNavigator} from '../dist/rust-core.js';

test('㎡ and 평 convert without changing floor dimensions or accumulating rounding',()=>{
  const original={widthM:26.987123,depthM:12.249549};let area=original.widthM*original.depthM;
  for(let i=0;i<100;i++)area=areaInMetres(areaInUnit(area,'pyeong'),'pyeong');
  assert.ok(Math.abs(area-original.widthM*original.depthM)<1e-9);
  const floor=floorFromArea(100,'pyeong',8.46,3.84);
  assert.ok(Math.abs(floor.widthM*floor.depthM-40000/121)<1e-9);
  assert.ok(Math.abs(floor.widthM/floor.depthM-8.46/3.84)<1e-12);
});

test('large floor creation retains cells, holes, height and fractional edge space',()=>{
  const base=normalizeConfig(createDefaultConfig());base.activeCells=base.activeCells.filter(k=>k!=='4,4');
  const next=normalizeConfig(configureFloor(base,40.123,25.234));
  assert.equal(next.width,56);assert.equal(next.depth,52);assert.ok(next.width*next.depth>768);
  assert.deepEqual(next.activeCells,base.activeCells);assert.equal(next.maxHeightM,base.maxHeightM);
  assert.deepEqual(floorDimensions(next),{widthM:40.123,depthM:25.234});
  assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(next))),next);
  const expanded=resizeLayout(next,120,80);assert.deepEqual(expanded.activeCells,next.activeCells);
  assert.equal(expanded.width,120);assert.equal(expanded.depth,80);
});

test('a floor larger than former limits supports rectangle and freeform placement, undo and clipping',()=>{
  const base=configureFloor({...createDefaultConfig(),activeCells:[],ports:[],skuCount:0},40,25);
  const editor=new LayoutEditor(base),rectangle=[];
  for(let z=25;z<30;z++)for(let x=35;x<41;x++)rectangle.push(`${x},${z}`);
  editor.replace(paintCells(editor.config,rectangle,'add'));
  assert.equal(editor.config.activeCells.length,30);assert.ok(editor.config.activeCells.includes('40,29'));
  editor.replace(paintCells(editor.config,['40,30','40,31','41,31','42,31'],'add'));
  assert.equal(editor.config.activeCells.length,34);
  editor.replace(paintCells(editor.config,['37,27'],'erase'));assert.equal(editor.config.activeCells.length,33);
  editor.undo();assert.equal(editor.config.activeCells.length,34);editor.undo();assert.equal(editor.config.activeCells.length,30);
  editor.redo();assert.equal(editor.config.activeCells.length,34);
  const shrunk=configureFloor(editor.config,10,5);assert.equal(shrunk.activeCells.length,0);
});

test('Rust routes across a 100 by 80 floor without the previous 32 by 24 cap',()=>{
  const cells=Array.from({length:8000},(_,i)=>`${i%100},${Math.floor(i/100)}`),nav=new RustNavigator(100,80,cells);
  try{const route=nav.path('0,1','99,79',new Set(),-1);assert.equal(route.length,178);assert.equal(route.at(-1),'99,79');assert.equal(nav.reachable('0,1',-1,new Set()).size,7900);}finally{nav.dispose();}
});

test('only empty floor expansion preserves station geometry and warehouse capacity',()=>{
  const original=new AutoStoreSim(createDefaultConfig()),larger=new AutoStoreSim(configureFloor(original.config,40,25));
  assert.deepEqual(larger.ports.map(p=>p.stationLayout),original.ports.map(p=>p.stationLayout));
  assert.equal(larger.getStats().capacitySkus,original.getStats().capacitySkus);
});
