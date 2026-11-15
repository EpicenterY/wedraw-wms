import {SimulationClock} from '../dist/simulation-clock.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {canRefractSurface,MAX_LENS_PIXELS} from '../dist/liquid-glass.js';
const app=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
const visibility=app.slice(app.indexOf('function syncScenePresentation(){'),app.indexOf('function refreshScene(){'));
const frame=app.slice(app.indexOf('function frame(ts){'),app.indexOf('\nrequestAnimationFrame(frame);',app.indexOf('function frame(ts){')));
function harness(sim){
  const result={frames:0,ui:0,motion:0,transitions:[]};
  const state={sim,simulationClock:new SimulationClock(),tab:'design',editMode:false,scenePresentationBlocked:false,lastFrame:0,lastScenePaint:0,lastMotionPaint:0,lastUIPaint:0,dialog:false,
    document:{querySelector:()=>state.dialog?{}:null,body:{classList:{toggle(){}}}},
    scene:{setRenderSuspended:v=>result.transitions.push(v)},
    refreshScene:()=>result.frames++,renderMotion:()=>result.motion++,refresh:()=>result.ui++,requestAnimationFrame(){},
    $:()=>({value:'1'}),toast:message=>{throw Error(message);},console};
  runInNewContext(visibility+'\n'+frame,state);return {state,result};
}
test('modal presentation rests while real Rust jobs and live UI advance; nested dialogs restore once',()=>{
  const sim=new AutoStoreSim(createDefaultConfig());const sku=sim.catalog.find(s=>s.assigned&&s.reachable&&s.qty>0);sim.enqueueSku(sku.id,1);sim.start();
  const {state,result}=harness(sim);state.tab='inventory';
  for(let i=1;i<=20;i++)state.frame(i*50);
  assert.ok(sim.time>=.9);assert.ok(sim.robots.some(r=>r.job),'warehouse still dispatches work behind a modal');
  assert.equal(result.frames,0);assert.equal(result.motion,0);assert.ok(result.ui>=2,'live lists continue updating');assert.deepEqual(result.transitions,[true]);
  state.dialog=true;state.tab='design';state.frame(1050);assert.equal(result.frames,0,'native dialog stays blocking after panel closes');
  state.dialog=false;state.frame(1100);assert.deepEqual(result.transitions,[true,false]);assert.ok(result.frames>0,'close catches up with current state');
  const frames=result.frames;state.tab='inspect';for(let i=1;i<=10;i++)state.frame(1100+i*17);assert.equal(result.frames-frames,10,'interactive inspector keeps the normal scene update cadence');
  sim.pause();const pausedTime=sim.time;state.dialog=true;state.frame(1400);state.dialog=false;state.frame(1450);assert.equal(sim.time,pausedTime);assert.equal(sim.running,false,'closing a dialog never resumes a paused warehouse');
});
test('compact glass retains refraction with a fixed raster budget, including resize and hidden surfaces',()=>{
  assert.ok(canRefractSurface(1248,66),'unified toolbar retains its glass lens');
  for(const [w,h]of [[960,562],[390,640],[2000,100],[0,0],[1,80]])assert.equal(canRefractSurface(w,h),false);
  assert.ok(canRefractSurface(400,MAX_LENS_PIXELS/400));
});
