import test from 'node:test';
import assert from 'node:assert/strict';
import {getPortFacingYaw,getPickingPoses,buildPickingGeometry,buildGripperGeometry,getBarcodeReaderPose,getSelectedCellBins} from '../dist/scene.js';

for(const [outX,outZ]of [[1,0],[-1,0],[0,1],[0,-1]])test('fits face the actual port normal '+outX+','+outZ,()=>{
 const data={width:12,depth:8,ports:[{id:'P1',x:4,z:3,type:'buffer3',layout:{outX,outZ}}]};
 for(const oblique of[true,false]){const yaw=getPortFacingYaw(data,{oblique});assert.ok(Math.cos(yaw)*outX+Math.sin(yaw)*outZ>.96);}
 const back={id:'P2',x:0,z:0,type:'single',layout:{outX:-outX,outZ:-outZ}};
 assert.ok(Math.cos(getPortFacingYaw({...data,ports:[back,...data.ports]}))*outX+Math.sin(getPortFacingYaw({...data,ports:[back,...data.ports]}))*outZ>.96);
 assert.equal(getPortFacingYaw({...data,ports:[back,...data.ports]}),getPortFacingYaw({...data,ports:[...data.ports,back]}));
});
const port={id:'P1',type:'single',x:0,z:2,binBaseY:.63,layout:{outX:-1,outZ:0},aperture:{state:'open',openness:1},presentation:{pickAllowed:true,binId:'B0032'},bins:[{id:'B0032',x:0,z:2,binY:.795,status:'picking',progress:.05}]};
test('one smooth pick lifts inside the bin, pauses for scanning and confirmation, then exits without shrinking',()=>{
 const initial=structuredClone(port),pose=p=>{port.bins[0].progress=p;return getPickingPoses(port)[0];};
 const low=pose(.01),high=pose(.32),scan=pose(.52),ok=pose(.65),out=pose(.92);
 assert.ok(low.y+.043<.96,'item starts below the rim');
 assert.ok(high.y>low.y+.3);assert.ok(out.x<scan.x-.3);assert.equal(out.binId,'B0032');
 assert.equal(scan.stage,'scanning');assert.equal(ok.stage,'confirmed');
 assert.deepEqual([scan.x,scan.y,scan.z],[ok.x,ok.y,ok.z],'scanner presentation is a true pause');
 assert.ok([low,high,scan,ok,out].every(p=>p.size===1),'fixed-size item');
 let previous=pose(0);for(let i=1;i<1000;i++){const next=pose(i/1000);assert.ok(Math.hypot(next.x-previous.x,next.y-previous.y,next.z-previous.z)<.008,'no resets or teleports');previous=next;}
 const before=JSON.stringify(port),mesh=buildPickingGeometry(port);assert.ok(mesh.length>0);assert.equal(JSON.stringify(port),before,'rendering never changes stock');
 assert.deepEqual(buildPickingGeometry(port),mesh,'paused simulation gives an identical mesh');
 const quiet=buildPickingGeometry(port,{reducedMotion:true});port.bins[0].progress=.5;assert.deepEqual(buildPickingGeometry(port,{reducedMotion:true}),quiet);
 Object.assign(port,initial);
});
test('reader points at the scan pose for either port type in all four directions',()=>{
 for(const type of['single','buffer3'])for(const [outX,outZ]of [[1,0],[-1,0],[0,1],[0,-1]]){
  const p={...structuredClone(port),type,x:0,z:0,layout:{outX,outZ,workX:0,workZ:0},bins:[{...port.bins[0],x:0,z:0,progress:.52}]};
  const reader=getBarcodeReaderPose(p),item=getPickingPoses(p)[0];
  assert.ok(Math.hypot(reader.target[0]-item.x,reader.target[1]-item.y,reader.target[2]-item.z)<1e-8);
  const mesh=buildPickingGeometry(p);assert.ok(mesh.every(Number.isFinite));
  const scanMesh=mesh;p.bins[0].progress=.65;assert.notDeepEqual(buildPickingGeometry(p),scanMesh,'green acknowledgement replaces red reading rays');
 }
});
test('selecting a cell resolves every real level and ignores moved bins, equipment and tracked red bins',()=>{
 const data={binHeight:.33,motionConfig:{stackBaseY:.015},cells:[{x:1,z:2,bins:['B1',{id:'B2'},'B3']},{x:2,z:2,bins:['B4']},{x:3,z:2,isEquipment:true,bins:['invalid']}]};
 const selected={x:1,z:2},poses=getSelectedCellBins(data,selected);
 assert.deepEqual(poses.map(p=>p.binId),['B1','B2','B3']);assert.deepEqual(poses.map(p=>p.level),[1,2,3]);
 for(let i=0;i<poses.length;i++){assert.ok(Math.abs(poses[i].y-(.015+(i+.5)*.33))<1e-8);assert.equal(poses[i].x,.705);assert.equal(poses[i].z,.96);}
 assert.deepEqual(getSelectedCellBins(data,selected,{excludeBinIds:['B2']}).map(p=>p.binId),['B1','B3']);
 data.cells[0].bins.pop();assert.equal(getSelectedCellBins(data,selected).length,2);
 for(const c of[null,{x:3,z:2},{x:9,z:9}])assert.deepEqual(getSelectedCellBins(data,c),[]);
});
test('no parcels for closed shutters, waiting bins or finished picking',()=>{
 for(const patch of[{aperture:{state:'closed',openness:0}},{aperture:{state:'opening',openness:.8}},{presentation:{pickAllowed:false,binId:'B0032'}},{presentation:{pickAllowed:true,binId:'B9999'}},{operational:false},{bins:[{...port.bins[0],status:'waiting'}]},{bins:[{...port.bins[0],progress:1}]}])assert.equal(buildPickingGeometry({...port,...patch}).length,0);
});
function topAt(mesh,x,z){
 let top=-Infinity;for(let i=0;i<mesh.length;i+=27){if(mesh[i+4]<.99)continue;
 const ax=mesh[i],az=mesh[i+2],bx=mesh[i+9],bz=mesh[i+11],cx=mesh[i+18],cz=mesh[i+20],det=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz);if(Math.abs(det)<1e-12)continue;
 const u=((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/det,v=((cz-az)*(x-cx)+(ax-cx)*(z-cz))/det;if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)top=Math.max(top,mesh[i+1]);
 }return top;
}
test('gripper has a closed plate across its centre and a non-coplanar top symbol',()=>{
 for(const loaded of[false,true]){const mesh=buildGripperGeometry({loaded});for(const x of[-.25,-.15,0,.15,.25])for(const z of[-.12,0,.12])assert.ok(topAt(mesh,x,z)>=.038-1e-6);
 let symbol=0;for(let i=0;i<mesh.length;i+=9){assert.ok(Number.isFinite(mesh[i]));if(Math.abs(mesh[i+1]-.0405)<1e-6&&mesh[i+4]>.99)symbol++;}assert.ok(symbol>20,'official symbol geometry sits above the closed plate');}
});

test('five-unit picks repeat five complete item cycles and remain frozen when paused',()=>{
 const p=structuredClone(port);p.bins[0].pickQuantity=5;
 for(let unit=0;unit<5;unit++)for(const [phase,stage]of [[.1,'lifting'],[.36,'presenting'],[.52,'scanning'],[.65,'confirmed'],[.9,'leaving']]){
  p.bins[0].progress=(unit+phase)/5;const pose=getPickingPoses(p)[0];assert.equal(pose.unitIndex,unit);assert.equal(pose.quantity,5);assert.equal(pose.stage,stage);
  assert.deepEqual(buildPickingGeometry(p),buildPickingGeometry(p),'same real progress stays still');
 }
 p.bins[0].progress=1;assert.equal(getPickingPoses(p).length,0);
});
