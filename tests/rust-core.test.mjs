import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {RustNavigator,coreDiagnostics,smoothMotion,smoothVelocity,motionDuration,storageCapacity} from '../dist/rust-core.js';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {graphFor,path,reachable} from './reference-navigation.mjs';

test('the shipped wasm matches the build manifest and runs the expected ABI',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../dist/wasm/build.json',import.meta.url)));
  const bytes=await readFile(new URL('../dist/wasm/warehouse_core.wasm',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.sha256);
  assert.equal(bytes.length,manifest.bytes);
  assert.equal(coreDiagnostics().backend,'rust-wasm');assert.equal(coreDiagnostics().abi,1);
});

test('Rust preserves exact BFS ties, two-cell clearance and ordered reachability on 100 irregular grids',()=>{
  let seed=0xbee;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  const before=coreDiagnostics();
  for(let iteration=0;iteration<100;iteration++){
    const width=1+Math.floor(random()*32),depth=1+Math.floor(random()*24);
    const all=Array.from({length:width*depth},(_,i)=>`${i%width},${Math.floor(i/width)}`),active=all.filter(()=>random()>.18);
    const rust=new RustNavigator(width,depth,active);
    try{for(const sign of[-1,1]){
      const graph=graphFor(active,sign);
      for(let query=0;query<30;query++){
        const blocked=new Map(all.filter(()=>random()<.06).map(k=>[k,0]));blocked.set('99,99',false);
        const from=query===0?'missing':all[Math.floor(random()*all.length)],to=query===1?from:all[Math.floor(random()*all.length)];
        assert.deepEqual(rust.path(from,to,blocked,sign),path(graph,from,to,blocked));
        assert.deepEqual([...rust.reachable(from,sign,blocked)],[...reachable(graph,from,blocked)]);
      }
    }}finally{rust.dispose();}
  }
  assert.equal(coreDiagnostics().liveGrids,before.liveGrids);
  assert.equal(coreDiagnostics().path-before.path,6000);
});

test('mask replacement, isolated editor grids, memory growth and disposal do not contaminate routes',()=>{
  const before=coreDiagnostics().liveGrids;
  const keys=Array.from({length:24},(_,i)=>`${i%6},${Math.floor(i/6)}`);
  const first=new RustNavigator(6,4,keys),expected=first.path('0,1','5,1',new Set(),-1);
  const others=[];
  try{
    assert.equal(first.path('0,1','5,1',new Set(['5,0']),-1),null);
    assert.deepEqual(first.path('0,1','5,1',new Set(),-1),expected);
    for(let i=0;i<160;i++)others.push(new RustNavigator(32,24,[]));
    assert.equal(others[0].path('0,1','5,1',new Set(),-1),null);
    assert.deepEqual(first.path('0,1','5,1',new Set(),-1),expected);
    first.dispose();first.dispose();assert.throws(()=>first.path('0,1','5,1',new Set(),-1),/disposed/);
  }finally{first.dispose();for(const grid of others)grid.dispose();}
  assert.equal(coreDiagnostics().liveGrids,before);
  const expanded=new RustNavigator(64,48,[]);expanded.dispose();
  assert.throws(()=>new RustNavigator(0,24,[]),/dimensions/);
});

test('Rust capacity and kinematics preserve the v1.1.0 formulas across supported ranges',()=>{
  for(let cells=0;cells<=768;cells++)for(const levels of[1,3,4,8,14,18,26])for(const reserve of[.1,.18,.4]){
    const raw=cells*levels;let expected=Math.max(0,Math.min(Math.floor(raw*(1-reserve)),raw-(levels-1)));
    if(cells<2)expected=Math.min(expected,1);
    assert.equal(storageCapacity(cells,levels,reserve),expected);
  }
  for(let i=-100;i<=1100;i++){
    const value=i/1000,t=Math.min(1,Math.max(0,value));
    assert.ok(Math.abs(smoothMotion(value)-t*t*t*(10+t*(-15+6*t)))<1e-12);
    assert.ok(Math.abs(smoothVelocity(value)-30*t*t*(1-t)*(1-t))<1e-12);
    const distance=i/100;
    assert.equal(motionDuration(distance),Math.max(.65,1.875*Math.abs(distance)/1.15,Math.sqrt(5.774*Math.abs(distance)/2)));
  }
});

class ReferenceSim extends AutoStoreSim {
  _reachableNodes(from,sign,blocked=new Set()){return reachable(this._motionNodes.get(sign),from,blocked);}
  path(from,to,blocked=this.locks,sign=-1){return path(this._motionNodes.get(sign),from,to,blocked);}
}
const rectangle=(width,depth,robots)=>({...createDefaultConfig(),width,depth,robotCount:robots,maxHeightM:1.32,skuCount:160,
  activeCells:Array.from({length:width*depth},(_,i)=>`${i%width},${Math.floor(i/width)}`),
  ports:[{id:'P1',x:0,z:depth-1,type:'single'},{id:'P2',x:width-1,z:0,type:'single'}]});

for(const [name,config]of[['deep digging and buffer port',createDefaultConfig()],['congested grid',rectangle(5,4,4)],['30 robots',rectangle(16,12,30)]]){
  test(`full fulfillment matches the original JS navigation: ${name}`,()=>{
    const rust=new AutoStoreSim(config),reference=new ReferenceSim(config);
    try{
      assert.deepEqual(rust.snapshot(),reference.snapshot());
      for(const sim of[rust,reference]){
        if(name.startsWith('deep')){
          const cell=[...sim.cells.values()].filter(c=>c.operational&&c.stack.length>2).sort((a,b)=>b.stack.length-a.stack.length)[0];
          const sku=sim.bins.get(cell.stack[0]).skuIds[0];sim.enqueueSku(sku,1,{priority:'urgent'});
        }
        sim.enqueueRandom(6);assert.equal(sim.start(),true);
      }
      let steps=0;
      while((rust.running||reference.running)&&steps++<16000){
        rust.tick(.5);reference.tick(.5);
        if(steps%80===0){rust.assertInvariants();reference.assertInvariants();assert.deepEqual(rust.snapshot(),reference.snapshot());}
      }
      assert.ok(steps<16000);assert.equal(rust.stalled,false);
      assert.ok(rust.orders.every(order=>order.status==='complete'));
      rust.assertInvariants();reference.assertInvariants();assert.deepEqual(rust.snapshot(),reference.snapshot());
      assert.equal(rust.locks.size,0);
    }finally{rust._navigator.dispose();reference._navigator.dispose();}
  });
}

test('reconfiguration explicitly releases the previous grid',()=>{
  const initial=coreDiagnostics().liveGrids;
  const sim=new AutoStoreSim({...createDefaultConfig(),robotCount:1,skuCount:10});
  try{for(let i=0;i<20;i++)sim.reconfigure({...sim.config,maxHeightM:i%2?1.32:2.64});
    assert.equal(coreDiagnostics().liveGrids,initial+1);sim.assertInvariants();
  }finally{sim._navigator.dispose();}
});
