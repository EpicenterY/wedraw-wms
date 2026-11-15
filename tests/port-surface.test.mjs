import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {getPortLayout,buildStationGeometry} from '../dist/scene.js';
import {getPortSurface,portRoofTiles} from '../dist/port-surface.js';

function inside([x,y],poly){let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit;}return hit;}
const fixtures=[];
for(const [x,z]of [[0,4],[11,4],[6,0],[6,7]])for(const type of ['buffer3','single']){
  const sim=new AutoStoreSim({...createDefaultConfig(),ports:[{id:'P1',type,x,z}],robotCount:1,skuCount:16});
  const visual=sim.getPortVisuals()[0],options={width:12,depth:8,binHeight:.33,railY:sim.getMotionConfig().railY};
  fixtures.push({q:getPortLayout(visual,options),visual,options});
}
test('port render contour is closed and curved; each roof point has one surface instead of overlapping boxes',()=>{
  for(const {q}of fixtures){
    const surface=getPortSurface(q),degree=new Map();
    for(const e of surface.edges)for(const p of[e.a,e.b]){const key=p.map(v=>v.toFixed(6)).join(',');degree.set(key,(degree.get(key)||0)+1);}
    for(const count of degree.values())assert.equal(count,2,'no cracks or duplicate contour edges');
    if(q.type==='buffer3')assert.ok(surface.edges.some(e=>Math.abs(e.normal[0])>.15&&Math.abs(e.normal[1])>.15),'rounded sweep must not be a staircase');
    const holes=q.shafts.map(p=>({minX:p.x-.331,maxX:p.x+.331,minZ:p.z-.231,maxZ:p.z+.231}));
    const tiles=portRoofTiles(surface.edges,holes),xs=surface.edges.flatMap(e=>[e.a[0],e.b[0]]),zs=surface.edges.flatMap(e=>[e.a[1],e.b[1]]);
    const x0=Math.min(...xs),x1=Math.max(...xs),z0=Math.min(...zs),z1=Math.max(...zs);
    for(let x=0;x<83;x++)for(let z=0;z<67;z++){
      const p=[x0+(x+.371)/83*(x1-x0),z0+(z+.619)/67*(z1-z0)];
      const expected=surface.polygons.some(poly=>inside(p,poly))&&!holes.some(h=>p[0]>h.minX&&p[0]<h.maxX&&p[1]>h.minZ&&p[1]<h.maxZ);
      assert.equal(tiles.filter(poly=>inside(p,poly)).length,expected?1:0,'roof has neither overlapping coplanar faces nor holes outside the openings');
    }
  }
});
test('opaque transfer tower corners do not draw two coplanar skins',()=>{
  for(const {q,visual,options}of fixtures){
    const mesh=buildStationGeometry(visual,options),y=options.railY-.173;
    for(const shaft of q.shafts)for(const sign of[-1,1]){
      const plane=shaft.z+sign*.239,triangles=[];
      for(let i=0;i<mesh.length;i+=27){const p=[0,9,18].map(j=>[mesh[i+j],mesh[i+j+1],mesh[i+j+2]]);if(p.every(v=>Math.abs(v[2]-plane)<1e-6))triangles.push(p.map(v=>[v[0],v[1]]));}
      for(let i=0;i<89;i++){const x=shaft.x-.350+(i+.271)/89*.700;assert.equal(triangles.filter(t=>inside([x,y],t)).length,1,'tower corner must have exactly one outward surface');}
    }
  }
});
