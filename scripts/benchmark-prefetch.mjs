import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {OrderBook} from '../dist/orders.js';
const rows=[];
for(const seed of ['pipeline-a','pipeline-b','pipeline-c','pipeline-d','pipeline-e','pipeline-f'])for(const orderPrefetch of [false,true]){
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.98,skuCount:480,pickingSeconds:3,orderPrefetch,strategies:{completionTime:true,portPacing:true,timeReservations:true}}),book=new OrderBook(sim);
 book.generate(10,{combinedRatio:.4,seed});book.submitAll();sim.start();let ticks=0;
 while(sim.running&&ticks++<20000){sim.tick(.5);book.update();if(ticks%50===0)sim.assertInvariants();}
 const row={seed,orderPrefetch,time:+sim.time.toFixed(1),portWait:+sim.metrics.portStarvedSec.toFixed(1),idle:+sim.metrics.portIdleDemandSec.toFixed(1),shipped:book.orders.filter(o=>o.status==='shipped').length,complete:sim.orders.every(o=>o.status==='complete'),stalled:sim.stalled};rows.push(row);console.log(JSON.stringify(row));
}
for(const orderPrefetch of [false,true]){const subset=rows.filter(r=>r.orderPrefetch===orderPrefetch);console.log(JSON.stringify({orderPrefetch,cases:subset.length,meanTime:subset.reduce((n,r)=>n+r.time,0)/subset.length,meanPortWait:subset.reduce((n,r)=>n+r.portWait,0)/subset.length}));}
