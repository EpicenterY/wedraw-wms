import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {AutoStoreSim, createDefaultConfig, getBinSpec} from '../dist/engine.js';
import {getRobotPose, buildRobotGeometry, getPortLayout, getBinDimensions, buildBinGeometry,
  buildStationGeometry, buildStationApertureGeometry, getStationEnvelope, getVisiblePortBins,
  getBinHighlightPoses, getPortFacingYaw, editorTopFit, createScene} from '../dist/scene.js';

const close = (a,b,message) => assert.ok(Math.abs(a-b)<1e-7,`${message}: ${a} vs ${b}`);

// Whole-floor fit uses nearly all of the limiting axis without clipping.
for(const [width,height,w,d]of [[948,466,9.66,4.2],[366,298,9.66,4.2],[444,621,25,40],[320,220,7050,4800]]){
  const f=editorTopFit({x0:0,x1:w,z0:0,z1:d},width,height),px=w*f.pixelsPerMeter,py=d*f.pixelsPerMeter;
  assert.ok(px<=width-36+1e-6&&py<=height-36+1e-6);
  assert.ok(Math.abs(px-(width-36))<1e-6||Math.abs(py-(height-36))<1e-6,'one axis uses all available space');
}

// The two-cell chassis is independent of the payload and hoist height.
for (const bodySign of [-1,1]) for (const bh of [.22,.33,.425]) {
  const H=bh*4;
  const fixed={id:'R07',x:3,z:4,bodySign,onGrid:true,available:true};
  const ys=[H+.602,H,.015+bh];
  for(const gripperY of ys) for(const loaded of [false,true]) {
    const pose=getRobotPose({...fixed,hoist:{gripperY,binY:gripperY-bh/2,loaded,binId:loaded?'B0010':null}},H,bh);
    close(pose.bodyBaseY,H+.072,'chassis must stay above the rail');
    close(pose.bodyX,3*.705,'body x');
    close(pose.bodyZ,(4+bodySign)*.480,'drive body occupies the adjacent cell');
    assert.equal(pose.belts.length,4);
    const corners=new Set();
    for(const belt of pose.belts){
      close(belt.top[0],belt.bottom[0],'belt x remains vertical');
      close(belt.top[2],belt.bottom[2],'belt z remains vertical');
      close(belt.top[1],H+.635,'fixed belt anchor');
      close(belt.bottom[1],gripperY+.025,'gripper attachment plane');
      assert.ok(belt.top[1]>=belt.bottom[1],'no inverted belt');
      corners.add(`${belt.top[0]},${belt.top[2]}`);
    }
    assert.equal(corners.size,4,'four distinct corners');
    if(loaded)close(pose.binY+bh/2,pose.gripperY,'bin stays attached to the gripper');
  }
  const geometry=buildRobotGeometry(fixed);
  assert.ok(geometry.length>1000&&geometry.length%9===0);
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<geometry.length;i+=9)for(let j=0;j<3;j++){
    assert.ok(Number.isFinite(geometry[i+j]));
    min[j]=Math.min(min[j],geometry[i+j]);max[j]=Math.max(max[j],geometry[i+j]);
  }
  assert.ok(max[0]-min[0]>=.68&&max[0]-min[0]<.73,'R5-like width');
  assert.ok(max[2]-min[2]>=.95&&max[2]-min[2]<1.05,'two-cell R5-like length');
  assert.ok(min[1]>=0&&Math.abs(max[1]-.645)<1e-6,'R5+ height including antenna, above the rail');
}
console.log('PASS two-cell chassis, four distinct vertical belts and attached bin geometry');

function bounds(mesh){
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<mesh.length;i+=9)for(let j=0;j<3;j++){assert.ok(Number.isFinite(mesh[i+j]));min[j]=Math.min(min[j],mesh[i+j]);max[j]=Math.max(max[j],mesh[i+j]);}
  return {min,max};
}
function upwardSurfaceAt(mesh,x,z){
  const ys=[];
  for(let i=0;i<mesh.length;i+=27){
    if(mesh[i+4]<.99)continue;
    const ax=mesh[i],az=mesh[i+2],bx=mesh[i+9],bz=mesh[i+11],cx=mesh[i+18],cz=mesh[i+20];
    const det=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz);if(Math.abs(det)<1e-12)continue;
    const u=((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/det,v=((cz-az)*(x-cx)+(ax-cx)*(z-cz))/det;
    if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)ys.push(mesh[i+1]);
  }
  return ys.length?Math.max(...ys):-Infinity;
}
for(const bh of [.22,.33,.425]){
  const dim=getBinDimensions(bh),physical=getBinSpec(bh);
  close(dim.length,physical.outsideLengthM,'renderer and engine nominal bin length');
  close(dim.width,physical.outsideWidthM,'renderer and engine nominal bin width');
  close(dim.insideDepth,physical.insideHeightM,'renderer and engine inner depth');
  for(const compartments of[1,4,8,16,32]){
    const mesh=buildBinGeometry({id:'B0012',compartments,contents:[]},bh,{detail:'high',contents:true});
    for(const x of[-.226125,-.15075,-.075375,0,.075375,.15075,.226125])for(const z of[-.10075,0,.10075])
      close(upwardSurfaceAt(mesh,x,z),bh/2-physical.insideHeightM,'all logical SKU positions share one open floor without divider walls');
  }
  for(const detail of ['low','medium','high']){
    const mesh=buildBinGeometry({id:'B0012',compartments:1},bh,{detail,contents:false}),b=bounds(mesh);
    close(b.max[0]-b.min[0],.649,'actual geometry has the published 649mm outer length');
    close(b.max[2]-b.min[2],.449,'actual geometry has the published 449mm outer width');
    close(b.min[1],-bh/2,'nominal bin bottom');close(b.max[1],bh/2,'nominal bin top');
    if(detail!=='low'){
      close(upwardSurfaceAt(mesh,0,0),bh/2-physical.insideHeightM,'open centre reaches the real floor, not a solid box lid');
      close(upwardSurfaceAt(mesh,.305,0),bh/2,'rim surrounds the published inner opening');
    }
  }
}
const branded=buildRobotGeometry({id:'R1',bodySign:1});
let ivoryHousing=false,charcoalRoof=false,whiteRoofMark=false,whiteFrontNumber=false,greenSideMark=false,darkSideNumber=false;
const colourIs=(colour,hex)=>[1,3,5].every((offset,index)=>Math.abs(colour[index]-parseInt(hex.slice(offset,offset+2),16)/255)<1e-6);
for(let i=0;i<branded.length;i+=9){
  const colour=[branded[i+6],branded[i+7],branded[i+8]];
  if(colourIs(colour,'#ede9df')&&Math.abs(branded[i+3])>.99&&Math.abs(branded[i])<.332)ivoryHousing=true;
  if(colourIs(colour,'#202628')&&branded[i+4]>.99&&branded[i+1]>.62)charcoalRoof=true;
  if(colourIs(colour,'#f8f8f3')&&branded[i+4]>.99&&Math.abs(branded[i+1]-.6425)<1e-6)whiteRoofMark=true;
  if(colourIs(colour,'#f8f8f3')&&branded[i+5]>.99&&branded[i+1]>.2&&branded[i+1]<.47)whiteFrontNumber=true;
  if(colourIs(colour,'#215732')&&branded[i+3]>.99&&branded[i+1]>.2)greenSideMark=true;
  if(colourIs(colour,'#252b2e')&&Math.abs(branded[i+3])>.99&&Math.abs(branded[i])>.332&&branded[i+1]>.2&&branded[i+1]<.46)darkSideNumber=true;
}
assert.ok(ivoryHousing&&charcoalRoof,'two-tone robot housing uses a light body and dark roof');
assert.ok(whiteRoofMark&&whiteFrontNumber&&greenSideMark&&darkSideNumber,'roof number, front number, left number and right official symbol remain legible');
for(let i=0;i<branded.length;i+=9){
  const colour=[branded[i+6],branded[i+7],branded[i+8]];
  if(colourIs(colour,'#215732'))assert.ok(branded[i+3]>.99,'symbol exists only on the right side');
  if(colourIs(colour,'#f8f8f3')&&branded[i+4]>.99){assert.ok(Math.abs(branded[i])<.24&&Math.abs(branded[i+2]-.480)<.12,'roof white glyphs are confined to the centred numeric label');}
  if(colourIs(colour,'#252b2e')&&branded[i+3]>.99&&branded[i]>.332&&branded[i+1]<.47)assert.fail('right symbol panel must not retain a numeric decal');
}
console.log('PASS published bin envelopes, hollow inner walls/floor, and surface-attached wedraw robot branding');

// Anisotropic grid pitches must not distort the round three-arm carousel.
// Its footprint is a visual concept model, not a building-clearance calculation.
const SX=.705,SZ=.480;
for(const bh of [.22,.33,.425])for(const baseY of [0,.16]){
  for(const [x,z,outX,outZ]of [[0,3,-1,0],[11,3,1,0],[5,0,0,-1],[5,7,0,1]]){
    for(const angle of [0,.17,Math.PI*2/3]){
      const p={id:'P-test',type:'buffer3',x,z,binBaseY:baseY,layout:{angle}};
      const q=getPortLayout(p,{width:12,depth:8,binHeight:bh});
      assert.equal(q.slots.length,3);
      assert.deepEqual([q.outX,q.outZ],[outX,outZ]);
      close(q.hub[0]-q.intake[0],outX*.95,'buffer hub x outside its shaft');
      close(q.hub[1]-q.intake[1],outZ*.95,'buffer hub z outside its shaft');
      close((q.work[0]-q.hub[0])*outX+(q.work[1]-q.hub[1])*outZ,.47,'fallback front picking position');
      for(const s of q.slots){
        close(Math.hypot(s.x-q.hub[0],s.z-q.hub[1]),.47,'fallback circular arm radius in world metres');
        close(s.binY-bh/2,baseY,'port bin bottom follows the actual deck height');
        assert.ok(s.binY-bh/2>=-1e-9,'low ports never put a bin under the floor');
      }
      for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)
        close(Math.hypot(q.slots[i].x-q.slots[j].x,q.slots[i].z-q.slots[j].z),Math.sqrt(3)*.47,'three distinct equally spaced fallback trays');
    }
  }
  const single=getPortLayout({id:'P-single',type:'single',x:4,z:5,binBaseY:baseY},{binHeight:bh});
  assert.equal(single.slots.length,1);
  assert.deepEqual(single.intake,single.hub);
  assert.deepEqual(single.work,[4*SX,5*SZ]);
  close(single.slots[0].binY,baseY+bh/2,'single-port height compatibility');
}
const explicit=getPortLayout({id:'P-explicit',type:'buffer3',x:0,z:7,binBaseY:0,
  layout:{outX:-1,outZ:0,hubX:-2,hubZ:7,workX:-3,workZ:7,intakeX:0,intakeZ:7,angle:.8},
  slots:[{index:0,x:-2.25,z:6.4,binY:.165},{index:1,x:-1.8,z:8.1,binY:.165},{index:2,x:-1.2,z:6.2,binY:.165}]
});
close(explicit.slots[0].x,-2.25*SX,'engine-provided x is converted once');
close(explicit.slots[0].z,6.4*SZ,'engine-provided z is converted once');
assert.deepEqual(explicit.hub,[-2*SX,7*SZ]);
assert.deepEqual(explicit.work,[-3*SX,7*SZ]);
console.log('PASS single / three-bin port layouts and explicit engine world-coordinate conversion');

function stationPanels(port,sim){
  const mc=sim.getMotionConfig(),mesh=buildStationGeometry(port,{width:sim.config.width,depth:sim.config.depth,binHeight:mc.binHeightM,railY:mc.railY}),panels=[];
  for(let i=0;i<mesh.length;i+=54){
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let j=0;j<54;j+=9)for(let k=0;k<3;k++){min[k]=Math.min(min[k],mesh[i+j+k]);max[k]=Math.max(max[k],mesh[i+j+k]);}
    if(max[1]<=mc.portBaseY+1e-6||min[1]>=mc.workHeightM-1e-6)continue;
    const axis=[0,1,2].find(k=>max[k]-min[k]<1e-7);
    if(axis!==undefined)panels.push({axis,min,max});
  }
  return panels;
}

// Sample exactly the same world poses used by the renderer. Every physical bin
// must have one owner, including at grip/release and carousel-slot renumbering.
function observeScene(sim,trace,dt){
  const mc=sim.getMotionConfig(),poses=new Map(),robotVisuals=sim.getRobotVisuals(),portVisuals=sim.getPortVisuals();
  let ownershipChanged=false;
  const put=(id,p,owner)=>{
    assert.ok(!poses.has(id),`duplicate rendered bin ${id}`);
    assert.ok(p.every(Number.isFinite),`finite world pose for ${id}`);
    const old=trace.last.get(id);
    if(old){
      const delta=Math.hypot(p[0]-old.p[0],p[1]-old.p[1],p[2]-old.p[2]);
      // Rail travel is limited to 1.8m/s; lift, shuttle and carousel are slower.
      assert.ok(delta<=1.8*dt+1e-6,`no teleport for ${id}: ${delta}m / ${dt}s (${old.owner} -> ${owner})`);
      if(owner!==old.owner){
        ownershipChanged=true;
        trace.maxHandoffDelta=Math.max(trace.maxHandoffDelta,delta);
        const changes=trace.handoffs.get(id)||[old.owner];changes.push(owner);trace.handoffs.set(id,changes);
      }
    }
    poses.set(id,{p,owner});
  };
  for(const c of sim.cells.values())c.stack.forEach((id,i)=>put(id,[c.x*SX,mc.stackBaseY+(i+.5)*mc.binHeightM,c.z*SZ],'grid'));
  for(const r of robotVisuals){
    if(!r.available)continue;
    const pose=getRobotPose(r,mc.railY,mc.binHeightM);
    close(pose.bodyBaseY,sim.actualHeightM+.072,'chassis never descends during work');
    close(pose.belts[0].top[1]-pose.belts[0].bottom[1],mc.beltTopY-r.hoist.gripperY-mc.beltBottomOffset,'telemetry and rendered belt length agree');
    if(trace.lastY.has(r.id))assert.ok(Math.abs(pose.gripperY-trace.lastY.get(r.id))<=1.15*dt+1e-6,'continuous, speed-bounded vertical motion');
    trace.lastY.set(r.id,pose.gripperY);trace.phases.add(r.hoist.phase);
    if(r.hoist.operation==='move'){
      assert.equal(r.hoist.speedMps,0,'horizontal travel is not vertical speed');
      if(pose.loaded){trace.sawLoadedMove=true;assert.ok(pose.binY-mc.binHeightM/2>mc.railY+.05,'bin fully clears rail before horizontal movement');}
    }
    if(pose.loaded)put(pose.binId,[pose.x,pose.binY,pose.z],'robot');
  }
  for(const pv of portVisuals){
    const q=getPortLayout(pv,{width:sim.config.width,depth:sim.config.depth,binHeight:mc.binHeightM,portBaseY:mc.portBaseY});
    if(!trace.panels.has(pv.id)){trace.panels.set(pv.id,stationPanels(pv,sim));trace.envelopes.set(pv.id,getStationEnvelope(pv,{width:sim.config.width,depth:sim.config.depth,binHeight:mc.binHeightM}));}
    trace.apertures.add(pv.aperture.state);
    trace.portStates.add(pv.status);
    trace.maxPortBins=Math.max(trace.maxPortBins,pv.bins.length);
    trace.maxSeatedBins=Math.max(trace.maxSeatedBins,pv.bins.filter(b=>b.slot!==null).length);
    assert.ok(pv.bins.length<=pv.capacity&&pv.usedSlots<=pv.capacity,'reservations and real bins share the same total capacity');
    assert.equal(q.slots.length,pv.capacity,'one geometric tray for each supported port slot');
    assert.ok(pv.bins.filter(b=>b.status==='picking').length<=1,'only one bin is presented for picking');
    const operatorVisible=getVisiblePortBins(pv),inspectionVisible=getVisiblePortBins(pv,{stationInterior:true});
    assert.ok(operatorVisible.length<=1,'normal operation reveals at most one real bin');
    assert.equal(inspectionVisible.length,pv.bins.length,'explicit inspection reveals all owned buffer bins');
    if(pv.aperture.openness===0)assert.equal(operatorVisible.length,0,'closed cover hides the access opening');
    if(operatorVisible.length)assert.equal(operatorVisible[0].id,pv.presentation.binId,'only the presented bin is exposed');
    if(pv.status==='rotating'){if(pv.rotationProgress<.8&&pv.aperture.state!=='closing'){assert.equal(pv.aperture.state,'closed');assert.equal(pv.aperture.openness,0);}assert.equal(pv.presentation.pickAllowed,false);assert.equal(pv.accessibleBinId,null);}
    if(pv.presentation.pickAllowed){assert.equal(pv.aperture.state,'open');assert.equal(pv.aperture.openness,1);}
    close(q.station.workHeightM,.96,'operator work height stays at 960mm');
    if(pv.type==='buffer3'){
      assert.equal(q.shafts.length,2,'two real rear robot-transfer shafts');
      if(pv.status!=='rotating')for(const slot of q.slots.filter(s=>s.index>0))assert.ok(q.shafts.some(s=>Math.hypot(slot.x-s.x,slot.z-s.z)<1e-7),'each rear tray lines up with its own vertical shaft');
    }
    for(const s of q.slots){
      const raw=pv.slots.find(v=>v.index===s.index);
      close(s.x,raw.x*SX,'actual arm x follows engine rotation');
      close(s.z,raw.z*SZ,'actual arm z follows engine rotation');
      if(pv.type==='buffer3')close(Math.hypot(s.x-q.hub[0],s.z-q.hub[1]),pv.layout.radiusM,'engine carousel stays circular at its shaft-derived radius');
    }
    for(const b of pv.bins){
      trace.binStates.add(b.status);
      close(b.binY,mc.portBaseY+mc.binHeightM/2,'port and rendered bin centre agree');
      assert.ok(b.binY-mc.binHeightM/2>=-1e-9,'port bin stays above the floor');
      put(b.id,[b.x*SX,b.binY,b.z*SZ],'port');
      const min=[b.x*SX-.649/2,b.binY-mc.binHeightM/2,b.z*SZ-.449/2],max=[b.x*SX+.649/2,b.binY+mc.binHeightM/2,b.z*SZ+.449/2];
      for(const x of[min[0],max[0]])for(const z of[min[2],max[2]])assert.ok(trace.envelopes.get(pv.id).rectangles.some(r=>x>=r.minX-1e-7&&x<=r.maxX+1e-7&&z>=r.minZ-1e-7&&z<=r.maxZ+1e-7),'the continuous enclosure includes the whole moving bin footprint');
      for(const panel of trace.panels.get(pv.id)){
        const axis=panel.axis,plane=panel.min[axis];
        if(plane<=min[axis]+1e-5||plane>=max[axis]-1e-5)continue;
        const other=[0,1,2].filter(k=>k!==axis);
        assert.ok(!other.every(k=>Math.min(max[k],panel.max[k])-Math.max(min[k],panel.min[k])>1e-5),`station wall/frame must not cut through moving bin ${b.id}`);
      }
      if(b.slot!==null){const slot=q.slots.find(s=>s.index===b.slot);close(b.x*SX,slot.x,'seated bin x on its rotating tray');close(b.z*SZ,slot.z,'seated bin z on its rotating tray');}
      if(b.status==='picking'){
        close(b.x*SX,q.work[0],'picking only at the fixed front x');
        close(b.z*SZ,q.work[1],'picking only at the fixed front z');
        if(!trace.pickSequence.includes(b.requestId))trace.pickSequence.push(b.requestId);
      }
    }
  }
  assert.equal(poses.size,sim.bins.size,'no physical bin vanishes during a hand-off');
  for(const [id,{p,owner}]of poses){const b=sim.bins.get(id);assert.equal(owner,b.location.type,`render owner agrees with inventory for ${id}`);
    close(p[0],b.location.x*SX,'inventory and render x');close(p[1],b.location.y,'inventory and render y');close(p[2],b.location.z*SZ,'inventory and render z');}
  if(ownershipChanged||trace.frames++%15===0){
    const highlighted=getBinHighlightPoses({levels:sim.levels,binHeight:mc.binHeightM,motionConfig:mc,cells:[...sim.cells.values()].map(c=>({x:c.x,z:c.z,bins:c.stack})),robots:robotVisuals,ports:portVisuals},trace.highlightIds);
    assert.equal(highlighted.length,trace.highlightIds.length,'all requested real bins stay highlighted');
    for(const h of highlighted){const actual=poses.get(h.binId);assert.equal(h.location,actual.owner);close(h.x,actual.p[0],'highlight follows actual x');close(h.y,actual.p[1],'highlight follows actual depth / lift height');close(h.z,actual.p[2],'highlight follows actual z');}
  }
  trace.last=poses;
}
function runSceneCycle(sim,orders,{maxSteps=30000}={}){
  const trace={last:new Map(),lastY:new Map(),phases:new Set(),portStates:new Set(),binStates:new Set(),apertures:new Set(),panels:new Map(),envelopes:new Map(),handoffs:new Map(),pickSequence:[],maxPortBins:0,maxSeatedBins:0,maxHandoffDelta:0,sawLoadedMove:false,frames:0,highlightIds:[...new Set(orders.map(o=>o.binId))]};
  const dt=1/30;let steps=0;observeScene(sim,trace,0);sim.start();
  while(sim.running&&steps++<maxSteps){sim.tick(dt);observeScene(sim,trace,dt);}
  assert.ok(steps<maxSteps,'scene cycle finishes within its time budget');assert.ok(!sim.stalled,'port and robot workflow does not stall');
  for(const o of orders){assert.equal(o.status,'complete');assert.equal(o.pickedQty,o.qty);assert.deepEqual(trace.handoffs.get(o.binId),['grid','robot','port','robot','grid'],'ordered ownership through outbound and return');}
  assert.ok(trace.maxHandoffDelta<.005,'grip/release hand-offs preserve the same physical position');
  assert.ok(trace.sawLoadedMove);sim.assertInvariants();return trace;
}
function nearestTopSkus(sim,count){
  const p=sim.ports[0];return [...sim.cells.values()].filter(c=>!c.isPort&&c.reachable&&c.stack.length)
    .sort((a,b)=>(a.x-p.x)**2+(a.z-p.z)**2-((b.x-p.x)**2+(b.z-p.z)**2)).slice(0,count)
    .map(c=>sim.bins.get(c.stack.at(-1)).skuIds.map(id=>sim.skuMap.get(id)).sort((a,b)=>b.qty-a.qty)[0]);
}

// Existing deep-bin retrieval still exercises every physical hoist phase.
// Picking now belongs to the independent port, not to a parked robot's hoist.
{
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.32});
  const column=[...sim.cells.values()].filter(c=>!c.isPort&&c.reachable&&c.stack.length>=3).sort((a,b)=>b.stack.length-a.stack.length)[0];
  assert.ok(column);const target=sim.bins.get(column.stack[0]),order=sim.enqueueSku(target.skuIds[0],1);
  const trace=runSceneCycle(sim,[order]);
  for(const phase of ['lower-empty','grip','raise-loaded','move','lower-loaded','release','raise-empty'])assert.ok(trace.phases.has(phase),`observed ${phase}`);
  assert.ok(trace.binStates.has('picking'),'independent port picking is observed');
  console.log('PASS continuous digging-cycle poses, single ownership, port hand-offs and rail clearance');
}

// A real three-request run must physically seat all three bins, pick one at a
// time, rotate/transfer continuously, and return the same bins to the grid.
{
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.32,ports:[{id:'P1',x:0,z:7,type:'buffer3'}]});
  const skus=nearestTopSkus(sim,3),before=new Map(skus.map(s=>[s.id,s.qty]));
  const orders=skus.map(s=>sim.enqueueSku(s.id,Math.min(100,s.qty)));
  const trace=runSceneCycle(sim,orders);
  assert.equal(trace.maxPortBins,3,'three real port-owned bins are visible');
  assert.equal(trace.maxSeatedBins,3,'one work tray and two rear trays hold actual bins');
  assert.ok(trace.portStates.has('rotating'));
  for(const state of ['waiting','picking','ready','outbound'])assert.ok(trace.binStates.has(state),`observed port state ${state}`);
  for(const state of ['closed','opening','open','closing'])assert.ok(trace.apertures.has(state),`observed access-cover state ${state}`);
  assert.deepEqual(trace.pickSequence,orders.map(o=>o.id),'FIFO bins are presented one at a time');
  for(const o of orders)assert.equal(sim.skuMap.get(o.skuId).qty,before.get(o.skuId)-o.qty,'inventory is decremented exactly once');
  console.log('PASS two rear shafts, three seated bins, opaque station clearance, cover interlock, FIFO picking and tracked highlights');
}

// A one-layer grid remains editable, but a real-height station cannot operate
// below the published minimum installation levels. No artificial floor-level
// working deck or intersecting pick cycle is substituted for that constraint.
for(const type of ['single','buffer3'])for(const [bh,minLevels]of [[.22,6],[.33,4],[.425,3]]){
  const sim=new AutoStoreSim({...createDefaultConfig(),binHeightM:bh,maxHeightM:bh,ports:[{id:'P1',x:0,z:7,type}]});
  assert.equal(sim.levels,1);assert.ok(sim.rawBinCapacity>0&&sim.cells.size>0,'low-grid design and capacity remain available');
  const p=sim.getPortVisuals()[0];assert.equal(p.operational,false);assert.ok(p.operationalReason.includes(`${minLevels}`));
  close(p.binBaseY+bh,.96,'station work height is preserved rather than lowered into the grid');
  assert.equal(sim.start(),false);assert.equal(sim.running,false);assert.equal(getVisiblePortBins(p).length,0);
  const valid=new AutoStoreSim({...createDefaultConfig(),binHeightM:bh,maxHeightM:bh*minLevels,ports:[{id:'P1',x:0,z:7,type}]});
  assert.equal(valid.levels,minLevels);assert.equal(valid.getPortVisuals()[0].operational,true,'published minimum installation height is accepted');
}
console.log('PASS one-layer layout preservation and published minimum-height station operation gates');

// The access cover physically closes over the work opening and retracts clear.
{
  const sim=new AutoStoreSim(createDefaultConfig()),p=sim.getPortVisuals()[0],q=getPortLayout(p),wh=q.station.workHeightM;
  const closed=buildStationApertureGeometry({...p,aperture:{state:'closed',openness:0}});
  const open=buildStationApertureGeometry({...p,aperture:{state:'open',openness:1}});
  assert.ok(upwardSurfaceAt(closed,q.work[0],q.work[1])>wh,'closed cover has a solid face above the bin opening');
  assert.equal(upwardSurfaceAt(open,q.work[0],q.work[1]),-Infinity,'fully open cover clears the bin centre');
}

// Run the actual CPU renderer and input handlers without a GPU. In normal
// operation even a stale mutating tool selection must never paint the grid.
{
  const names=['document','window','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','ResizeObserver'];
  const original=new Map(names.map(k=>[k,globalThis[k]]));let nextFrame,draws=0,mutationCount=0,lastPainted=null,inspectCount=0,frameData,hoveredCell=null,robotSelected=null,cleared=0;
  const elements=[];
  const element=()=>{const node={style:{},setAttribute(){},appendChild(){},remove(){this.removed=true;this.style.display='none';}};elements.push(node);return node;},parent=element(),listeners=new Map();
  const context={createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),putImageData(image){draws++;frameData=image.data.slice();}};
  Object.assign(globalThis,{document:{hidden:false,createElement:element},window:{devicePixelRatio:1},getComputedStyle:()=>({position:'relative'}),requestAnimationFrame:fn=>(nextFrame=fn,1),cancelAnimationFrame(){},ResizeObserver:class{observe(){}disconnect(){}}});
  const canvas={width:480,height:320,style:{},parentElement:parent,offsetParent:parent,getContext:type=>type==='2d'?context:null,getBoundingClientRect:()=>({left:0,top:0,width:480,height:320}),hasAttribute:()=>false,setAttribute(){},focus(){},setPointerCapture(){},addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener(){}};
  let scene;
  try{
    scene=createScene(canvas,{onCell(x,z){mutationCount++;lastPainted={x,z};},onInspect(){inspectCount++},onInspectRobot(id){robotSelected=id;scene.setSelectedRobot(id);},onClearSelection(){cleared++;scene.setSelected(null);},onHover(x,z){hoveredCell=x<0?null:{x,z};}});
    scene.setData({width:4,depth:4,levels:4,binHeight:.33,cells:Array.from({length:16},(_,i)=>({x:i%4,z:Math.floor(i/4),bins:[]})),robots:[],ports:[]});
    assert.equal(scene.renderer,'software3d');let clock=performance.now()+200;nextFrame(clock+=40);const before=frameData;
    const evt=(x,y)=>({button:0,pointerId:1,pointerType:'mouse',clientX:x,clientY:y,preventDefault(){}});
    scene.setTool('add');listeners.get('pointerdown')(evt(240,160));listeners.get('pointermove')(evt(280,175));listeners.get('pointerup')(evt(280,175));nextFrame(clock+=200);
    assert.equal(mutationCount,0,'default left drag rotates even with a stale add tool');
    assert.equal(inspectCount,0,'dragging does not accidentally inspect');
    assert.notDeepEqual(frameData,before,'perspective camera actually rotates the 3D scene');
    listeners.get('pointerdown')(evt(240,160));listeners.get('pointerup')(evt(240,160));
    assert.equal(inspectCount,1,'normal click uses the separate read-only inspection callback');assert.equal(mutationCount,0);
    scene.setOptions({editing:true});listeners.get('pointerdown')(evt(240,160));listeners.get('pointerup')(evt(240,160));
    assert.equal(mutationCount,1,'explicit edit mode enables the selected placement tool');
    scene.setOptions({editing:false});scene.setTool('erase');listeners.get('pointerdown')(evt(240,160));listeners.get('pointerup')(evt(240,160));
    assert.equal(mutationCount,1,'closing editing prevents a stale erase tool from changing the layout');
    nextFrame(clock+=200);const idleDraws=draws;nextFrame(clock+=200);nextFrame(clock+=200);
    assert.equal(draws,idleDraws,'unchanged CPU frames do not repaint');

    // Real pointer handlers: an edit stroke becomes navigation as soon as a
    // second finger lands. Lifting fingers must not commit the abandoned edit.
    const touch=(id,x,y)=>({...evt(x,y),pointerId:id,pointerType:'touch'});
    const touchMutations=mutationCount,touchInspections=inspectCount;
    scene.setOptions({editing:true});scene.setTool('add');scene.setEditOptions({topView:true,brush:'rectangle'});scene.setView('top');
    const touchBefore=scene.getCameraState();
    listeners.get('pointerdown')(touch(11,200,160));
    listeners.get('pointerdown')(touch(12,280,160));
    listeners.get('pointermove')(touch(11,220,180));
    listeners.get('pointermove')(touch(12,300,180));nextFrame(clock+=200);
    const touchPanned=scene.getCameraState();
    assert.notDeepEqual(touchPanned,touchBefore,'two fingers pan the camera');
    close(touchPanned.zoom,touchBefore.zoom,'parallel finger movement does not change zoom');
    close(touchPanned.yaw,touchBefore.yaw,'two-finger pan does not rotate the view');
    listeners.get('pointermove')(touch(11,180,180));
    listeners.get('pointermove')(touch(12,340,180));nextFrame(clock+=200);
    assert.ok(scene.getCameraState().zoom<touchPanned.zoom,'spreading fingers zooms in');
    listeners.get('pointerdown')(touch(13,240,230));listeners.get('pointerup')(touch(12,340,180));
    listeners.get('pointermove')(touch(13,260,230));
    listeners.get('pointerup')(touch(11,180,180));listeners.get('pointermove')(touch(13,275,240));listeners.get('pointerup')(touch(13,275,240));
    assert.equal(mutationCount,touchMutations,'multi-touch and the remaining finger never place cells');
    assert.equal(inspectCount,touchInspections,'multi-touch never opens cell inspection');
    listeners.get('pointerdown')(touch(11,240,160));listeners.get('pointercancel')(touch(11,240,160));
    listeners.get('pointerup')(touch(11,240,160));assert.equal(mutationCount,touchMutations,'OS touch cancellation discards the draft stroke');
    listeners.get('pointerdown')(touch(14,240,160));listeners.get('pointerup')(touch(14,240,160));
    assert.equal(mutationCount,touchMutations+1,'a new one-finger edit still works after cancellation');
    scene.setOptions({editing:false});scene.setEditOptions({topView:false});scene.setView('fit');nextFrame(clock+=200);

    // A buried inventory target must remain visible as the only red solid,
    // including both carried ownership and a bin behind a closed port cover.
    const target='B0900',cells=Array.from({length:16},(_,i)=>({x:i%4,z:Math.floor(i/4),bins:Array.from({length:4},(_,j)=>({id:i===5&&j===0?target:`B${1000+i*4+j}`,color:'#298bc4',compartments:4}))}));
    const view={width:4,depth:4,levels:4,binHeight:.33,cells,robots:[],ports:[]};
    const redPixels=()=>{let count=0;for(let i=0;i<frameData.length;i+=4)if(frameData[i]>95&&frameData[i]>frameData[i+1]*1.5&&frameData[i]>frameData[i+2]*1.35)count++;return count;};
    const bluePixels=()=>{let count=0;for(let i=0;i<frameData.length;i+=4)if(frameData[i+2]>90&&frameData[i+2]>frameData[i]*1.6&&frameData[i+2]>frameData[i+1]*1.15)count++;return count;};
    scene.setTool('orbit');scene.setView('fit');scene.setOptions({showBins:true,highlightBinIds:['B1021']});scene.setData(view);nextFrame(clock+=200);
    const normalImage=frameData.slice(),normalBlue=bluePixels();assert.ok(normalBlue>500,'normal inventory remains coloured solid geometry');
    scene.setOptions({traceBinId:target});assert.equal(scene.focusBin(target),true);nextFrame(clock+=200);
    assert.ok(redPixels()>80,'deep target appears red through all intervening bins');assert.equal(bluePixels(),0,'other stored bins become neutral cages rather than coloured solids');
    const gridRed=redPixels();
    const traceCamera=scene.getCameraState();
    scene.setOptions({traceBinId:null,traceBinIds:[]});nextFrame(clock+=200);
    assert.equal(scene.getViewMode(),'normal');
    assert.deepEqual(scene.getCameraState(),traceCamera,'leaving wireframe preserves eye, target, zoom, pan and projection');
    assert.ok(bluePixels()>0,'normal mode restores coloured bins at the same camera pose');
    scene.setOptions({traceBinIds:[target,'B1021']});nextFrame(clock+=200);
    assert.equal(scene.getViewMode(),'wireframe');
    assert.deepEqual(scene.getCameraState(),traceCamera,'multiple order targets only switch rendering');
    scene.setOptions({traceBinIds:[],traceBinId:target});nextFrame(clock+=200);

    const redCentroid=()=>{
      let x=0,y=0,count=0;
      for(let i=0;i<frameData.length;i+=4)if(frameData[i]>95&&frameData[i]>frameData[i+1]*1.5&&frameData[i]>frameData[i+2]*1.35){const pixel=i/4;x+=pixel%canvas.width;y+=Math.floor(pixel/canvas.width);count++;}
      assert.ok(count>80,'panning fixture keeps the real target visible');return {x:x/count,y:y/count};
    };
    const panMutationCount=mutationCount,panInspectionCount=inspectCount;
    for(const [dx,dy,shiftKey]of[[24,0,false],[-24,0,false],[0,24,false],[0,-24,false],[0,24,true]]){
      const beforePan=redCentroid(),event=(x,y)=>({...evt(x,y),button:shiftKey?0:1,shiftKey});
      listeners.get('pointerdown')(event(240,160));listeners.get('pointermove')(event(240+dx,160+dy));listeners.get('pointerup')(event(240+dx,160+dy));nextFrame(clock+=200);
      const afterPan=redCentroid();
      assert.ok(dx?Math.sign(dx)*(afterPan.x-beforePan.x)>2:Math.sign(dy)*(afterPan.y-beforePan.y)>2,`${shiftKey?'Shift':'middle-button'} panning moves the target with the drag (${dx}, ${dy})`);
    }
    assert.equal(mutationCount,panMutationCount,'panning never changes the grid');
    assert.equal(inspectCount,panInspectionCount,'panning never triggers a click inspection');
    const pannedCamera=scene.getCameraState();scene.setOptions({traceBinId:null});nextFrame(clock+=200);
    assert.deepEqual(scene.getCameraState(),pannedCamera,'normal rendering retains user panning');
    scene.setOptions({traceBinId:target});nextFrame(clock+=200);

    scene.focusBin(target);nextFrame(clock+=200);
    const plainTrace=frameData.slice(),above=cells[5].bins.slice(1).map(bin=>bin.id),blocker=above.at(-1);
    const grayPixels=()=>{let count=0;for(let i=0;i<frameData.length;i+=4){const values=[frameData[i],frameData[i+1],frameData[i+2]],lo=Math.min(...values),hi=Math.max(...values);if(lo>45&&hi<180&&hi-lo<17)count++;}return count;};
    const mintPixels=()=>{let count=0;for(let i=0;i<frameData.length;i+=4)if(frameData[i+1]>65&&frameData[i+1]>frameData[i]*1.6&&frameData[i+1]>frameData[i+2]*1.09)count++;return count;};
    const visibleLabels=()=>elements.filter(node=>!node.removed&&node.style.display!=='none').map(node=>node.textContent||'');
    const plainGray=grayPixels(),digRobot={id:'R1',x:2.4,z:.3,bodySign:1,onGrid:true,available:true,jobRole:'dig',hoist:{loaded:false,gripperY:1.74}},otherRobot={id:'R2',x:3,z:2,bodySign:1,onGrid:true,available:true,jobRole:'deliver'};
    scene.setData({...view,robots:[digRobot,otherRobot]});
    scene.setOptions({traceBlockerBinIds:[target,...above,...above],traceDiggingTargets:[{binId:target,remainingCount:3}],traceDiggingRobots:[{robotId:'R1',targetBinId:target,blockerBinId:blocker,number:'001',phase:'approaching',phaseLabel:'디깅 위치로 이동 중'}]});nextFrame(clock+=200);
    assert.ok(grayPixels()>plainGray+150,'actual upper bins become distinct neutral solid geometry');
    assert.ok(redPixels()>=gridRed,'gray blockers cannot cover the red target x-ray');
    assert.ok(mintPixels()>40,'the assigned digging robot keeps its two-tone body with a mint outline and small status cue');
    assert.equal(bluePixels(),0,'unrelated stock and robots stay neutral wireframes');
    assert.ok(!visibleLabels().some(text=>text.includes(target)),'order tracking does not force a floating target label');
    assert.ok(!visibleLabels().some(text=>text.includes('로봇 001')),'digging carrier remains highlighted without a floating status label');
    assert.ok(!visibleLabels().some(text=>text.includes('로봇 002')),'unrelated robots are not assigned a digging label');
    const busyContext=frameData.slice(),contextIds=new Set([target,...above]);
    scene.setData({...view,cells:cells.map(c=>({...c,bins:c.bins.filter(bin=>contextIds.has(bin.id))})),robots:[digRobot]});nextFrame(clock+=200);
    let checkedContextPixels=0,changedContextPixels=0;
    for(let i=0;i<frameData.length;i+=4){
      const [r,g,b]=frameData.subarray(i,i+3),lo=Math.min(r,g,b),hi=Math.max(r,g,b);
      if(!(lo>45&&hi<180&&hi-lo<17||r>190&&r>g+2&&g>b+4&&r-b<30))continue;
      checkedContextPixels++;
      if(r!==busyContext[i]||g!==busyContext[i+1]||b!==busyContext[i+2])changedContextPixels++;
    }
    assert.ok(checkedContextPixels>300,'fixture exposes solid gray bins and two-tone robot surfaces');
    assert.equal(changedContextPixels,0,'unrelated foreground cages and robot wires never pierce selected digging solids');
    scene.setData({...view,robots:[digRobot,otherRobot]});nextFrame(clock+=200);
    const contextDraws=draws;
    scene.setOptions({traceDiggingTargets:[{binId:target,remainingCount:2}],traceDiggingRobots:[{robotId:'R1',targetBinId:target,blockerBinId:blocker,number:'001',phase:'lifting',phaseLabel:'빈 인양 중'}]});nextFrame(clock+=200);
    assert.equal(draws,contextDraws+1,'count and work-stage changes invalidate the otherwise idle frame cache');
    assert.ok(!visibleLabels().some(text=>text.includes('상부 2개')||text.includes('로봇 001')),'phase changes do not reintroduce labels');
    nextFrame(clock+=200);assert.equal(draws,contextDraws+1,'unchanged digging inspection does not keep repainting');
    const movingBlocker={...digRobot,x:2.4,z:1,bin:{id:blocker,color:'#298bc4'},hoist:{loaded:true,binId:blocker,binY:1.54,gripperY:1.705}};
    scene.setData({...view,cells:cells.map(c=>({...c,bins:c.bins.filter(b=>b.id!==blocker)})),robots:[movingBlocker,otherRobot]});nextFrame(clock+=200);
    assert.ok(grayPixels()>plainGray+150&&redPixels()>=gridRed,'the removed upper bin stays gray under its moving robot while the target stays red');
    scene.setOptions({traceBinIds:[blocker]});nextFrame(clock+=200);
    assert.ok(redPixels()>gridRed+50,'an upper bin selected as another target is red, never overridden by its gray blocker membership');
    assert.equal(scene.focusDigging(),true);nextFrame(clock+=200);
    assert.ok(redPixels()>0&&mintPixels()>0,'digging fit retains target and carrier geometry');
    assert.ok(!visibleLabels().some(text=>text.includes(target)||text.includes(blocker)||text.includes('로봇 001')),'explicit fit does not restore removed labels');
    scene.setOptions({traceDiggingRobots:[]});nextFrame(clock+=200);
    assert.equal(mintPixels(),0,'a completed digging assignment returns its robot to a wireframe');
    assert.ok(!visibleLabels().some(text=>text.includes('로봇 001')));
    scene.setOptions({traceBinIds:[],traceBlockerBinIds:[],traceDiggingTargets:[],traceDiggingRobots:[]});scene.setData(view);scene.focusBin(target);nextFrame(clock+=200);
    assert.deepEqual(frameData,plainTrace,'clearing context fully restores the original single-bin trace');
    const carrier={id:'R1',x:2.4,z:1,bodySign:1,onGrid:true,available:true,jobRole:'deliver',parentOrderId:'O-FINAL',bin:{id:target,color:'#298bc4'},hoist:{loaded:true,binId:target,binY:1.54,gripperY:1.705,phase:'raise-loaded',operation:'hoist'}};
    const carried={...view,cells:cells.map(c=>({...c,bins:c.bins.filter(b=>b.id!==target)})),robots:[carrier]};
    scene.setData(carried);nextFrame(clock+=200);
    assert.ok(redPixels()>80,'the same red bin survives the grid-to-robot handoff');assert.equal(bluePixels(),0,'robots and carried non-target stock do not add solid coloured geometry');
    const handler={robotId:carrier.id,role:'target',taskKind:'deliver',targetBinId:target,targetBinIds:[target],relatedBinId:target,blockerBinId:null,requestId:'O-FINAL',number:'001',phase:'extracting'};
    scene.setOptions({traceDiggingRobots:[handler]});nextFrame(clock+=200);
    assert.ok(mintPixels()>40&&redPixels()>80,'the final carrier is a solid branded robot with a mint cue while its selected bin remains red');
    assert.ok(!visibleLabels().some(text=>text.includes('로봇 001')),'final carrier uses the highlight without a status label');
    scene.setOptions({traceDiggingRobots:[{...handler,phaseLabel:'목표 빈 포트 운반 중'}]});nextFrame(clock+=200);
    assert.ok(!visibleLabels().some(text=>text.includes('로봇 001')));
    scene.setData({...carried,robots:[{...carrier,parentOrderId:'O-UNRELATED'}]});nextFrame(clock+=200);
    assert.equal(mintPixels(),0,'changing to another request hides a stale highlighted assignment before the next UI refresh');
    assert.ok(!visibleLabels().some(text=>text.includes('로봇 001')));
    scene.setData({...carried,robots:[{...carrier,jobRole:'return'}]});scene.setOptions({traceDiggingRobots:[{...handler,taskKind:'return',phase:'relocating',phaseLabel:'목표 빈 그리드 복귀 중'}]});nextFrame(clock+=200);
    assert.ok(mintPixels()>40&&redPixels()>80,'the return carrier retains the same solid-and-mint treatment');
    assert.ok(!visibleLabels().some(text=>text.includes('목표 빈 그리드 복귀 중')));
    scene.setData({...carried,robots:[{...carrier,jobRole:'idle',parentOrderId:null}]});nextFrame(clock+=200);
    assert.equal(mintPixels(),0,'a finished carrier immediately returns to the neutral scene');
    scene.setOptions({traceDiggingRobots:[]});
    const parked={...carried,robots:[],ports:[{id:'P1',type:'single',x:0,z:3,binBaseY:.63,aperture:{openness:0},bins:[{id:target,color:'#298bc4',x:-1.1,z:3,binY:.795,status:'buffered'}]}]};
    assert.equal(getVisiblePortBins(parked.ports[0]).length,0,'fixture is concealed in normal operator presentation');
    scene.setData(parked);assert.equal(scene.focusBin(target),true);nextFrame(clock+=200);
    assert.ok(redPixels()>80,'a tracked buffer bin stays visible behind a closed port shell');
    scene.setOptions({traceBinId:'missing'});nextFrame(clock+=200);assert.equal(redPixels(),0,'a missing identity never invents a red bin');assert.equal(scene.focusDigging(),false,'digging fit ignores absent targets');
    scene.setData(view);scene.setOptions({traceBinId:target,editing:true});scene.setView('fit');nextFrame(clock+=200);
    assert.ok(bluePixels()>500,'layout editing uses the normal solid renderer even if trace options are stale');
    scene.setOptions({traceBinId:null,editing:false});scene.setView('fit');nextFrame(clock+=200);
    assert.deepEqual(frameData,normalImage,'leaving tracking restores the previous show-bins and order-highlight presentation');
    assert.equal(scene.focusBin('missing'),false);assert.ok(gridRed>80);

    // Exercise both actual application entry points against the real camera,
    // not just a trace option toggle. This catches accidental auto-fit calls.
    const appSource=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
    const appFunction=(name,next)=>appSource.slice(appSource.indexOf(`function ${name}(`),appSource.indexOf(`function ${next}(`));
    const entryPoints=appFunction('setFollow','focusPort')+appFunction('inspectOperation','renderOperationFocus')+appFunction('selectCustomerOrder','clearSelectedOrder');
    const fixedView={...view,robots:[carrier],ports:parked.ports};
    const originalRect=canvas.getBoundingClientRect;
    const assertSamePose=(before,after,label)=>{
      for(const key of ['eye','projection'])before[key].forEach((v,i)=>close(after[key][i],v,`${label} ${key}[${i}]`));
      for(const key of ['zoom','panX','panZ'])close(after[key],before[key],`${label} ${key}`);
    };
    for(const [width,height] of [[480,320],[360,780],[960,720]])for(const camera of ['free','robot','port','operator'])for(const entry of ['selectCustomerOrder','inspectOperation']){
      canvas.getBoundingClientRect=()=>({left:0,top:0,width,height});scene.resize();scene.setData(fixedView);scene.setView('fit');
      scene.setOptions({traceBinId:null,traceBinIds:[]});
      if(camera==='robot')scene.focusRobot('R1');
      if(camera==='port'||camera==='operator')scene.focusPort('P1',{operator:camera==='operator'});
      listeners.get('wheel')({deltaY:-160,preventDefault(){}});
      const pan=(x,y)=>({...evt(x,y),button:1});listeners.get('pointerdown')(pan(240,160));listeners.get('pointermove')(pan(260,172));listeners.get('pointerup')(pan(260,172));
      const before=scene.getCameraState(),label=`${entry} from ${camera} at ${width}x${height}`;
      const context={scene,editMode:false,sim:{pause(){}},book:{update(){}},orderFocus:{clear(){},select:()=>({binIds:[target],missingSkuIds:[]})},
        $:()=>({value:'',checked:false}),getOperationGroups:()=>[{key:'ORDER',availableBinIds:[target]}],
        clearInventoryTrace:()=>scene.setOptions({traceBinId:null,traceBinIds:[]}),dismissCelebration(){},setEditMode(){},
        refreshScene:()=>scene.setOptions({followRobotId:null}),closePanel:()=>scene.setOptions({traceBinIds:[target]}),toast:message=>assert.fail(message)};
      // Successful customer selection emits a normal informational toast.
      context.toast=message=>{if(!String(message).includes('와이어프레임'))assert.fail(message);};
      runInNewContext(`${entryPoints}\n${entry}('ORDER');`,context);
      assert.equal(scene.getViewMode(),'wireframe');assertSamePose(before,scene.getCameraState(),label);
      scene.setData({...fixedView,robots:[{...carrier,x:carrier.x+1}]});
      assertSamePose(before,scene.getCameraState(),`${label} after robot moves`);
      scene.setOptions({traceBinIds:[]});assertSamePose(before,scene.getCameraState(),`${label} after clearing trace`);
      const frozen=scene.getCameraState();scene.focusBins([target]);
      assert.notDeepEqual(scene.getCameraState().eye,frozen.eye,'explicit fit remains available');
      close(scene.getCameraState().yaw,getPortFacingYaw(fixedView),'explicit bin fit faces ports');
      scene.setView('fit');close(scene.getCameraState().yaw,getPortFacingYaw(fixedView),'whole grid fit faces ports');
    }
    canvas.getBoundingClientRect=originalRect;
    scene.resize();
    const pickView=progress=>({width:4,depth:4,levels:4,binHeight:.33,cells:[],robots:[],ports:[{id:'P1',type:'single',x:0,z:0,binBaseY:.63,layout:{outX:0,outZ:1},aperture:{state:'open',openness:1},presentation:{pickAllowed:true,binId:'B0032'},bins:[{id:'B0032',x:0,z:0,binY:.795,status:'picking',progress}]}]});
    const parcelPixels=[];
    for(const wire of[false,true]){
      scene.setOptions({traceBinId:wire?'B0032':null,traceBinIds:[],traceBlockerBinIds:[],traceDiggingRobots:[],highlightBinIds:[]});
      scene.setData(pickView(.05));scene.focusPort('P1',{operator:true});nextFrame(clock+=40);const low=frameData.slice(),beforePick=draws;
      scene.setData(pickView(.16));nextFrame(clock+=40);assert.equal(draws,beforePick+1,'picking progress alone invalidates the renderer cache');assert.notDeepEqual(frameData,low,'picking parcels move in '+(wire?'wireframe':'normal')+' mode');
      const paused=draws;nextFrame(clock+=40);assert.equal(draws,paused,'paused picking does not animate or repaint');
      scene.setData(pickView(.52));nextFrame(clock+=40);
      let tan=0;for(let i=0;i<frameData.length;i+=4){const [r,g,b]=frameData.slice(i,i+3);if(r-g>9&&r-g<28&&g-b>18&&g-b<45)tan++;}
      assert.ok(tan>40,'the scanned parcel is visible');parcelPixels.push(tan);
    }
    assert.ok(parcelPixels[1]>=parcelPixels[0]*.95,'the red x-ray bin cannot cover a parcel above its rim');
    // The closed hoist head sits above the tracked bin. Both surfaces must
    // share physical depth rather than repainting a red bin over the plate.
    for(const gripperY of[.60,1.05,1.705]){
      const lifted={...carrier,hoist:{...carrier.hoist,gripperY,binY:gripperY-.165}};
      scene.setSelected(null);listeners.get('pointerleave')();
      scene.setOptions({traceBinId:target,traceBinIds:[],traceBlockerBinIds:[],traceDiggingRobots:[handler]});
      scene.setData({...view,cells:[],robots:[lifted]});scene.focusBin(target);nextFrame(clock+=200);
      const m=scene.getCameraState().projection,p=[lifted.x*.705+.20,gripperY+.039,lifted.z*.480+.04,1],v=[0,1,2,3].map(row=>p.reduce((n,a,i)=>n+m[i*4+row]*a,0));
      const px=Math.round((v[0]/v[3]+1)*canvas.width/2),py=Math.round((1-v[1]/v[3])*canvas.height/2),i=(py*canvas.width+px)*4;
      const [r,g,b]=frameData.slice(i,i+3);
      assert.ok(g>r&&b>=g,'the real gray hoist plate, not the red bin, is visible above its rim at '+gripperY+'m: '+[r,g,b]);
    }
    // Exercise pointer events against both real raster paths. Preview all
    // stored levels without opening inspection, moving the camera or persisting.
    const hoverView={width:4,depth:4,levels:4,binHeight:.33,robots:[],ports:[],cells:[
      {x:1,z:1,bins:Array.from({length:4},(_,i)=>({id:'hover-'+i,color:'#398bc2'}))},
      {x:3,z:2,bins:[{id:'red-target',color:'#398bc2'}]}
    ]};
    const project=(x,y,z)=>{
      const m=scene.getCameraState().projection,p=[x,y,z,1],v=[0,1,2,3].map(row=>p.reduce((n,a,i)=>n+m[i*4+row]*a,0));
      return [(v[0]/v[3]+1)*canvas.width/2,(1-v[1]/v[3])*canvas.height/2];
    };
    const changedNear=(a,b,x,y)=>{
      let changed=0;for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){
        const px=Math.round(x)+dx,py=Math.round(y)+dy;if(px<0||py<0||px>=canvas.width||py>=canvas.height)continue;
        const i=(py*canvas.width+px)*4;if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>5)changed++;
      }return changed;
    };
    for(const wire of[false,true]){
      listeners.get('pointerleave')();scene.setSelected(null);scene.setOptions({editing:false,showBins:true,traceBinId:wire?'red-target':null,traceBinIds:[],highlightBinIds:[]});
      scene.setData(hoverView);scene.setView('fit');nextFrame(clock+=200);
      const baseline=frameData.slice(),camera=scene.getCameraState(),inspected=inspectCount,mutations=mutationCount;
      const point=project(.705,1.37,.480);
      listeners.get('pointermove')(evt(...point));nextFrame(clock+=40);assert.deepEqual(hoveredCell,{x:1,z:1});
      const preview=frameData.slice();assert.notDeepEqual(preview,baseline,'hover changes the rendered stack');
      for(let level=0;level<4;level++){
        const p=project(.705+.20,.015+(level+.5)*.33,.480+.2245);
        assert.ok(changedNear(preview,baseline,...p)>2,'hover shades stored level '+(level+1)+' in '+(wire?'wire':'normal'));
      }
      assert.deepEqual(scene.getCameraState(),camera);assert.equal(inspectCount,inspected);assert.equal(mutationCount,mutations);
      const hoveredDraws=draws;listeners.get('pointermove')(evt(point[0]+.1,point[1]+.1));nextFrame(clock+=40);
      assert.equal(draws,hoveredDraws,'moving within a cell does not repaint');
      scene.setSelected({x:1,z:1});nextFrame(clock+=40);const clicked=frameData.slice();
      assert.notDeepEqual(clicked,preview,'selection is visibly stronger than hover');
      listeners.get('pointerleave')();nextFrame(clock+=40);assert.deepEqual(frameData,clicked,'hover exit does not remove selection');
      scene.setSelected(null);nextFrame(clock+=40);assert.deepEqual(frameData,baseline,'preview leaves no residue');
      listeners.get('pointermove')({...evt(...point),pointerType:'touch'});nextFrame(clock+=40);
      assert.deepEqual(frameData,baseline,'touch does not leave a sticky hover');
      listeners.get('pointermove')(evt(...point));nextFrame(clock+=40);
      listeners.get('pointerdown')(evt(...point));nextFrame(clock+=40);assert.deepEqual(frameData,baseline,'starting navigation clears the preview');
      listeners.get('pointercancel')();nextFrame(clock+=40);
      if(wire){
        scene.setOptions({traceBinId:'hover-0'});nextFrame(clock+=40);const redBefore=redPixels();
        listeners.get('pointermove')(evt(...point));nextFrame(clock+=40);
        assert.equal(redPixels(),redBefore,'hover never washes out the red tracked bin');
      }
    }
    // Selection is a temporary view layer, independent of camera yaw or tracing.
    scene.setData(hoverView);scene.setOptions({traceBinId:null,traceBinIds:[]});scene.setView('fit');listeners.get('pointerleave')();
    for(let angle=0;angle<4;angle++){
      if(angle)for(let i=0;i<13;i++)listeners.get('keydown')({key:'ArrowRight',preventDefault(){}});
      nextFrame(clock+=200);const camera=scene.getCameraState();
      scene.setSelected({x:1,z:1});nextFrame(clock+=200);
      assert.equal(scene.getViewMode(),'wireframe');assert.deepEqual(scene.getCameraState(),camera);
      let green=0;for(let i=0;i<frameData.length;i+=4)if(frameData[i+1]>frameData[i]*1.12&&frameData[i+1]>frameData[i+2]*1.04)green++;
      assert.ok(green>100,'selected stack visible at yaw '+angle);
      listeners.get('pointerdown')(evt(4,4));listeners.get('pointerup')(evt(4,4));nextFrame(clock+=200);
      assert.equal(scene.getViewMode(),'normal');assert.deepEqual(scene.getCameraState(),camera);
    }
    assert.equal(cleared,4,'background click clears transient selection');
    scene.setOptions({traceBinId:'red-target'});scene.setSelected({x:1,z:1});scene.setSelected(null);assert.equal(scene.getViewMode(),'wireframe','deselect restores an existing trace');
    scene.setOptions({traceBinId:null});
    const selectedRobot={id:'R42',x:1,z:1,bodySign:1,onGrid:true,available:true,jobRole:'deliver',jobTargetBinId:'red-target',hoist:{gripperY:1.922,loaded:false}};
    scene.setData({...hoverView,robots:[selectedRobot]});scene.setView('fit');nextFrame(clock+=200);
    const robotCamera=scene.getCameraState(),robotPoint=project(.705,1.965,.96);
    listeners.get('pointerdown')(evt(...robotPoint));listeners.get('pointerup')(evt(...robotPoint));nextFrame(clock+=200);
    assert.equal(robotSelected,'R42');assert.equal(scene.getViewMode(),'wireframe');assert.deepEqual(scene.getCameraState(),robotCamera);
    assert.ok(elements.some(n=>!n.removed&&n.textContent?.includes('red-target · 다음 작업 빈')));
    const beforeRoute=frameData.slice();
    scene.setData({...hoverView,robots:[{...selectedRobot,route:[{x:1,z:1},{x:3,z:1},{x:3,z:3}]}]});nextFrame(clock+=200);
    assert.notDeepEqual(frameData,beforeRoute,'selected robot route renders even with global paths disabled');
    assert.ok(changedNear(frameData,beforeRoute,...project(2*.705,1.395,.480))>1,'remaining route is visible on the rails');
    assert.deepEqual(scene.getCameraState(),robotCamera,'path display never moves the camera');
    scene.setData({...hoverView,robots:[selectedRobot]});nextFrame(clock+=200);assert.deepEqual(frameData,beforeRoute,'cleared route leaves no trail');
    scene.setData({...hoverView,robots:[{...selectedRobot,jobRole:'idle',jobTargetBinId:null}]});nextFrame(clock+=200);
    assert.ok(!elements.some(n=>!n.removed&&n.textContent?.includes('다음 작업 빈')),'finished assignment removes its old bin highlight');
    scene.setSelected(null);assert.equal(scene.getViewMode(),'normal');
    // Bare floor holes are background in normal/wireframe views, but remain paintable.
    const sparse={...hoverView,robots:[],ports:[],cells:[hoverView.cells[0]]};
    scene.setData(sparse);scene.setView('top');scene.setTool('orbit');nextFrame(clock+=200);
    for(const wire of [false,true]){
      scene.setOptions({traceBinIds:wire?[sparse.cells[0].bins[0].id]:[],traceBinId:null});nextFrame(clock+=200);
      const hole=project(3*.705,0,3*.480),inspected=inspectCount,clearedBefore=cleared;
      listeners.get('pointermove')(evt(...hole));assert.equal(hoveredCell,null,'missing floor cells never hover');
      listeners.get('pointerdown')(evt(...hole));listeners.get('pointerup')(evt(...hole));
      assert.equal(inspectCount,inspected,'missing floor cells never open an inspector');assert.equal(cleared,clearedBefore+1,'a hole clears selection like the background');
    }
    scene.setOptions({editing:true,traceBinIds:[]});scene.setEditOptions({topView:true});scene.setTool('add');nextFrame(clock+=200);
    const floorPoint=project(3*.705,0,3*.480),painted=mutationCount;
    listeners.get('pointerdown')(evt(...floorPoint));listeners.get('pointerup')(evt(...floorPoint));assert.equal(mutationCount,painted+1,'editor can still place a cell on bare floor');
    // A docked settings pane changes both canvas origin and aspect. Placement
    // must still hit the intended floor cell after opening, closing and rotating.
    for(const rect of [{left:345,top:180,width:731,height:719},{left:12,top:420,width:366,height:270},{left:16,top:180,width:1060,height:719}]){
      const before=scene.getCameraState();canvas.getBoundingClientRect=()=>rect;scene.resize();nextFrame(clock+=200);
      const after=scene.getCameraState();for(const key of ['yaw','pitch','zoom','panX','panZ'])close(after[key],before[key],'resize preserves '+key);
      const point=project(3*.705,0,3*.480),count=mutationCount;
      listeners.get('pointerdown')(evt(rect.left+point[0],rect.top+point[1]));listeners.get('pointerup')(evt(rect.left+point[0],rect.top+point[1]));
      assert.equal(mutationCount,count+1);assert.deepEqual(lastPainted,{x:3,z:3},'offset canvas paints the intended cell');
      for(const handle of elements.filter(e=>e.textContent==='+ 열'||e.textContent==='+ 행'))assert.ok(parseFloat(handle.style.top)>=26&&parseFloat(handle.style.top)<=rect.height-26,'expansion handle stays inside the remaining canvas');
    }
    canvas.getBoundingClientRect=()=>({left:12,top:412,width:366,height:298});scene.resize();
    scene.setData({...sparse,width:12,depth:8});scene.setView('fit');scene.setView('top');scene.zoomToCells();nextFrame(clock+=200);
    const cellA=project(5*.705,0,3*.480),cellB=project(5*.705,0,4*.480);
    assert.ok(Math.abs(cellB[1]-cellA[1])>=44-.01,'cell enlargement gives a 44 CSS-pixel short edge');
    scene.setTool('orbit');const mutationsBeforePan=mutationCount,poseBeforePan=scene.getCameraState();
    listeners.get('pointerdown')({...evt(180,530),pointerType:'touch'});listeners.get('pointermove')({...evt(222,562),pointerType:'touch'});listeners.get('pointerup')({...evt(222,562),pointerType:'touch'});nextFrame(clock+=200);
    const moved=project(5*.705,0,3*.480);assert.ok(Math.abs(moved[0]-cellA[0]-42)<.01&&Math.abs(moved[1]-cellA[1]-32)<.01,'single-finger plane pan follows the finger in CSS pixels');
    assert.equal(mutationCount,mutationsBeforePan);close(scene.getCameraState().pitch,poseBeforePan.pitch,'plane pan never rotates');
    scene.setTool('erase');const picked=project(5*.705,0,3*.480);listeners.get('pointerdown')(evt(12+picked[0],412+picked[1]));listeners.get('pointerup')(evt(12+picked[0],412+picked[1]));assert.deepEqual(lastPainted,{x:5,z:3},'zoomed and panned cell keeps its hit target');
    scene.setView('fit');scene.setView('top');close(scene.getCameraState().zoom,1,'whole grid restores fit');close(scene.getCameraState().panX,0,'whole grid restores centre');
    scene.setView('iso');const m=scene.getCameraState().projection;
    for(const x of[-.705/2,11.5*.705])for(const y of[0,4*.33+.75])for(const z of[-.480/2,7.5*.480]){
      const p=[x,y,z,1],v=[0,1,2,3].map(row=>p.reduce((sum,a,i)=>sum+m[i*4+row]*a,0));
      assert.ok(Math.abs(v[0]/v[3])<1&&Math.abs(v[1]/v[3])<1,'tight perspective fit keeps the 3D envelope visible');
    }
    canvas.getBoundingClientRect=originalRect;scene.resize();
    scene.setOptions({editing:false});scene.setTool('orbit');scene.setView('fit');scene.setData({...hoverView,robots:[selectedRobot]});nextFrame(clock+=200);
    const frozen=frameData.slice(),frozenDraws=draws,frozenCamera=scene.getCameraState();scene.setRenderSuspended(true);
    for(let i=1;i<=20;i++){scene.setData({...hoverView,robots:[{...selectedRobot,x:1+i*.05}]});nextFrame(clock+=40);}
    assert.equal(draws,frozenDraws,'modal background performs zero raster frames while state advances');assert.deepEqual(frameData,frozen);
    scene.resize();assert.deepEqual(frameData,frozen,'resize does not clear the captured background');
    scene.setRenderSuspended(false);nextFrame(clock+=200);assert.equal(draws,frozenDraws+1,'closing renders the latest state once');assert.notDeepEqual(frameData,frozen);assert.deepEqual(scene.getCameraState(),frozenCamera,'modal does not move the camera');
  }finally{
    scene?.destroy();for(const [key,value]of original)if(value===undefined)delete globalThis[key];else globalThis[key]=value;
  }
}
console.log('PASS physical cover clearance, default orbit/read-only inspection, explicit editing, idle CPU rendering and red inventory trace through grid/robot/closed-port ownership');
