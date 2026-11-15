import test from 'node:test';
import assert from 'node:assert/strict';
import {SimulationClock} from '../dist/simulation-clock.js';
test('accelerated simulation yields at the frame budget without skipping warehouse state',()=>{
 let clock=0;const slices=[];const sim={running:true,tick(dt){slices.push(dt);clock+=4;}};
 const scheduler=new SimulationClock({budgetMs:6,now:()=>clock});
 assert.ok(Math.abs(scheduler.advance(sim,.1,30)-.1)<1e-9);assert.equal(slices.length,2);assert.ok(slices.every(dt=>dt<=.05));
 assert.ok(scheduler.pending>0);sim.running=false;scheduler.advance(sim,.1,30);assert.equal(scheduler.pending,0);
 sim.running=true;const before=slices.length;scheduler.advance(sim,0,1);assert.equal(slices.length,before,'no delayed burst after pause or speed change');
});
test('normal speed preserves elapsed time and stops as soon as the simulation stops',()=>{
 let time=0;const sim={running:true,tick(dt){time+=dt;}};const scheduler=new SimulationClock({now:()=>0});scheduler.advance(sim,.15,1);assert.ok(Math.abs(time-.15)<1e-8);
 sim.tick=dt=>{time+=dt;sim.running=false;};const before=time;scheduler.advance(sim,.2,30);assert.ok(time-before<=.05+1e-9);assert.equal(scheduler.pending,0);
});
