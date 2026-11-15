// Frozen v1.1.0 navigation rules from 05285cf4000a86b41fc3432f44b3266f34fa6be3.
// Test oracle only; never shipped to the browser.
export function reachable(graph,from,blocked){
  const valid=k=>graph.has(k)&&graph.get(k).footprint.every(f=>!blocked.has(f));
  const found=new Set();if(!valid(from))return found;const q=[from];found.add(from);
  for(let i=0;i<q.length;i++)for(const n of graph.get(q[i]).neighbors)if(!found.has(n)&&valid(n)){found.add(n);q.push(n);}return found;
}
export function path(graph,from,to,blocked){
  const valid=k=>graph.has(k)&&graph.get(k).footprint.every(f=>!blocked.has(f));
  if(!valid(from)||!valid(to))return null;const q=[from],prev=new Map([[from,null]]);
  for(let i=0;i<q.length;i++){const k=q[i];if(k===to){const out=[];for(let n=k;n!==null;n=prev.get(n))out.push(n);return out.reverse();}
    for(const nk of graph.get(k).neighbors)if(!prev.has(nk)&&valid(nk)){prev.set(nk,k);q.push(nk);}}return null;
}
export function graphFor(active,sign){
  const set=new Set(active),footprint=k=>{const[x,z]=k.split(',').map(Number);return[k,`${x},${z+sign}`];};
  const graph=new Map(active.filter(k=>footprint(k).every(f=>set.has(f))).map(k=>[k,{footprint:footprint(k),neighbors:[]} ]));
  for(const[k,node]of graph){const[x,z]=k.split(',').map(Number);node.neighbors=[[x-1,z],[x+1,z],[x,z-1],[x,z+1]].map(p=>p.join(',')).filter(n=>graph.has(n));}
  return graph;
}
