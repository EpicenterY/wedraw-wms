// Operational choices never alter layout, speed, capacity or stock placement.
export const STRATEGY_KEYS=['completionTime','portPacing','timeReservations'];
export const normalizeStrategies=value=>Object.fromEntries(STRATEGY_KEYS.map(k=>[k,value?.[k]===true]));
export const TRAFFIC_FOREVER=1e12;

// Conservative swept-cell intervals, including the entire two-cell chassis.
// Each straight segment keeps the original acceleration and travel duration.
export function trafficWindows(sim,robot,job,smooth){
  const rows=new Map(); let time=0,current=job.startKey;
  const add=(key,start,end)=>{const row=rows.get(key)||[];row.push({start:Math.max(0,start-.025),end:end+.025});rows.set(key,row);};
  const inverse=q=>{if(q<=0)return 0;if(q>=1)return 1;let lo=0,hi=1;for(let n=0;n<28;n++){const m=(lo+hi)/2;if(smooth(m)<q)lo=m;else hi=m;}return (lo+hi)/2;};
  for(const op of job.ops){
    if(op.type==='move'){
      for(const segment of op.segments){
        const nodes=op.path.slice(segment.pathStart,segment.pathEnd+1),length=nodes.length-1;
        for(let i=0;i<nodes.length;i++)for(const key of sim.footprint(nodes[i],robot.bodySign))
          add(key,time+inverse((i-1)/length)*segment.duration,time+inverse((i+1)/length)*segment.duration);
        time+=segment.duration;
      }
      current=op.path.at(-1);
    }else{for(const key of sim.footprint(current,robot.bodySign))add(key,time,time+op.duration);time+=op.duration;}
  }
  for(const key of sim.footprint(job.endKey,robot.bodySign))add(key,time,TRAFFIC_FOREVER);
  const windows=[];
  for(const [key,list]of rows){list.sort((a,b)=>a.start-b.start);let tail=null;
    for(const span of list){if(tail&&span.start<=tail.end+1e-7)tail.end=Math.max(tail.end,span.end);else{tail={key,...span};windows.push(tail);}}
  }
  return {windows,startKeys:sim.footprint(job.startKey,robot.bodySign),endKeys:sim.footprint(job.endKey,robot.bodySign),duration:time};
}

export function prepareTraffic(sim,robot,job,smooth){
  const proposal=trafficWindows(sim,robot,job,smooth);
  const scheduled=sim._rpc('scheduleTraffic',{robotId:robot.id,...proposal,maxDelay:12});
  if(!scheduled)return null;
  // Exclusive locks protect stack heights/ownership until their hoists finish.
  // Traversal cells are protected by Rust's time reservations instead.
  job.locked=new Set(job.ops.filter(op=>op.type!=='move'&&op.key).map(op=>op.key));
  job.traffic=scheduled;
  if(scheduled.delay>1e-7)job.ops.unshift({type:'wait',phase:'traffic-wait',purpose:'교차 구간 진입 대기',duration:scheduled.delay});
  return job;
}

export function portForecast(port){
  let wait=0;
  for(const e of port.entries){
    if(e.status==='picking')wait+=Math.max(0,e.pickDuration-e.pickElapsed);
    else if(!['ready','outbound'].includes(e.status))wait+=(e.pickDuration||15)+3;
  }
  return wait+(port.rotation?Math.max(0,port.rotation.duration-port.rotation.elapsed):0);
}

export function candidateSummary(sim,robot,job,index){
  const target=sim.bins.get(job.order.binId),cell=target?.location.type==='grid'?sim.cells.get(target.location.key):null;
  const depth=cell?Math.max(0,cell.stack.indexOf(target.id)>=0?cell.stack.length-1-cell.stack.indexOf(target.id):0):0;
  const eligible=sim.ports.filter(p=>p.operational&&robot.operationalPortKeys.some(k=>p.intakeKeys.includes(k)));
  const staged=p=>sim.robots.filter(r=>r.job?.kind==='prelift'&&r.job.plannedPortId===p.id).length;
  const supply=job.port||eligible.find(p=>p.id===job.plannedPortId)||eligible.slice().sort((a,b)=>portForecast(a)+staged(a)*20-portForecast(b)-staged(b)*20)[0];
  if(job.kind==='prelift')job.plannedPortId=supply?.id;
  const forecast=supply?portForecast(supply):0;
  const travel=(a,b)=>{const [x,z]=a.split(',').map(Number),[xx,zz]=b.split(',').map(Number);return Math.abs(x-xx)*.705+Math.abs(z-zz)*.480;};
  const next=sim.orders.filter(o=>o!==job.order&&!o.pickedQty&&['queued','inProgress'].includes(o.status)).map(o=>sim.bins.get(o.binId)).filter(b=>b?.location.type==='grid');
  const nextTravel=next.length?Math.min(...next.map(b=>travel(job.endKey,b.location.key)))/1.8:0;
  const moves=job.ops.filter(op=>op.type==='move');
  const emptyDistance=moves.filter(op=>op.purpose.includes('접근')||op.purpose.includes('대기')).reduce((sum,op)=>sum+op.segments.reduce((v,s)=>v+s.distance,0),0);
  return {index,robotId:robot.id,orderId:job.order.id,kind:job.kind,portId:supply?.id||null,nextPickSec:sim.config.pickingSeconds?sim.config.pickingSeconds*job.order.qty:14+job.order.qty*.8,
    duration:job.ops.reduce((v,op)=>v+op.duration,0),remainingDigSec:Math.max(0,depth-(job.kind==='dig'?1:0))*8,
    portDelay:Math.max(0,forecast),nextTravelSec:nextTravel,emptyDistance,trafficDelay:job.traffic?.delay||0};
}

// Rebuild after every commit: another assignment can change claims, port slots,
// shaft availability and time reservations. Only unstarted work is reconsidered.
export function dispatchStrategies(sim){
  const limit=sim.robots.filter(r=>r.available&&!r.job).length;
  for(let round=0;round<limit;round++){
    const plan=sim._rpc('dispatchPlan'),jobs=[];
    for(const task of plan.tasks){
      const order=sim.orders.find(o=>o.id===task.orderId);if(!order)continue;
      if(jobs.length>=24&&order.startedAt===null&&order.priority!=='urgent')continue;
      const kind=sim._rpc('taskKind',task);if(!kind)continue;
      const robots=sim._robotsFor(order,kind);let feasible=0;
      for(const robot of robots){
        let job;
        if(kind==='return'){
          const port=sim.ports.find(p=>p.id===task.portId),entry=port?.entries.find(e=>e.requestId===order.id);
          if(entry)job=sim._planReturn(order,robot,port,entry);
        }else job=kind==='dig'?sim._planDig(order,robot):sim._planSupply(order,robot);
        if(job){job.priorityPrerequisite=!!task.prerequisite;jobs.push({robot,job});if(++feasible>=3)break;}
      }
    }
    if(!jobs.length)break;
    const chosen=sim._rpc('chooseStrategyJob',{candidates:jobs.map(({robot,job},i)=>candidateSummary(sim,robot,job,i))});
    if(chosen===null)break;
    const {robot,job}=jobs[chosen];sim._assignJob(robot,job);
  }
}
