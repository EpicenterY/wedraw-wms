const STAGES={prelifting:'다음 빈 선행 리프팅',prelift_ready:'리프팅 완료 · 포트 인계 대기',queued:'로봇 배정 대기',digging:'디깅 중',awaiting_dig:'다음 디깅 준비',delivering:'포트로 운반 중',port_queue:'포트 피킹 대기',picking:'포트 피킹 중',awaiting_return:'피킹 완료 · 빈 회수 대기',returning:'빈 복귀 중',complete:'빈 복귀 완료'};
const PORT_STAGES={reserved:'빈 인계 중',waiting:'버퍼 대기',picking:'포트 피킹 중',ready:'피킹 완료 · 회수 대기',outbound:'로봇 회수 대기'};
const pending=request=>request.status==='queued'||request.status==='inProgress';
const unique=values=>[...new Set(values.filter(Boolean))];
const robotNumber=id=>/^R\d+$/.test(String(id))?String(id).slice(1).padStart(3,'0'):String(id||'—');

/** Describe physical ownership without inferring a stored cell for a moving bin. */
export function describeBinLocation(sim,binId){
  const bin=sim.bins.get(binId),location=bin?.location;
  const missing={binId,available:false,type:'missing',label:'현재 위치 확인 불가',stateLabel:'추적 대상 없음',cell:null,robotId:null,portId:null};
  if(!location)return missing;
  if(location.type==='grid'){
    const cell=sim.cells.get(location.key),level=cell?.stack.indexOf(binId)??-1;
    if(!cell||level<0)return missing;
    return {...missing,available:true,type:'grid',label:`셀 (${cell.x+1}, ${cell.z+1}) · ${level+1}층`,stateLabel:'그리드 적재',cell:{x:cell.x,z:cell.z,level:level+1}};
  }
  if(location.type==='robot'){
    const robot=sim.robots.find(value=>value.id===location.robotId&&value.carryingBinId===binId);
    if(!robot)return missing;
    return {...missing,available:true,type:'robot',robotId:robot.id,label:`로봇 ${robotNumber(robot.id)} · 인양·운반 중`,stateLabel:robot.currentOperation?.label||robot.status||'빈 운반 중'};
  }
  if(location.type==='port'){
    const port=sim.ports.find(value=>value.id===location.portId),entry=port?.entries.find(value=>value.binId===binId);
    if(!entry)return missing;
    return {...missing,available:true,type:'port',portId:port.id,label:`${port.id} · ${entry.slot===0?'작업 위치':`내부 슬롯 ${entry.slot===null?'인계':entry.slot+1}`}`,stateLabel:PORT_STAGES[entry.status]||'포트 내부 이송'};
  }
  return missing;
}

/** Read-only, live projection of submitted requests into their customer orders. */
export function getOperationGroups(sim,book){
  const customers=new Map((book?.orders||[]).map(order=>[order.id,order]));
  const groups=new Map(),jobs=new Map();
  const urgentWaiting=sim.orders.some(request=>pending(request)&&request.priority==='urgent');
  for(const robot of sim.robots){
    if(!robot.job||robot.job.kind==='optimize')continue;
    const id=robot.job.order.id;
    if(!jobs.has(id))jobs.set(id,[]);
    jobs.get(id).push({robotId:robot.id,kind:robot.job.kind,binId:robot.job.binId,label:robot.currentOperation?.label||robot.status});
  }
  for(const request of sim.orders){
    const groupKey=request.customerOrderId?`customer:${request.customerOrderId}`:`request:${request.id}`;
    if(!groups.has(groupKey)){
      const customer=customers.get(request.customerOrderId);
      groups.set(groupKey,{key:groupKey,id:request.customerOrderId||request.id,customerOrderId:request.customerOrderId||null,
        kind:customer?.kind==='combined'?'합포장':customer?'단품':request.source==='inventory'?'재고 반출':'개별 반출',
        requests:[],createdAt:request.createdAt,sequence:request.sequence||0,prioritySequence:Infinity});
    }
    if(request.priority==='urgent')groups.get(groupKey).prioritySequence=Math.min(groups.get(groupKey).prioritySequence,request.prioritySequence??request.sequence??0);
    const activeTasks=jobs.get(request.id)||[],sku=sim.skuMap.get(request.skuId);
    let reason=request.reason||'';
    if(!reason&&pending(request)&&!activeTasks.length&&request.priority!=='urgent'&&urgentWaiting&&['queued','awaiting_dig'].includes(request.stage))reason='우선 반출 처리 대기';
    groups.get(groupKey).requests.push({id:request.id,skuId:request.skuId,name:sku?.name||request.name||request.skuId,
      binId:request.binId,qty:request.qty,pickedQty:Math.min(request.qty,request.pickedQty||0),priority:request.priority||'normal',
      status:request.status,stage:request.stage,stageLabel:request.status==='blocked'?'확인 필요':request.status==='complete'?'빈 복귀 완료':STAGES[request.stage]||'반출 진행 중',
      reason,portId:request.portId||null,activeTasks,robotIds:activeTasks.map(task=>task.robotId)});
  }
  const result=[];
  for(const group of groups.values()){
    const requests=group.requests,active=requests.filter(request=>request.status==='inProgress'),queued=requests.filter(request=>request.status==='queued'),blocked=requests.filter(request=>request.status==='blocked');
    const customer=customers.get(group.customerOrderId),binIds=unique(requests.map(request=>request.binId));
    // Include every submitted customer line, including one already picked and returned.
    // An existing request always supplies its original physical bin identity.
    for(const line of customer?.lines||[]){
      const request=requests.find(value=>value.id===line.requestId||value.skuId===line.skuId);
      const binId=request?.binId||sim.skuMap.get(line.skuId)?.binId;
      if(binId&&!binIds.includes(binId))binIds.push(binId);
    }
    const bins=binIds.map(id=>describeBinLocation(sim,id));
    const stageCounts=new Map();
    for(const request of active.length?active:queued.length?queued:blocked.length?blocked:requests){
      stageCounts.set(request.stageLabel,(stageCounts.get(request.stageLabel)||0)+1);
    }
    const totalQty=requests.reduce((sum,request)=>sum+request.qty,0),pickedQty=requests.reduce((sum,request)=>sum+request.pickedQty,0);
    const status=active.length?'inProgress':queued.length?'queued':blocked.length?'blocked':'complete';
    result.push({...group,priority:requests.some(request=>request.priority==='urgent')?'urgent':'normal',status,
      activeCount:active.length,queuedCount:queued.length,blockedCount:blocked.length,totalQty,pickedQty,progress:totalQty?pickedQty/totalQty:0,
      stageSummary:[...stageCounts].map(([label,count])=>`${label}${count>1?` ${count}건`:''}`).join(' · '),
      reason:unique(requests.filter(request=>request.status!=='complete').map(request=>request.reason)).join(' · '),
      robotIds:unique(requests.flatMap(request=>request.robotIds)),portIds:unique(requests.map(request=>request.portId)),
      binIds,bins,availableBinIds:bins.filter(bin=>bin.available).map(bin=>bin.binId),
      elapsedSec:Math.max(0,sim.time-group.createdAt)});
  }
  return result.sort((a,b)=>Number(b.priority==='urgent')-Number(a.priority==='urgent')||(a.priority==='urgent'&&b.priority==='urgent'?a.prioritySequence-b.prioritySequence:0)||a.sequence-b.sequence||a.createdAt-b.createdAt);
}
