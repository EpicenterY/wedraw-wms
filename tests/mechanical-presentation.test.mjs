import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig,smoothMotion} from '../dist/engine.js';
import {getRobotPose,buildGripperGeometry,buildRobotWheelGeometry,getVisiblePortBins,PORT_COVER_OPACITY} from '../dist/scene.js';
import {getWheelTravelState,REST_GRIPPER_Y,getRemainingRobotRoute} from '../dist/robot-motion.js';

test('fully retracted lift plate and roof decals share one flat top for every bin height',()=>{
  for(const binHeightM of [.22,.33,.425]){
    const sim=new AutoStoreSim({...createDefaultConfig(),binHeightM}),mc=sim.getMotionConfig(),robot=sim.getRobotVisuals().find(r=>r.available),pose=getRobotPose(robot,mc.railY,binHeightM);
    assert.ok(Math.abs(pose.gripperY-mc.railY+.038-.640)<1e-9);
    assert.ok(pose.belts.every(b=>b.top[1]>=b.bottom[1]));
    for(const loaded of [false,true]){
      const mesh=buildGripperGeometry({loaded});let symbolY=-Infinity;
      for(let i=0;i<mesh.length;i+=9)if(mesh[i+4]>.99&&Math.abs(mesh[i+6]-248/255)<1e-6)symbolY=Math.max(symbolY,mesh[i+1]);
      assert.ok(Math.abs(REST_GRIPPER_Y+symbolY-.6425)<1e-7,'symbol lies at the same plane as the roof symbol');
    }
    sim._navigator.dispose();
  }
});

test('wheel pairs change engagement smoothly at axis changes and stop when simulation pauses',()=>{
  const op={type:'move',segments:[{from:{x:0,z:0},to:{x:2,z:0},duration:2},{from:{x:2,z:0},to:{x:2,z:2},duration:2}]};
  const x=getWheelTravelState(op,1),z=getWheelTravelState(op,3);
  assert.deepEqual(x,{axis:'x',liftX:0,liftZ:.018});assert.deepEqual(z,{axis:'z',liftX:.018,liftZ:0});
  for(const elapsed of [0,2,4]){const w=getWheelTravelState(op,elapsed);assert.equal(w.liftX+w.liftZ,0);}
  const ramp=getWheelTravelState(op,.09);assert.ok(ramp.liftZ>0&&ramp.liftZ<.018);assert.deepEqual(ramp,getWheelTravelState(op,.09));
  const stationary=buildRobotWheelGeometry({bodySign:1}),moving=buildRobotWheelGeometry({bodySign:1,wheels:x});let raised=0,kept=0;
  for(let i=0;i<moving.length;i+=9){assert.equal(moving[i],stationary[i]);assert.equal(moving[i+2],stationary[i+2]);const dy=moving[i+1]-stationary[i+1];if(dy>.0179)raised++;else{assert.ok(Math.abs(dy)<1e-8);kept++;}}
  assert.ok(raised>0&&kept>0);
});

test('Rust reveals a waiting bin after 80% rotation, but picks only after stop and settling',()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),ports:[{id:'P1',x:0,z:7,type:'buffer3'}]});
  sim.enqueueRandom(6);sim.start();let observed=false,closedWhileRotating=false,completed=0;
  for(let tick=0;sim.running&&tick<120000;tick++){
    sim.tick(.1);
    for(const p of sim.ports){
      if(p.rotation){const fraction=smoothMotion(p.rotation.elapsed/p.rotation.duration);assert.equal(p.activeEntryId,null);assert.equal(p.presentation.pickAllowed,false);
        if(p.aperture.state==='closing'&&p.aperture.openness>0){closedWhileRotating=true;assert.ok(p.rotation.elapsed<=.8+1e-7);assert.equal(p.aperture.to,0);}
        else if(p.aperture.openness>0){observed=true;assert.ok(fraction>=.8&&fraction<1);const visual=sim.getPortVisuals().find(v=>v.id===p.id);assert.equal(getVisiblePortBins(visual).length,1);assert.equal(visual.accessibleBinId,null);}
        if(fraction<.8&&p.aperture.state!=='closing')assert.equal(p.aperture.openness,0);
      }
      if(p.activeEntryId){assert.equal(p.rotation,null);assert.ok(p.settleElapsed>=.35);assert.equal(p.aperture.openness,1);completed++;}
    }
    if(tick%20===0)sim.assertInvariants();
  }
  assert.ok(observed,'visible overlap between rotation and opening');assert.ok(closedWhileRotating,'rotation begins before the cover finishes closing');assert.ok(completed>0);assert.equal(sim.getStats().completedOrders,6);assert.equal(PORT_COVER_OPACITY,.95);
  sim._runtime.dispose();sim._navigator.dispose();
});

test('selected robot route starts at its live pose, trims passed turns and reveals only the next committed leg',()=>{
  const move={type:'move',segments:[{from:{x:0,z:0},to:{x:2,z:0},duration:2},{from:{x:2,z:0},to:{x:2,z:2},duration:2}]};
  const future={type:'move',segments:[{from:{x:2,z:2},to:{x:4,z:2},duration:2}]};
  const job={ops:[move,{type:'hoist'},future],index:0,elapsed:1};
  assert.deepEqual(getRemainingRobotRoute({x:1,z:0,job}),[{x:1,z:0},{x:2,z:0},{x:2,z:2}]);
  assert.deepEqual(getRemainingRobotRoute({x:2,z:1,job:{...job,elapsed:3}}),[{x:2,z:1},{x:2,z:2}]);
  assert.deepEqual(getRemainingRobotRoute({x:2,z:2,job:{...job,index:1,elapsed:.5}}),[{x:2,z:2},{x:4,z:2}]);
  assert.deepEqual(getRemainingRobotRoute({x:4,z:2,job:{...job,index:3,elapsed:0}}),[]);
  assert.deepEqual(getRemainingRobotRoute({x:4,z:2,job:null}),[]);
});
