import {pathToFileURL,fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
const base=process.argv[2]||fileURLToPath(new URL('../dist/',import.meta.url));
const root=base.startsWith('/')&&process.platform==='win32'?base.slice(1):base;
const url=pathToFileURL(root.replaceAll('\\','/')+'/');
const {initializeRustCore}=await import(new URL('rust-core.js',url));await initializeRustCore(await readFile(new URL('wasm/warehouse_core.wasm',url)));
const {AutoStoreSim,createDefaultConfig}=await import(new URL('engine.js',url));const {OrderBook}=await import(new URL('orders.js',url));
for(const seed of (process.argv[3]?.split(',')||['pipeline-c','pipeline-d','pipeline-e'])){
 const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.98,skuCount:480,pickingSeconds:3,orderPrefetch:true,strategies:{completionTime:true,portPacing:true,timeReservations:true}}),book=new OrderBook(sim);
 book.generate(10,{combinedRatio:.4,seed});book.submitAll();sim.start();let ticks=0,reservationBeforeLift=0,blockedReady=0,prelifts=0,held=0,idle=0,completedDwell=0,readyNext=0,pickEnds=0,queueDistance=0,sourceDistance=0,stepMs=[];
 const portStats=Object.fromEntries(sim.ports.map(p=>[p.id,{wait:0,picking:0,deliveries:0}]));
 const assign=sim._assignJob.bind(sim);sim._assignJob=(r,j)=>{if(j.kind==='prelift'){prelifts++;const p=sim.ports.find(p=>p.id===j.plannedPortId);if(p){const dist=k=>{const[x,z]=k.split(',').map(Number);return Math.min(...p.intakeKeys.map(k=>{const[a,b]=k.split(',').map(Number);return Math.abs(x-a)*.705+Math.abs(z-b)*.480;}));};queueDistance+=dist(j.endKey);sourceDistance+=dist(j.fromKey);}}if(j.kind==='deliver')portStats[j.port.id].deliveries++;return assign(r,j);};
 while(sim.running&&ticks++<20000){const demand=sim.orders.some(o=>!o.pickedQty&&['queued','inProgress'].includes(o.status));
  if(demand)idle+=.1*sim.ports.filter(p=>p.operational&&!p.activeEntryId).length;
  const active=sim.ports.map(p=>p.activeEntryId);
  const at=performance.now();sim.tick(.1);stepMs.push(performance.now()-at);book.update();
  for(const [pi,p] of sim.ports.entries()){completedDwell+=.1*p.entries.filter(e=>['ready','outbound'].includes(e.status)).length;
   if(active[pi]&&!p.activeEntryId){pickEnds++;if(p.entries.some(e=>e.status==='waiting'))readyNext++;}
   if(sim.orders.some(o=>!o.pickedQty&&['queued','inProgress'].includes(o.status))&&!p.entries.some(e=>['picking','waiting'].includes(e.status)))portStats[p.id].wait+=.1;if(p.activeEntryId)portStats[p.id].picking+=.1;const r=sim.robots.find(r=>r.id===p.inletReservation?.robotId);
   if(p.inletReservation?.kind==='deliver'&&r&&!r.carryingBinId)reservationBeforeLift+=.1;
   if(p.inletReservation&&!p.activeEntryId&&p.entries.some(e=>e.status==='waiting'))blockedReady+=.1;
  }
  held+=sim.robots.filter(r=>r.job?.prepared).length*.1;
  if(ticks%50===0)sim.assertInvariants();
 }
 stepMs.sort((a,b)=>a-b);console.log(JSON.stringify({seed,seconds:+sim.time.toFixed(1),portWait:+sim.metrics.portStarvedSec.toFixed(1),idle:+idle.toFixed(1),complete:sim.orders.every(o=>o.status==='complete'),completedDwell:+completedDwell.toFixed(1),readyNext,pickEnds,queueDistance:+queueDistance.toFixed(1),sourceDistance:+sourceDistance.toFixed(1),reservationBeforeLift:+reservationBeforeLift.toFixed(1),blockedReady:+blockedReady.toFixed(1),prelifts,held:+held.toFixed(1),ports:portStats,stepP95:stepMs[Math.floor(stepMs.length*.95)],stepMax:stepMs.at(-1)}));
}
