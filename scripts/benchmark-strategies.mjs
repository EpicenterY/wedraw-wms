import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
const scenarios=[{name:'standard',skuCount:1000,robotCount:4,seed:20261114,count:20},{name:'mixed',skuCount:1000,robotCount:8,seed:42,count:20},{name:'dense',width:16,depth:12,skuCount:600,robotCount:30,seed:73,count:24}];
const rows=[];
for(const sample of scenarios)for(const mode of [0,1,2,4,7]){
 const base=createDefaultConfig(),config={...base,...sample,strategies:{completionTime:!!(mode&1),portPacing:!!(mode&2),timeReservations:!!(mode&4)}};
 if(sample.width){config.activeCells=Array.from({length:sample.width*sample.depth},(_,i)=>(i%sample.width)+','+Math.floor(i/sample.width));config.ports=[{id:'P1',x:0,z:sample.depth-1,type:'buffer3'},{id:'P2',x:sample.width-1,z:0,type:'single'}];}
 const sim=new AutoStoreSim(config);sim.enqueueRandom(sample.count);const demand=sim.orders.map(o=>[o.skuId,o.qty]);let ticks=0;sim.start();const start=performance.now();
 while(sim.running&&ticks++<30000)sim.tick(.5);
 sim.assertInvariants();const times=sim.orders.filter(o=>o.status==='complete').map(o=>o.completedAt-o.createdAt).sort((a,b)=>a-b);
 const result={scenario:sample.name,mode,finished:times.length,requested:sample.count,stalled:sim.stalled,seconds:+sim.time.toFixed(1),mean:+(times.reduce((s,t)=>s+t,0)/times.length).toFixed(1),p95:+(times[Math.ceil(times.length*.95)-1]||0).toFixed(1),emptyMeters:+sim.metrics.emptyTravelMeters.toFixed(2),portWaitSeconds:+sim.metrics.portStarvedSec.toFixed(1),trafficDelay:+sim.metrics.trafficWaitSec.toFixed(2),wallMs:Math.round(performance.now()-start),demand};
 rows.push(result);console.error(sample.name,mode,result.seconds,result.finished+'/'+result.requested);
 sim._runtime?.dispose();sim._navigator?.dispose();
}
console.log(JSON.stringify(rows,null,2));
