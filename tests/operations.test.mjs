import assert from 'node:assert/strict';
import test from 'node:test';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {OrderBook} from '../dist/orders.js';
import {getOperationGroups,describeBinLocation} from '../dist/operations.js';

const pending=request=>request.status==='queued'||request.status==='inProgress';
const snapshot=(sim,book)=>JSON.stringify({sim,orders:book?.orders},(_key,value)=>value instanceof Map?[...value]:value instanceof Set?[...value]:value);

function readOnlyGroups(sim,book){
  const before=snapshot(sim,book),groups=getOperationGroups(sim,book);
  for(const group of groups)for(const binId of group.binIds)describeBinLocation(sim,binId);
  assert.deepEqual(getOperationGroups(sim,book),groups,'repeated observations return the same live projection');
  assert.equal(snapshot(sim,book),before,'opening operations and location details must not dispatch, move, pick, or alter requests');
  return groups;
}

function topBins(sim,count){
  const port=sim.ports[0],bins=[...sim.cells.values()].filter(c=>c.operational&&c.stack.length)
    .sort((a,b)=>(a.x-port.x)**2+(a.z-port.z)**2-((b.x-port.x)**2+(b.z-port.z)**2))
    .map(c=>sim.bins.get(c.stack.at(-1))).filter(bin=>bin.skuIds.length>=2);
  assert.ok(bins.length>=count);return bins.slice(0,count);
}

function makeBook(sim,orders){
  const book=new OrderBook(sim);
  book.importDefinitions({version:1,type:'evio-customer-orders',orders:orders.map((lines,index)=>({
    id:`ORD-${String(index+1).padStart(4,'0')}`,kind:lines.length===1?'single':'combined',label:`운영 추적 주문 ${index+1}`,createdAt:0,
    lines:lines.map(([skuId,qty],line)=>({id:`ORD-${index+1}-L${line+1}`,skuId,qty}))
  }))});
  return book;
}

function runUntil(sim,book,condition,label,observe=()=>{}){
  let steps=0;
  while(!condition()&&steps++<15000){
    assert.equal(sim.running,true,`${label}: unexpected stop at ${sim.time.toFixed(1)} s`);
    sim.tick(.1);book?.update();observe();if(steps%10===0)sim.assertInvariants();
  }
  assert.ok(steps<15000,`${label}: simulation reaches its goal`);assert.equal(sim.stalled,false);sim.assertInvariants();
}

function assertPhysicalLocation(sim,description){
  const {binId}=description,bin=sim.bins.get(binId);assert.ok(bin);assert.equal(description.available,true);assert.equal(description.type,bin.location.type);
  if(bin.location.type==='grid'){
    const cell=sim.cells.get(bin.location.key),level=cell.stack.indexOf(binId)+1;
    assert.deepEqual(description.cell,{x:cell.x,z:cell.z,level});assert.equal(description.robotId,null);assert.equal(description.portId,null);
    assert.ok(description.label.includes(`(${cell.x+1}, ${cell.z+1})`));assert.ok(description.label.includes(`${level}층`));
  }else if(bin.location.type==='robot'){
    const robot=sim.robots.find(value=>value.id===bin.location.robotId);
    assert.equal(robot.carryingBinId,binId);assert.equal(description.robotId,robot.id);assert.equal(description.cell,null);assert.equal(description.portId,null);
    assert.ok(description.label.includes(robot.id.slice(1).padStart(3,'0')),'moving-bin locations show the branded three-digit robot number');
  }else if(bin.location.type==='port'){
    const port=sim.ports.find(value=>value.id===bin.location.portId),entry=port.entries.find(value=>value.binId===binId);
    assert.ok(entry);assert.equal(description.portId,port.id);assert.equal(description.cell,null);assert.equal(description.robotId,null);
    assert.ok(description.label.includes(port.id));if(entry.slot===0)assert.ok(description.label.includes('작업 위치'));
  }else assert.fail(`unknown physical ownership: ${bin.location.type}`);
}

test('operation groups keep customer orders and individual retrievals separate, deduplicate physical bins and sort urgent requests first',()=>{
  const sim=new AutoStoreSim(createDefaultConfig()),[a,b,c,d]=topBins(sim,4);
  const book=makeBook(sim,[[[a.skuIds[0],1],[a.skuIds[1],2]],[[b.skuIds[0],1]],[[d.skuIds[0],1]]]);
  book.submit('ORD-0001');book.submit('ORD-0002');
  const individual=sim.enqueueSku(c.skuIds[0],1),priority=sim.enqueueSku(a.skuIds[0],1,{priority:'urgent',source:'inventory'});
  const groups=readOnlyGroups(sim,book);
  assert.deepEqual(groups.map(group=>group.key),[`request:${priority.id}`,'customer:ORD-0001','customer:ORD-0002',`request:${individual.id}`]);
  assert.equal(groups[0].kind,'재고 반출');assert.equal(groups[0].priority,'urgent');assert.equal(groups[1].kind,'합포장');assert.equal(groups[2].kind,'단품');assert.equal(groups[3].kind,'개별 반출');
  assert.equal(groups.length,4,'unsubmitted draft orders are absent from active warehouse operations');
  const customer=groups[1];assert.equal(customer.requests.length,2);assert.deepEqual(customer.binIds,[a.id]);assert.deepEqual(customer.availableBinIds,[a.id]);assert.equal(customer.bins.length,1);
  assert.equal(customer.totalQty,3);assert.equal(customer.pickedQty,0);assert.equal(customer.progress,0);assert.equal(customer.queuedCount,2);
  assert.match(customer.reason,/우선.*대기/);assert.ok(customer.requests.every(request=>/우선.*대기/.test(request.reason)));
  assert.ok(customer.requests.every(request=>request.binId===a.id));assert.notEqual(groups[0].key,customer.key,'manual urgent retrieval of a customer bin remains its own operation');
  for(const group of groups)for(const bin of group.bins)assertPhysicalLocation(sim,bin);
  const originalQty=sim.orders[0].qty;customer.requests[0].qty=999;
  assert.equal(sim.orders[0].qty,originalQty,'editing a returned presentation object cannot mutate the live request');
});

test('one customer order retains all original bins through real grid, robot, port and return stages, including its completed lines',()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:1.32,robotCount:1,ports:[{id:'P1',x:0,z:7,type:'single'}]}),[a,b]=topBins(sim,2);
  const book=makeBook(sim,[[[a.skuIds[0],1],[a.skuIds[1],1],[b.skuIds[0],1]]]);book.submitAll();
  const requests=[...sim.orders],originalIds=requests.map(request=>request.binId),ownership=[],expectedBins=[a.id,b.id];
  const observe=()=>{
    const group=getOperationGroups(sim,book)[0];assert.deepEqual(group.binIds,expectedBins);assert.deepEqual(group.availableBinIds,expectedBins);
    assert.deepEqual(requests.map(request=>request.binId),originalIds,'moving bins keep their original physical IDs');
    for(const description of group.bins)assertPhysicalLocation(sim,description);
    const type=describeBinLocation(sim,a.id).type;
    if(ownership.at(-1)!==type){ownership.push(type);readOnlyGroups(sim,book);}
    const picked=requests.reduce((sum,request)=>sum+request.pickedQty,0);assert.equal(group.pickedQty,picked);assert.equal(group.progress,picked/3);
    assert.equal(group.activeCount,requests.filter(request=>request.status==='inProgress').length);
    for(const request of group.requests)for(const task of request.activeTasks){
      const robot=sim.robots.find(value=>value.id===task.robotId);assert.equal(robot.job.order.id,request.id);assert.equal(task.binId,robot.job.binId);assert.equal(task.kind,robot.job.kind);
    }
  };
  observe();assert.equal(sim.start(),true);
  runUntil(sim,book,()=>requests[0].status==='complete'&&requests.slice(1).some(pending),'first customer line returned while its other lines remain',observe);
  const partial=readOnlyGroups(sim,book)[0];assert.equal(partial.requests[0].status,'complete');assert.ok(partial.binIds.includes(requests[0].binId));
  assert.ok(partial.progress>0&&partial.progress<1);assert.ok(partial.status==='queued'||partial.status==='inProgress');
  assert.deepEqual(ownership.slice(0,5),['grid','robot','port','robot','grid']);
  runUntil(sim,book,()=>requests.every(request=>request.status==='complete'),'complete customer order',observe);
  const complete=readOnlyGroups(sim,book)[0];assert.equal(complete.status,'complete');assert.equal(complete.progress,1);assert.equal(complete.activeCount,0);assert.deepEqual(complete.robotIds,[]);
  assert.ok(complete.bins.every(bin=>bin.type==='grid'));assert.equal(book.orders[0].status,'shipped');

  // Inventory editing removes catalog records, not the identity or location of
  // the physical bin used by a submitted and now completed customer request.
  const deletedSkuIds=[...a.skuIds],originalNames=requests.slice(0,2).map(request=>request.name);
  sim.removeSkus(deletedSkuIds);book.update();assert.equal(sim.bins.get(a.id).skuIds.length,0);
  const historical=readOnlyGroups(sim,book)[0];assert.deepEqual(historical.binIds,expectedBins);assert.deepEqual(historical.availableBinIds,expectedBins);
  assert.deepEqual(historical.requests.slice(0,2).map(request=>request.name),originalNames,'completed line names survive removal of their catalog entries');
  assertPhysicalLocation(sim,historical.bins.find(bin=>bin.binId===a.id));sim.assertInvariants();
});

test('a normal request yielding after a real digging transfer explains its wait and clears that reason when work resumes',()=>{
  const sim=new AutoStoreSim(createDefaultConfig());
  const source=[...sim.cells.values()].filter(cell=>cell.operational&&cell.robotIds.length>=2&&cell.stack.length>=4).sort((a,b)=>b.stack.length-a.stack.length)[0];
  assert.ok(source);const target=sim.bins.get(source.stack[0]),normal=sim.enqueueSku(target.skuIds[0],1);
  assert.equal(sim.start(),true);
  runUntil(sim,null,()=>sim.robots.some(robot=>robot.job?.order===normal&&robot.job.kind==='dig'&&robot.carryingBinId),'loaded normal digging');
  const whileDigging=readOnlyGroups(sim)[0];assert.deepEqual(whileDigging.binIds,[target.id]);
  assert.ok(whileDigging.requests[0].activeTasks.some(task=>task.kind==='dig'&&task.binId!==target.id),'helper tasks name the blocker they really carry while order tracking still names the target bin');
  const other=topBins(sim,8).find(bin=>bin.location.key!==source.key&&!sim.robots.some(robot=>robot.job?.toKey===bin.location.key));assert.ok(other);
  const priority=sim.enqueueSku(other.skuIds[0],1,{priority:'urgent',source:'inventory'});
  runUntil(sim,null,()=>pending(priority)&&normal.stage==='awaiting_dig'&&!sim.robots.some(robot=>robot.job?.order===normal),'normal safely yields its next digging mission');
  const waiting=readOnlyGroups(sim).find(group=>group.id===normal.id);assert.equal(waiting.status,'inProgress');assert.deepEqual(waiting.robotIds,[]);
  assert.match(waiting.reason,/우선.*대기/,'a partially started normal request explains that urgent work is taking precedence');
  assert.match(waiting.requests[0].reason,/우선.*대기/);assert.ok(getOperationGroups(sim)[0].id===priority.id);
  runUntil(sim,null,()=>priority.status==='complete'&&sim.robots.some(robot=>robot.job?.order===normal),'normal resumes after priority return');
  const resumed=readOnlyGroups(sim).find(group=>group.id===normal.id);assert.ok(resumed.robotIds.length);assert.equal(resumed.reason,'');
  runUntil(sim,null,()=>sim.orders.every(request=>request.status==='complete'),'all grouped operations complete');
  assert.ok(readOnlyGroups(sim).every(group=>group.status==='complete'&&group.progress===1));
});

test('unknown bins return an unavailable location without inventing cells, robots or port ownership',()=>{
  const sim=new AutoStoreSim(createDefaultConfig()),before=snapshot(sim);
  assert.deepEqual(getOperationGroups(sim),[]);
  const location=describeBinLocation(sim,'B-MISSING');
  assert.equal(location.binId,'B-MISSING');assert.equal(location.available,false);assert.equal(location.type,'missing');
  assert.equal(location.cell,null);assert.equal(location.robotId,null);assert.equal(location.portId,null);
  assert.equal(snapshot(sim),before,'missing-location lookups are read-only too');
});
