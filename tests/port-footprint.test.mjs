import assert from 'node:assert/strict';
import test from 'node:test';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {buildStationGeometry,buildStationApertureGeometry,getStationEnvelope,getBarcodeReaderPose} from '../dist/scene.js';

const SX=.705,SZ=.480,EPS=2e-6;
const sides=[['west',0,4,-1,0],['east',11,4,1,0],['north',6,0,0,-1],['south',6,7,0,1]];
const fixtures=[];
for(const binHeightM of [.22,.33,.425])for(const [side,x,z,outX,outZ]of sides){
  const sim=new AutoStoreSim({...createDefaultConfig(),binHeightM,maxHeightM:6,robotCount:1,skuCount:16,ports:[{id:'P1',type:'buffer3',x,z}]});
  const port=sim.ports[0],visual=sim.getPortVisuals()[0],mc=sim.getMotionConfig();
  const options={width:sim.config.width,depth:sim.config.depth,binHeight:binHeightM,railY:mc.railY};
  fixtures.push({name:`${side} / ${binHeightM*1000} mm`,sim,port,visual,mc,options,outX,outZ,
    envelope:getStationEnvelope(visual,options),mesh:buildStationGeometry(visual,options)});
}

function triangles(mesh){
  const faces=[];
  for(let i=0;i<mesh.length;i+=27){
    const vertices=[0,9,18].map(offset=>Array.from(mesh.slice(i+offset,i+offset+3)));
    const min=[0,1,2].map(k=>Math.min(...vertices.map(p=>p[k]))),max=[0,1,2].map(k=>Math.max(...vertices.map(p=>p[k])));
    assert.ok([...min,...max].every(Number.isFinite),'all rendered furniture coordinates are finite');
    faces.push({vertices,min,max});
  }
  return faces;
}
// Clip the actual triangle into a slightly inset 3-D box. This also catches a
// large roof/wall crossing a cell even when none of its vertices lie in it.
function cutsBox(face,box,margin=EPS){
  const lo=box.min.map(v=>v+margin),hi=box.max.map(v=>v-margin);
  if([0,1,2].some(k=>face.max[k]<lo[k]||face.min[k]>hi[k]))return false;
  let polygon=face.vertices;
  for(let axis=0;axis<3;axis++)for(const [limit,sign]of [[lo[axis],1],[hi[axis],-1]]){
    const next=[];
    for(let i=0;i<polygon.length;i++){
      const a=polygon[i],b=polygon[(i+1)%polygon.length],da=(a[axis]-limit)*sign,db=(b[axis]-limit)*sign;
      if(da>=0)next.push(a);
      if((da>=0)!==(db>=0)){const t=da/(da-db);next.push(a.map((v,k)=>v+(b[k]-v)*t));}
    }
    polygon=next;if(!polygon.length)return false;
  }
  return true;
}
function planOverlap(a,b){return Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX)>EPS&&Math.min(a.maxZ,b.maxZ)-Math.max(a.minZ,b.minZ)>EPS;}
function cellBox(cell,railY){return {min:[(cell.x-.5)*SX,0,(cell.z-.5)*SZ],max:[(cell.x+.5)*SX,railY+.10,(cell.z+.5)*SZ]};}
function boxInsidePlan(box,rect){return box.min[0]>=rect.minX-EPS&&box.max[0]<=rect.maxX+EPS&&box.min[2]>=rect.minZ-EPS&&box.max[2]<=rect.maxZ+EPS;}
function planarCoverage(box,rectangles){
  // Integrate the union's z intervals at every rectangle x boundary. Unlike
  // checking only four corners, this finds any notch through the bin interior.
  const xs=[box.min[0],...rectangles.flatMap(r=>[r.minX,r.maxX]).filter(x=>x>box.min[0]&&x<box.max[0]),box.max[0]].sort((a,b)=>a-b);
  for(let i=1;i<xs.length;i++){
    if(xs[i]-xs[i-1]<EPS)continue;
    const x=(xs[i]+xs[i-1])/2,intervals=rectangles.filter(r=>x>=r.minX&&x<=r.maxX).map(r=>[r.minZ,r.maxZ]).sort((a,b)=>a[0]-b[0]);
    let covered=box.min[2];
    for(const [lo,hi]of intervals){if(lo>covered+EPS)break;if(hi>covered)covered=hi;}
    if(covered<box.max[2]-EPS)return false;
  }
  return true;
}

test('actual three-bin cabinet, roof, transfer towers and cover never enter unreserved storage cells in any direction or bin height',()=>{
  for(const f of fixtures){
    const {sim,port,visual,mc,options,envelope,name}=f;
    assert.equal(port.operational,true,name);
    assert.deepEqual([envelope.layout.outX,envelope.layout.outZ],[f.outX,f.outZ],name);
    assert.equal(envelope.layout.shafts.length,2,name);
    assert.equal(envelope.rectangles.length,port.installationBounds.length,`${name}: reservation and scene share one installation outline`);
    for(let i=0;i<envelope.rectangles.length;i++)for(const axis of ['minX','maxX','minZ','maxZ'])assert.ok(Math.abs(envelope.rectangles[i][axis]-port.installationBounds[i][axis])<1e-8,`${name}: reservation and rendered world coordinates agree`);
    const reserved=new Set(port.footprintReservedKeys),unreserved=[...sim.cells.values()].filter(c=>!c.isEquipment);
    assert.ok(unreserved.length>0&&unreserved.some(c=>c.stack.length),`${name}: usable stored stock remains beside the installation`);
    for(const c of sim.cells.values()){
      const box=cellBox(c,mc.railY),plan={minX:box.min[0],maxX:box.max[0],minZ:box.min[2],maxZ:box.max[2]};
      assert.equal(reserved.has(c.key),envelope.rectangles.some(r=>planOverlap(r,plan)),`${name}: every intersected cell, including a partial edge, is reserved (${c.key})`);
      if(reserved.has(c.key))assert.equal(c.stack.length,0,`${name}: station installation cells cannot also hold inventory`);
    }
    const faces=triangles(f.mesh);
    for(const openness of [0,.5,1])faces.push(...triangles(buildStationApertureGeometry({...visual,aperture:{openness}},options)));
    for(const c of unreserved){
      const box=cellBox(c,mc.railY),collision=faces.find(face=>cutsBox(face,box));
      assert.equal(collision,undefined,`${name}: rendered furniture enters unreserved storage cell ${c.key}`);
    }
  }
});

test('full-size bins clear the actual side walls, roof and transfer posts throughout a carousel revolution',()=>{
  for(const f of fixtures){
    const faces=triangles(f.mesh).filter(face=>face.max[1]>f.mc.portBaseY-EPS&&face.min[1]<f.mc.workHeightM+EPS);
    let positions=0;
    for(let step=0;step<180;step++){
      const angle=step*Math.PI*2/180,boxes=[];
      for(let slot=0;slot<3;slot++){
        const p=f.sim._slotPosition(f.port,slot,angle),x=p.x*SX,z=p.z*SZ;
        const box={min:[x-.649/2,f.mc.portBaseY,z-.449/2],max:[x+.649/2,f.mc.workHeightM,z+.449/2]};
        assert.ok(planarCoverage(box,f.envelope.rectangles),`${f.name}: the complete physical bin stays enclosed at ${step*2}° / slot ${slot}`);
        const collision=faces.find(face=>cutsBox(face,box));
        assert.equal(collision,undefined,`${f.name}: the ${step*2}° / slot ${slot} bin intersects a wall, roof or post`);
        boxes.push(box);positions++;
      }
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert.ok([0,2].some(k=>boxes[i].max[k]<=boxes[j].min[k]||boxes[j].max[k]<=boxes[i].min[k]),`${f.name}: adjacent full-size bins cannot overlap while indexing`);
    }
    assert.equal(positions,540);
    const roofFaces=triangles(f.mesh).filter(face=>Math.abs(face.min[1]-face.max[1])<EPS&&face.min[1]>f.mc.workHeightM&&face.min[1]<f.mc.workHeightM+.04);
    assert.ok(roofFaces.length>0,`${f.name}: opaque low roof remains present`);
    assert.ok(Math.min(...roofFaces.map(face=>face.min[1]))-f.mc.workHeightM>.003,`${f.name}: low roof has positive clearance above the bin rim`);
  }
});

test('rear cabinet stays at workbench height and only two narrow transfer towers rise to the grid',()=>{
  for(const f of fixtures){
    const shafts=f.envelope.layout.shafts.map(p=>({minX:p.x-.352,maxX:p.x+.352,minZ:p.z-.240,maxZ:p.z+.240}));
    const grid={min:[-SX/2,f.mc.workHeightM+.065+EPS,-SZ/2],max:[(f.sim.config.width-.5)*SX,f.mc.railY+.1,(f.sim.config.depth-.5)*SZ]};
    let tallFaces=0;
    for(const face of triangles(f.mesh)){
      if(!cutsBox(face,grid))continue;
      tallFaces++;
      assert.ok(shafts.some(rect=>boxInsidePlan(face,rect)),`${f.name}: tall rear cladding must stay inside one real shaft, not span the reserved-cell rectangle`);
    }
    assert.ok(tallFaces>0,`${f.name}: transfer towers reach the rail`);
    for(const stationInterior of [false,true]){
      const mesh=buildStationGeometry(f.visual,{...f.options,stationInterior});
      for(const face of triangles(mesh))assert.ok(face.max[1]<=Math.max(f.mc.railY+.045,f.mc.workHeightM+.52)+EPS,`${f.name}: enclosure has no excess grid-height roof`);
    }
  }
});

test('single-port front access, shutter, console and scanner clear the full-size vertical hoist in every orientation',()=>{
 for(const binHeightM of[.22,.33,.425])for(const [side,x,z,outX,outZ]of sides){
  const sim=new AutoStoreSim({...createDefaultConfig(),binHeightM,maxHeightM:3,robotCount:1,skuCount:16,ports:[{id:'P1',type:'single',x,z}]}),visual=sim.getPortVisuals()[0],mc=sim.getMotionConfig();
  const options={width:12,depth:8,binHeight:binHeightM,railY:mc.railY},q=getStationEnvelope(visual,options).layout;
  const baseFaces=triangles(buildStationGeometry(visual,options));
  const sweep={min:[x*SX-.3245,mc.portBaseY,z*SZ-.2245],max:[x*SX+.3245,mc.railY+.5,z*SZ+.2245]};
  for(const openness of[0,.25,.5,.75,1]){
   const faces=[...baseFaces,...triangles(buildStationApertureGeometry({...visual,aperture:{openness}},options))];
   assert.equal(faces.find(f=>cutsBox(f,sweep)),undefined,side+' '+binHeightM+' vertical hoist must remain clear even with shutter closed');
   for(const c of sim.cells.values())if(!c.isEquipment)assert.equal(faces.find(f=>cutsBox(f,cellBox(c,mc.railY))),undefined,'no intrusion into storage');
  }
  const reader=getBarcodeReaderPose(visual,options);
  // A 4mm ray tube at the front-window crossing must remain unobstructed.
  for(let i=2;i<=100;i++){
   const p=reader.lens.map((n,k)=>n+(reader.target[k]-n)*i/100),box={min:p.map(n=>n-.002),max:p.map(n=>n+.002)};
   assert.equal(baseFaces.find(f=>cutsBox(f,box)),undefined,side+' barcode reader can see its pick target');
  }
  const d=q.outX?.655:.455,front=d/2+.027;
  const c=[q.work[0]+outX*front,mc.workHeightM+.25,q.work[1]+outZ*front],window={min:[c[0]-.01,c[1]-.08,c[2]-.01],max:[c[0]+.01,c[1]+.08,c[2]+.01]};
  assert.ok(triangles(buildStationApertureGeometry({...visual,aperture:{openness:0}},options)).some(f=>cutsBox(f,window)),'closed front shutter covers window');
  assert.equal([...baseFaces,...triangles(buildStationApertureGeometry({...visual,aperture:{openness:1}},options))].find(f=>cutsBox(f,window)),undefined,'open front exposes the real bin');
 }
});
