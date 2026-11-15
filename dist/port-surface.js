// Continuous render surface inside the conservative, cell-reservation envelope.
// Bin sweep = an axis-aligned bin rectangle swept along a circular centre path.
const EPS=1e-8,cache=new Map();
const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
const rect=(x0,z0,x1,z1)=>[[x0,z0],[x1,z0],[x1,z1],[x0,z1]];
function inside(p,polygon){
  let hit=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])hit=!hit;
  }
  return hit;
}
export function getPortSurface(q){
  const s=q.station,key=JSON.stringify([q.type,q.outX,q.outZ,q.origin,q.hub,q.radius,s.widthM,s.frontOffsetM,s.rearOffsetM,q.shafts]);
  if(cache.has(key))return cache.get(key);
  const corners=[];
  for(const u of[-s.widthM/2,s.widthM/2])for(const v of[s.rearOffsetM,s.frontOffsetM])corners.push([q.origin[0]-q.outZ*u+q.outX*v,q.origin[1]+q.outX*u+q.outZ*v]);
  const polygons=[rect(Math.min(...corners.map(p=>p[0])),Math.min(...corners.map(p=>p[1])),Math.max(...corners.map(p=>p[0])),Math.max(...corners.map(p=>p[1])))];
  if(q.type==='buffer3'){
    const curve=[],[x,z]=q.hub,hx=.649/2+.05,hz=.449/2+.05,r=q.radius;
    // 128 sides: < 0.3 mm chord error at the current carousel radius.
    for(const [cx,cz,start]of [[hx,hz,0],[-hx,hz,90],[-hx,-hz,180],[hx,-hz,270]])
      for(let i=0;i<=32;i++){const t=(start+i*90/32)*Math.PI/180;curve.push([x+cx+r*Math.cos(t),z+cz+r*Math.sin(t)]);}
    polygons.push(curve);
  }
  for(const p of q.shafts)polygons.push(rect(p.x-.352,p.z-.239,p.x+.352,p.z+.239));
  const segments=polygons.flatMap(poly=>poly.map((a,i)=>({a,b:poly[(i+1)%poly.length]}))),edges=[],seen=new Set();
  for(const {a,b}of segments){
    const d=sub(b,a),length=Math.hypot(...d);if(length<EPS)continue;
    const cuts=[0,1];
    for(const {a:c,b:e}of segments){
      const v=sub(e,c),delta=sub(c,a),den=cross(d,v);
      if(Math.abs(den)>EPS){const t=cross(delta,v)/den,u=cross(delta,d)/den;if(t>EPS&&t<1-EPS&&u>=-EPS&&u<=1+EPS)cuts.push(t);}
      else if(Math.abs(cross(delta,d))<EPS)for(const p of[c,e]){const t=((p[0]-a[0])*d[0]+(p[1]-a[1])*d[1])/(length*length);if(t>EPS&&t<1-EPS)cuts.push(t);}
    }
    cuts.sort((a,b)=>a-b);const normal=[d[1]/length,-d[0]/length];
    for(let i=1;i<cuts.length;i++){
      if(cuts[i]-cuts[i-1]<EPS)continue;
      const p=mix(a,b,cuts[i-1]),r=mix(a,b,cuts[i]),mid=mix(p,r,.5),out=mid.map((v,k)=>v+normal[k]*1e-6);
      if(polygons.some(poly=>inside(out,poly)))continue;
      const id=[...p,...r].map(v=>v.toFixed(7)).join(',');if(seen.has(id))continue;seen.add(id);
      edges.push({a:p,b:r,normal});
    }
  }
  const result={edges,polygons};if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
}
// Non-overlapping roof trapezoids with actual intake/operator holes. No stacks
// of coincident cuboid side faces along the curved part of the cabinet.
export function portRoofTiles(edges,holes){
  const xs=[...new Set([...edges.flatMap(e=>[e.a[0],e.b[0]]),...holes.flatMap(h=>[h.minX,h.maxX])].map(v=>+v.toFixed(9)))].sort((a,b)=>a-b),tiles=[];
  for(let i=1;i<xs.length;i++){
    const x0=xs[i-1],x1=xs[i],mid=(x0+x1)/2;if(x1-x0<EPS)continue;
    const crossings=edges.filter(e=>mid>Math.min(e.a[0],e.b[0])&&mid<Math.max(e.a[0],e.b[0])).map(e=>{
      const at=x=>e.a[1]+(e.b[1]-e.a[1])*(x-e.a[0])/(e.b[0]-e.a[0]);return {z:at(mid),at};
    }).sort((a,b)=>a.z-b.z);
    for(let j=1;j<crossings.length;j+=2){
      let spans=[[crossings[j-1],crossings[j]]];
      for(const h of holes){
        if(mid<=h.minX||mid>=h.maxX)continue;
        spans=spans.flatMap(([lo,hi])=>{
          if(h.maxZ<=lo.z||h.minZ>=hi.z)return [[lo,hi]];
          const next=[];if(h.minZ>lo.z)next.push([lo,{z:h.minZ,at:()=>h.minZ}]);if(h.maxZ<hi.z)next.push([{z:h.maxZ,at:()=>h.maxZ},hi]);return next;
        });
      }
      for(const [lo,hi]of spans)tiles.push([[x0,lo.at(x0)],[x1,lo.at(x1)],[x1,hi.at(x1)],[x0,hi.at(x0)]]);
    }
  }
  return tiles;
}
