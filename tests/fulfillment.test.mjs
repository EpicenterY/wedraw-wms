import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';
import {OrderBook} from '../dist/orders.js';

const stockSnapshot = sim => new Map(sim.catalog.map(sku=>[sku.id,sku.qty]));
const pickedBySku = sim => {
  const result=new Map();
  for(const request of sim.orders)result.set(request.skuId,(result.get(request.skuId)||0)+request.pickedQty);
  return result;
};
function assertConserved(sim,initial) {
  const picked=pickedBySku(sim);
  for(const [skuId,qty] of initial)assert.equal(sim.skuMap.get(skuId).qty+(picked.get(skuId)||0),qty,`수량 보존: ${skuId}`);
  sim.assertInvariants();
}
function assertNoEarlyShipment(book,sim) {
  const requests=new Map(sim.orders.map(request=>[request.id,request]));
  for(const order of book.orders){
    const complete=order.lines.every(line=>(requests.get(line.requestId)?.pickedQty||0)>=line.qty);
    assert.equal(order.status==='shipped',complete,`${order.id}: 실제 피킹 완료와 출고 상태 일치`);
    assert.equal(order.packageCount,complete?1:0,`${order.id}: 한 주문은 한 포장`);
    for(const line of order.lines)assert.ok(line.pickedQty<=line.qty,`${line.id}: 과다 피킹 없음`);
  }
}
function finish(sim,book,{observe=()=>{},steps=[.5],limit=30000}={}) {
  let count=0;
  while(sim.running&&count<limit){
    sim.tick(steps[count%steps.length]);book.update();observe(count);
    assertNoEarlyShipment(book,sim);
    if(count%20===0)sim.assertInvariants();
    count++;
  }
  assert.ok(count<limit,`시뮬레이션이 제한 시간 내 종료되어야 합니다: ${sim.time}s`);
  assert.equal(sim.running,false);
  assert.equal(sim.orders.filter(request=>request.status==='blocked').length,0,
    sim.orders.filter(request=>request.status==='blocked').map(request=>`${request.id}:${request.reason}`).join('\n'));
  assert.ok(sim.orders.every(request=>request.status==='complete'),`모든 창고 요청의 빈이 복귀해야 합니다. ${JSON.stringify({
    time:sim.time,stalled:sim.stalled,
    requests:sim.orders.filter(request=>request.status!=='complete').map(({id,status,stage,binId,pickedQty,activeJobId,portId})=>({id,status,stage,binId,pickedQty,activeJobId,portId})),
    robots:sim.robots.map(robot=>({id:robot.id,x:robot.x,z:robot.z,job:robot.job?.id,kind:robot.job?.kind})),
    ports:sim.ports.map(port=>({id:port.id,status:port.status,inlet:port.inletReservation,rotation:port.rotation,shuttle:port.shuttle,entries:port.entries}))
  })}`);
  assert.ok(sim.robots.every(robot=>!robot.job&&!robot.carryingBinId));
  assert.equal(sim.locks.size,0);
  sim.assertInvariants();
}

test('20 mixed customer orders fulfill through real robots and multiple ports, then SKU growth preserves all existing work',()=>{
  const config=createDefaultConfig();
  const sim=new AutoStoreSim({...config,maxHeightM:1.32,robotCount:6,cooperativeDigging:true,
    ports:config.ports.map((port,index)=>({...port,type:index===0?'buffer3':'single'}))});
  const book=new OrderBook(sim);
  const initial=stockSnapshot(sim);
  const orders=book.generate(20,{combinedRatio:.6,seed:'fulfillment-20'});
  assert.equal(orders.length,20);
  assert.ok(orders.some(order=>order.kind==='single')&&orders.some(order=>order.kind==='combined'));
  for(const order of orders)for(const line of order.lines){
    const sku=sim.skuMap.get(line.skuId);assert.ok(sku.assigned&&sku.reachable);
  }
  const requestedUnits=orders.reduce((sum,order)=>sum+order.totalQty,0);
  book.submitAll();
  const requestCount=sim.orders.length;
  assert.equal(requestCount,orders.reduce((sum,order)=>sum+order.lines.length,0));
  book.submitAll();assert.equal(sim.orders.length,requestCount);
  const usedPorts=new Set(),lastPortPick=new Map(),portSequences=new Map();
  let maxActive=0,sawConsolidation=false,sawUnreturnedShipment=false;
  assert.equal(sim.start(),true);
  finish(sim,book,{observe(){
    maxActive=Math.max(maxActive,sim.robots.filter(robot=>robot.job).length);
    for(const request of sim.orders)if(request.portId)usedPorts.add(request.portId);
    sawConsolidation ||= book.orders.some(order=>order.status==='consolidating');
    sawUnreturnedShipment ||= book.orders.some(order=>order.status==='shipped'&&order.pendingBinReturns);
    for(const port of sim.getPortVisuals()){
      assert.ok(port.occupied<=port.capacity&&port.usedSlots<=port.capacity,`${port.id}: 포트 수용량 초과 없음`);
      if(port.activeRequestId&&lastPortPick.get(port.id)!==port.activeRequestId){
        const entry=sim.ports.find(value=>value.id===port.id).entries.find(value=>value.requestId===port.activeRequestId);
        assert.ok(entry.sequence>(portSequences.get(port.id)||0),`${port.id}: 도착 순서대로 한 빈씩 피킹`);
        portSequences.set(port.id,entry.sequence);
      }
      lastPortPick.set(port.id,port.activeRequestId);
    }
  }});
  assert.ok(maxActive>=2,'독립 로봇 작업이 동시에 진행되어야 합니다.');
  assert.equal(usedPorts.size,2,'두 포트를 모두 사용해야 합니다.');
  assert.ok(sawConsolidation,'합포장 구성품이 모이는 대기 상태를 거쳐야 합니다.');
  assert.ok(sawUnreturnedShipment,'출고 완료와 빈 복귀 완료는 서로 다른 시점입니다.');
  assert.ok(book.orders.every(order=>order.status==='shipped'&&order.packageCount===1));
  assert.equal(book.getStats().pickedUnits,requestedUnits);
  assert.equal(book.getStats().packages,20);
  assert.equal(sim.metrics.pickedUnits,requestedUnits);
  assertConserved(sim,initial);

  const beforeCatalog=sim.catalog.map(sku=>({id:sku.id,name:sku.name,spec:sku.spec,qty:sku.qty,initialQty:sku.initialQty,binId:sku.binId,compartment:sku.compartment}));
  const beforeRequests=JSON.stringify(sim.orders);
  const beforeDefinitions=book.exportDefinitions();
  const beforeCustomerState=JSON.stringify(book.orders);
  const beforePicked=sim.metrics.pickedUnits;
  assert.equal(sim.canAddSkus(),true);
  const growth=sim.setSkuCount(1500);book.update();
  assert.equal(growth.added,500);assert.equal(sim.catalog.length,1500);
  assert.equal(new Set(sim.catalog.map(sku=>sku.id)).size,1500);
  assert.equal(new Set(sim.catalog.map(sku=>sku.name)).size,1500);
  assert.deepEqual(sim.catalog.slice(0,1000).map(sku=>({id:sku.id,name:sku.name,spec:sku.spec,qty:sku.qty,initialQty:sku.initialQty,binId:sku.binId,compartment:sku.compartment})),beforeCatalog);
  assert.equal(JSON.stringify(sim.orders),beforeRequests);
  assert.deepEqual(book.exportDefinitions(),beforeDefinitions);
  assert.equal(JSON.stringify(book.orders),beforeCustomerState);
  assert.equal(sim.metrics.pickedUnits,beforePicked);
  assertConserved(sim,initial);
  const newOrders=book.generate(5,{seed:'after-growth'});
  assert.equal(newOrders.length,5);
  assert.ok(newOrders.every(order=>!beforeDefinitions.orders.some(previous=>previous.id===order.id)));
  assert.ok(newOrders.every(order=>order.lines.every(line=>sim.skuMap.get(line.skuId).assigned&&sim.skuMap.get(line.skuId).reachable)));
});

test('cooperative digging can resume and revisit the same deep bin for several customer lines without losing order or stock',()=>{
  const config=createDefaultConfig();
  const sim=new AutoStoreSim({...config,maxHeightM:1.32,robotCount:8,cooperativeDigging:true,
    ports:config.ports.map(port=>({...port,type:'buffer3'}))});
  const initial=stockSnapshot(sim);
  const source=[...sim.cells.values()].filter(cell=>cell.reachable&&cell.stack.length>=3)
    .sort((a,b)=>b.stack.length-a.stack.length)[0];
  assert.ok(source,'디깅을 확인할 깊은 빈이 있어야 합니다.');
  const blockers=source.stack.length-1;
  const bin=sim.bins.get(source.stack[0]);
  const [first,second]=bin.skuIds;
  assert.ok(first&&second);
  const book=new OrderBook(sim);
  book.importDefinitions({version:1,type:'evio-customer-orders',orders:[
    {id:'ORD-DEEP-1',kind:'combined',lines:[{id:'LINE-D1',skuId:first,qty:1},{id:'LINE-D2',skuId:second,qty:1}]},
    {id:'ORD-DEEP-2',kind:'single',lines:[{id:'LINE-D3',skuId:first,qty:1}]}
  ]});
  book.submitAll();assert.equal(sim.orders.length,3);assert.equal(sim.start(),true);
  let paused=false,sawConsolidation=false;const lastPicked=new Map();
  finish(sim,book,{steps:[.13,.87,1.2],observe(){
    for(const request of sim.orders){
      assert.ok(request.pickedQty>=(lastPicked.get(request.id)||0),'실제 피킹 수량은 되돌아가지 않습니다.');
      lastPicked.set(request.id,request.pickedQty);
    }
    sawConsolidation ||= book.orders[0].status==='consolidating';
    if(!paused&&sim.robots.some(robot=>robot.job)&&sim.metrics.relocations>0){
      paused=true;sim.pause();
      const before=JSON.stringify({time:sim.time,robots:sim.getRobotVisuals(),orders:book.orders});
      sim.tick(20);book.update();
      assert.equal(JSON.stringify({time:sim.time,robots:sim.getRobotVisuals(),orders:book.orders}),before);
      assert.equal(sim.start(),true);
    }
  }});
  assert.ok(paused,'디깅 도중 일시정지와 재개를 검증해야 합니다.');
  assert.ok(sawConsolidation);
  assert.ok(sim.orders.some(request=>(request.diggingRobotIds||[]).length>=2),'하나의 깊은 빈 요청에 여러 디깅 로봇이 참여해야 합니다.');
  assert.ok(sim.metrics.relocations>=blockers);
  assert.equal(book.getStats().shippedOrders,2);assert.equal(book.getStats().packages,2);
  assert.equal(book.getStats().pickedUnits,3);assert.equal(sim.metrics.pickedUnits,3);
  assert.equal(sim.bins.get(bin.id).location.type,'grid');
  assertConserved(sim,initial);
});

test('one-layer layout retains inventory and capacity but blocks operations below installation height',()=>{
  const sim=new AutoStoreSim({...createDefaultConfig(),maxHeightM:.33});
  assert.ok(sim.getStats().unassignedSkuCount>0);
  assert.ok(sim.getStats().assignedSkuCount>0);
  assert.equal(sim.getStats().operational,false);
  assert.equal(sim.getStats().operationalSkuCount,0);
  const book=new OrderBook(sim);
  const orders=book.generate(50,{seed:'low-capacity'});
  assert.equal(orders.length,0);
  const sku=sim.catalog.find(sku=>sku.assigned&&sku.reachable);
  assert.ok(sku,'보관 중인 재고는 열람 가능해야 합니다.');
  const request=sim.enqueueSku(sku.id,1);
  assert.equal(request.status,'blocked');
  assert.match(request.reason,/최소 4층/);
  assert.equal(sim.start(),false);
});

test('the shipped default layout fulfills 20 mixed customer orders with its four robots',()=>{
  const sim=new AutoStoreSim(createDefaultConfig()),book=new OrderBook(sim);
  const initial=stockSnapshot(sim);
  assert.equal(sim.config.robotCount,4);assert.equal(sim.actualHeightM,2.64);
  const generated=book.generate(20,{combinedRatio:.6,seed:'default-layout-20'});
  assert.equal(generated.length,20);
  book.submitAll();assert.equal(sim.start(),true);
  finish(sim,book,{steps:[1]});
  assert.equal(book.getStats().shippedOrders,20);assert.equal(book.getStats().packages,20);
  assert.equal(book.getReservedMap().size,0);
  assertConserved(sim,initial);
});
