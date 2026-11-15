/** Shared world-space installation outline for the port and its reserved cells.
 * The carousel moves axis-aligned bins around a circular centre path. Its sweep
 * is a rounded rectangle, not the square bounding box of that path.
 */
const cache=new Map(),EPS=1e-8;
export const PORT_WALL_M=.028;
export function rectanglesOverlap(a,b,epsilon=EPS){
  return Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX)>epsilon&&Math.min(a.maxZ,b.maxZ)-Math.max(a.minZ,b.minZ)>epsilon;
}
export function getPortFootprint(q){
  const s=q.station,signature=JSON.stringify([q.type,q.outX,q.outZ,q.origin,q.hub,q.radius,s.widthM,s.frontOffsetM,s.rearOffsetM,q.shafts.map(p=>[p.x,p.z])]);
  if(cache.has(signature))return cache.get(signature);
  const points=[];
  for(const u of[-s.widthM/2,s.widthM/2])for(const v of[s.rearOffsetM,s.frontOffsetM])points.push([q.origin[0]-q.outZ*u+q.outX*v,q.origin[1]+q.outX*u+q.outZ*v]);
  const rectangles=[{minX:Math.min(...points.map(p=>p[0])),maxX:Math.max(...points.map(p=>p[0])),minZ:Math.min(...points.map(p=>p[1])),maxZ:Math.max(...points.map(p=>p[1]))}];
  if(q.type==='buffer3'){
    // 50 mm includes an inward 28 mm wall and at least 22 mm clearance.
    // Each band encloses the entire analytic sweep within it, including between
    // animation samples. No rendered bin is shrunk to fit the furniture.
    const [hx,hz]=q.hub,r=q.radius,halfX=.649/2+.050,halfZ=.449/2+.050,segments=16;
    const cuts=[hx-halfX-r];
    for(let i=1;i<=segments;i++)cuts.push(hx-halfX-r+r*i/segments);
    cuts.push(hx+halfX);
    for(let i=1;i<=segments;i++)cuts.push(hx+halfX+r*i/segments);
    for(let i=1;i<cuts.length;i++){
      const minX=cuts[i-1],maxX=cuts[i],distance=Math.max(0,hx-halfX-maxX,minX-hx-halfX);
      const halfDepth=halfZ+Math.sqrt(Math.max(0,r*r-distance*distance));
      rectangles.push({minX,maxX,minZ:hz-halfDepth,maxZ:hz+halfDepth});
    }
  }
  // The vertical transfer towers are limited to their real rail openings.
  for(const p of q.shafts)rectangles.push({minX:p.x-.352,maxX:p.x+.352,minZ:p.z-.239,maxZ:p.z+.239});
  const xs=[...new Set(rectangles.flatMap(r=>[r.minX,r.maxX]))].sort((a,b)=>a-b);
  const zs=[...new Set(rectangles.flatMap(r=>[r.minZ,r.maxZ]))].sort((a,b)=>a-b);
  const inside=(x,z)=>rectangles.some(r=>x>r.minX-EPS&&x<r.maxX+EPS&&z>r.minZ-EPS&&z<r.maxZ+EPS),edges=[],seen=new Set();
  for(const r of rectangles)for(const [axis,fixed,start,end]of[['x',r.minX,r.minZ,r.maxZ],['x',r.maxX,r.minZ,r.maxZ],['z',r.minZ,r.minX,r.maxX],['z',r.maxZ,r.minX,r.maxX]]){
    const cuts=[start,...(axis==='x'?zs:xs).filter(v=>v>start+EPS&&v<end-EPS),end];
    for(let i=1;i<cuts.length;i++){
      const a=cuts[i-1],b=cuts[i];if(b-a<EPS)continue;
      const mid=(a+b)/2,delta=.000001;
      const negative=axis==='x'?inside(fixed-delta,mid):inside(mid,fixed-delta),positive=axis==='x'?inside(fixed+delta,mid):inside(mid,fixed+delta);
      if(negative===positive)continue;
      const key=`${axis}:${fixed.toFixed(7)}:${a.toFixed(7)}:${b.toFixed(7)}`;
      if(seen.has(key))continue;seen.add(key);
      edges.push({axis,fixed,start:a,end:b,insidePositive:positive});
    }
  }
  const bounds={minX:xs[0],maxX:xs.at(-1),minZ:zs[0],maxZ:zs.at(-1)};
  const result={rectangles,edges,bounds};
  if(cache.size>=64)cache.delete(cache.keys().next().value);
  cache.set(signature,result);return result;
}
