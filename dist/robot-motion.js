// Shared physical dimensions: the raised hoist plate is flush with the fixed roof.
export const ROBOT_ROOF_Y=.640;
export const GRIPPER_THICKNESS=.038;
export const REST_GRIPPER_Y=ROBOT_ROOF_Y-GRIPPER_THICKNESS;
export const BELT_ANCHOR_Y=.635;
// Orthogonal wheels change rail engagement at a standstill at each segment end.
export function getWheelTravelState(operation,elapsed=0){
  if(operation?.type!=='move')return {axis:null,liftX:0,liftZ:0};
  let time=Math.max(0,elapsed);
  for(const segment of operation.segments||[]){
    if(time>segment.duration){time-=segment.duration;continue;}
    const dx=segment.to.x-segment.from.x,dz=segment.to.z-segment.from.z;
    const axis=Math.abs(dx)>Math.abs(dz)?'x':'z';
    const ramp=Math.min(.18,segment.duration/3),u=Math.max(0,Math.min(1,time/ramp,(segment.duration-time)/ramp));
    const lift=.018*u*u*(3-2*u);
    return {axis,liftX:axis==='z'?lift:0,liftZ:axis==='x'?lift:0};
  }
  return {axis:null,liftX:0,liftZ:0};
}

// The next committed movement leg only; never invent a future assignment.
export function getRemainingRobotRoute(robot){
  const job=robot.job;if(!job)return [];
  let index=job.index;
  while(index<job.ops.length&&job.ops[index].type!=='move')index++;
  const op=job.ops[index];if(!op)return [];
  let segment=0,elapsed=index===job.index?job.elapsed:0;
  while(segment<(op.segments?.length||0)&&elapsed>=op.segments[segment].duration-1e-8){elapsed-=op.segments[segment].duration;segment++;}
  const points=[{x:robot.x,z:robot.z}];
  for(const s of (op.segments||[]).slice(segment)){
    const last=points.at(-1);if(Math.hypot(last.x-s.to.x,last.z-s.to.z)>1e-7)points.push({...s.to});
  }
  return points.length>1?points:[];
}
