const robotNumber=id=>/^R\d+$/.test(String(id))?String(id).slice(1).padStart(3,'0'):String(id||'—');

function diggingPhase(robot,job,carrying){
  const operations=Array.isArray(job.ops)?job.ops:[],index=Number.isInteger(job.index)?job.index:0;
  const operation=operations[index]||robot.currentOperation;
  const releaseIndex=operations.findIndex(value=>value.type==='release');
  const released=releaseIndex>=0&&index>releaseIndex;
  const phase=operation?.phase||operation?.type;
  if(phase==='lower-empty')return {phase:'extracting',phaseLabel:'디깅 그리퍼 하강 중'};
  if(phase==='grip')return {phase:'extracting',phaseLabel:'상부 빈 체결 중'};
  if(phase==='raise-loaded')return {phase:'extracting',phaseLabel:'상부 빈 인양 중'};
  if(phase==='lower-loaded')return {phase:'placing',phaseLabel:'상부 빈 적재 하강 중'};
  if(phase==='release')return {phase:'placing',phaseLabel:'상부 빈 내려놓는 중'};
  if(phase==='raise-empty')return {phase:'returning',phaseLabel:'적재 완료 · 그리퍼 복귀 중'};
  if(operation?.type==='move'){
    if(carrying)return {phase:'relocating',phaseLabel:'상부 빈 재배치 운반 중'};
    if(released)return {phase:'returning',phaseLabel:'다음 작업을 위한 통로 확보 중'};
    return {phase:'approaching',phaseLabel:'디깅 위치로 이동 중'};
  }
  if(released)return {phase:'returning',phaseLabel:'디깅 완료 · 다음 작업 준비'};
  return {phase:'waiting',phaseLabel:'디깅 작업 준비'};
}

function targetPhase(robot,job,carrying){
  const operation=job.ops?.[job.index]||robot.currentOperation,phase=operation?.phase||operation?.type;
  const returning=job.kind==='return',optimizing=job.kind==='optimize',relocating=job.kind==='dig';
  const noun=optimizing?'선택 빈 최적화':relocating?'선택 빈 재배치':returning?'목표 빈 회수':'목표 빈';
  if(phase==='lower-empty')return {phase:'extracting',phaseLabel:`${noun} · 그리퍼 하강 중`};
  if(phase==='grip')return {phase:'extracting',phaseLabel:`${noun} 체결 중`};
  if(phase==='raise-loaded')return {phase:'extracting',phaseLabel:`${noun} 인양 중`};
  if(phase==='lower-loaded')return {phase:'placing',phaseLabel:job.kind==='deliver'?'포트 인계 · 목표 빈 하강 중':`${returning?'목표 빈 복귀':noun} 적재 하강 중`};
  if(phase==='release')return {phase:'placing',phaseLabel:job.kind==='deliver'?'목표 빈 포트 인계 중':`${returning?'목표 빈 복귀':noun} 적재 중`};
  if(phase==='raise-empty')return {phase:'returning',phaseLabel:`${job.kind==='deliver'?'포트 인계':returning?'빈 복귀':'재배치'} 완료 · 그리퍼 복귀 중`};
  if(operation?.type==='move')return carrying
    ?{phase:'relocating',phaseLabel:job.kind==='deliver'?'목표 빈 포트 운반 중':returning?'목표 빈 그리드 복귀 중':`${noun} 운반 중`}
    :{phase:'approaching',phaseLabel:returning?'피킹 빈 회수 위치로 이동 중':relocating?'선택 빈 재배치 위치로 이동 중':'목표 빈으로 이동 중'};
  return {phase:'waiting',phaseLabel:`${noun} 작업 준비`};
}

function finishedTargetHandling(robot,job,carrying){
  const operations=Array.isArray(job.ops)?job.ops:[],operation=operations[job.index]||robot.currentOperation;
  const releaseIndex=operations.findIndex(value=>value.type==='release');
  // The empty gripper must still clear the handed-over bin. A later empty
  // repositioning move belongs to traffic/parking, not to this tracked payload.
  return !carrying&&releaseIndex>=0&&job.index>releaseIndex&&operation?.type==='move';
}

/**
 * Read-only view of blockers, assigned diggers and the selected bins' handlers.
 * The current stack is authoritative: a gripped blocker immediately leaves the
 * remaining count and is shown separately while its robot actually carries it.
 */
export function getDiggingContext(sim,binIds=[]){
  const input=typeof binIds==='string'?[binIds]:Array.isArray(binIds)?binIds:binIds instanceof Set?[...binIds]:[];
  const targetBinIds=[...new Set(input.filter(id=>typeof id==='string'&&sim.bins.has(id)))];
  const selected=new Set(targetBinIds),remaining=new Set(),moving=new Set(),movingTargets=new Set();
  const targets=targetBinIds.map(binId=>{
    const bin=sim.bins.get(binId),location=bin.location;
    let locationType=location?.type||'missing',blockerBinIds=[];
    if(locationType==='grid'){
      const cell=sim.cells.get(location.key),index=cell?.stack.indexOf(binId)??-1;
      if(index<0)locationType='missing';
      else blockerBinIds=cell.stack.slice(index+1).filter(id=>sim.bins.has(id));
    }else if(locationType==='robot'){
      if(!sim.robots.some(robot=>robot.id===location.robotId&&robot.carryingBinId===binId))locationType='missing';
    }else if(locationType==='port'){
      if(!sim.ports.some(port=>port.id===location.portId&&port.entries.some(entry=>entry.binId===binId)))locationType='missing';
    }else locationType='missing';
    for(const id of blockerBinIds)remaining.add(id);
    return {binId,locationType,blockerBinIds,remainingCount:blockerBinIds.length,robotIds:[]};
  });
  const byTarget=new Map(targets.map(target=>[target.binId,target])),robots=[];
  if(selected.size)for(const robot of sim.robots){
    const job=robot.job;if(!job||!sim.bins.has(job.binId))continue;
    const bin=sim.bins.get(job.binId),carrying=robot.carryingBinId===job.binId&&bin.location?.type==='robot'&&bin.location.robotId===robot.id;
    const digsForTarget=job.kind==='dig'&&selected.has(job.order?.binId);
    const handlesTarget=selected.has(job.binId)&&(['dig','deliver','return','prelift'].includes(job.kind)||job.kind==='optimize'&&carrying);
    if(!digsForTarget&&!handlesTarget)continue;
    // Ignore the finished carrier's empty parking move, and never turn a
    // historic participant or an unrelated optimizer into a current handler.
    if(handlesTarget&&finishedTargetHandling(robot,job,carrying))continue;
    if(digsForTarget&&carrying)moving.add(job.binId);
    if(handlesTarget&&carrying)movingTargets.add(job.binId);
    const role=handlesTarget?'target':'blocker',targetBinId=handlesTarget?job.binId:job.order.binId;
    const relatedTargets=[...new Set([targetBinId,...(digsForTarget?[job.order.binId]:[])])];
    const detail={robotId:robot.id,number:robotNumber(robot.id),role,taskKind:job.kind,targetBinId,targetBinIds:relatedTargets,
      relatedBinId:job.binId,blockerBinId:role==='blocker'?job.binId:null,
      requestId:job.order?.id??null,...(role==='target'?targetPhase(robot,job,carrying):diggingPhase(robot,job,carrying))};
    robots.push(detail);for(const id of relatedTargets)byTarget.get(id).robotIds.push(robot.id);
  }
  return {targetBinIds,targets,
    // A selected upper bin remains red even if another selected bin lies below
    // it. Keep it in the physical count, but omit it from the grey stack list.
    blockerBinIds:[...remaining].filter(id=>!selected.has(id)),
    // This may include a selected upper bin; the renderer must keep red first.
    movingBlockerBinIds:[...moving],movingTargetBinIds:[...movingTargets],remainingBlockerCount:remaining.size,
    selectedBlockerCount:[...remaining].filter(id=>selected.has(id)).length,robots};
}
