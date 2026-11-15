import test from 'node:test';
import assert from 'node:assert/strict';
import {OrderBook} from '../dist/orders.js';

function fakeSim(count=20, quantity=20) {
  const catalog=Array.from({length:count}, (_,index)=>({id:`HW-${String(index+1).padStart(4,'0')}`,
    qty:quantity, assigned:true, reachable:true, binId:`BIN-${index+1}`}));
  return {
    catalog, skuMap:new Map(catalog.map(sku=>[sku.id,sku])), time:0,
    orders:[], robots:[], ports:[],
    enqueueSku(skuId,qty=1,metadata={}) {
      const sku=this.skuMap.get(skuId);
      const reserved=this.orders.filter(request=>request.skuId===skuId&&['queued','inProgress'].includes(request.status))
        .reduce((sum,request)=>sum+Math.max(0,request.qty-request.pickedQty),0);
      const blocked=!sku?.assigned||!sku?.reachable||qty>(sku?.qty||0)-reserved;
      const request={id:`REQ-${this.orders.length+1}`,skuId,qty,pickedQty:0,
        status:blocked?'blocked':'queued',reason:blocked?'재고 또는 출고 경로 부족':'',
        binId:sku?.binId||null,robotIds:[],portId:null,...metadata};
      this.orders.push(request);return request;
    },
    pick(requestId,quantity) {
      const request=this.orders.find(value=>value.id===requestId);
      const qty=quantity??request.qty-request.pickedQty;
      assert.ok(qty>=0&&qty<=request.qty-request.pickedQty);
      this.skuMap.get(request.skuId).qty-=qty;
      request.pickedQty+=qty;request.status='inProgress';
      request.robotId='R1';request.robotIds=['R1','R2'];request.portId='P1';
      this.time+=5;
    },
    returned(requestId) {this.orders.find(value=>value.id===requestId).status='complete';this.time+=2;},
    reset() {this.orders=[];this.robots=[];this.time=0;for(const sku of this.catalog)sku.qty=quantity;}
  };
}

function definitions(orders) {
  return {version:1,type:'evio-customer-orders',orders:orders.map((lines,index)=>({
    id:`ORD-${String(index+1).padStart(4,'0')}`,kind:lines.length===1?'single':'combined',
    label:`테스트 주문 ${index+1}`,createdAt:0,
    lines:lines.map(([skuId,qty],lineIndex)=>({id:`ORD-${index+1}-L${lineIndex+1}`,skuId,qty}))
  }))};
}

function load(sim,orders) {const book=new OrderBook(sim);book.importDefinitions(definitions(orders));return book;}
function requestedBySku(orders) {
  const map=new Map();
  for(const order of orders)for(const line of order.lines)map.set(line.skuId,(map.get(line.skuId)||0)+line.qty);
  return map;
}

test('deterministic generation includes single and combined orders with distinct lines',()=>{
  const first=new OrderBook(fakeSim());const second=new OrderBook(fakeSim());
  const orders=first.generate(20,{seed:'fixed-seed'});
  second.generate(20,{seed:'fixed-seed'});
  assert.equal(orders.length,20);
  assert.deepEqual(first.exportDefinitions(),second.exportDefinitions());
  assert.ok(orders.some(order=>order.kind==='single'));
  assert.ok(orders.some(order=>order.kind==='combined'));
  for(const order of orders){
    assert.equal(new Set(order.lines.map(line=>line.skuId)).size,order.lines.length);
    assert.equal(order.status,'draft');
    assert.ok(order.kind==='single'?order.lines.length===1:order.lines.length>=2&&order.lines.length<=5);
    assert.ok(order.lines.every(line=>line.qty>=1&&line.qty<=3));
  }
});

test('explicit zero and one combined ratios are respected for a sufficiently stocked catalog',()=>{
  const singles=new OrderBook(fakeSim(40,100)).generate(20,{combinedRatio:0,seed:'single-only'});
  const combined=new OrderBook(fakeSim(40,100)).generate(20,{combinedRatio:1,seed:'combined-only'});
  assert.equal(singles.length,20);assert.equal(combined.length,20);
  assert.ok(singles.every(order=>order.kind==='single'&&order.lines.length===1));
  assert.ok(combined.every(order=>order.kind==='combined'&&order.lines.length>=2));
});

test('non-operational stock is excluded from generated orders and blocks imported orders before any request is created',()=>{
  const sim=fakeSim(4,50);sim.catalog[1].operational=false;sim.catalog[3].operational=false;
  const generated=new OrderBook(sim).generate(20,{seed:'installation-check'});
  assert.equal(generated.length,20);
  assert.ok(generated.every(order=>order.lines.every(line=>sim.skuMap.get(line.skuId).operational!==false)));
  const book=load(sim,[[['HW-0001',1],['HW-0002',1]]]);
  const blocked=book.submit('ORD-0001');
  assert.equal(blocked.status,'blocked');assert.match(blocked.reason,/설치 조건/);
  assert.equal(sim.orders.length,0);
  for(const sku of sim.catalog)sku.operational=false;
  assert.deepEqual(new OrderBook(sim).generate(20),[]);
  sim.skuMap.get('HW-0001').operational=true;sim.skuMap.get('HW-0002').operational=true;
  book.submit('ORD-0001');
  assert.equal(blocked.status,'queued');assert.equal(sim.orders.length,2);
});

test('low stock preserves both kinds when possible and never overbooks',()=>{
  const sim=fakeSim(2,1);sim.catalog[1].qty=2;
  const book=new OrderBook(sim);const orders=book.generate(10,{seed:1});
  assert.equal(orders.length,2);
  assert.deepEqual(orders.map(order=>order.kind),['combined','single']);
  for(const [skuId,qty] of requestedBySku(orders))assert.ok(qty<=sim.skuMap.get(skuId).qty);
  assert.deepEqual(book.generate(5),[]);
  const tiny=new OrderBook(fakeSim(2,1));
  tiny.generate(2,{combinedRatio:0,seed:1});
  assert.equal(tiny.orders.length,2);
  assert.ok(tiny.orders.every(order=>order.kind==='single'));
});

test('generation reserves previous drafts and individually queued warehouse work',()=>{
  const sim=fakeSim(4,8);
  sim.enqueueSku('HW-0001',5);
  sim.catalog[2].reachable=false;
  sim.catalog[3].assigned=false;
  const book=new OrderBook(sim);
  book.generate(3,{seed:9});book.generate(10,{seed:10});
  const requested=requestedBySku(book.orders);
  assert.ok((requested.get('HW-0001')||0)<=3);
  assert.ok((requested.get('HW-0002')||0)<=8);
  assert.equal(requested.has('HW-0003'),false);
  assert.equal(requested.has('HW-0004'),false);
  assert.equal(book.getReservedQty('HW-0001'),5+(requested.get('HW-0001')||0));
});

test('draft reservation transfers to engine reservation without double counting',()=>{
  const sim=fakeSim(2,10);
  const book=load(sim,[[['HW-0001',3]],[['HW-0001',4]]]);
  assert.equal(book.getReservedQty('HW-0001'),7);
  const first=book.submit('ORD-0001');
  assert.equal(book.getReservedQty('HW-0001'),7);
  assert.equal(first.status,'queued');
  assert.equal(sim.orders[0].customerOrderId,first.id);
  assert.equal(sim.orders[0].lineId,first.lines[0].id);
  book.submit('ORD-0001');book.submitAll();book.submitAll();
  assert.equal(sim.orders.length,2,'repeated submit never creates duplicate requests');
  assert.equal(book.getReservedQty('HW-0001'),7);
  sim.pick(first.lines[0].requestId,1);book.update();
  assert.equal(book.getReservedQty('HW-0001'),6);
  assert.equal(first.status,'picking');
  assert.equal(first.lines[0].pickedQty,1);
});

test('combined orders ship one package only after all units are actually picked',()=>{
  const sim=fakeSim();
  const book=load(sim,[[['HW-0001',2],['HW-0002',3]]]);
  const order=book.submit('ORD-0001');
  sim.pick(order.lines[0].requestId);book.update();
  assert.equal(order.status,'consolidating');
  assert.equal(order.pickedQty,2);
  assert.equal(order.packageCount,0);assert.equal(order.shippedAt,null);
  sim.pick(order.lines[1].requestId,1);book.update();
  assert.equal(order.status,'consolidating');assert.equal(order.remainingQty,2);
  sim.pick(order.lines[1].requestId,2);book.update();
  assert.equal(order.status,'shipped');assert.equal(order.packageCount,1);
  assert.equal(order.shippedAt,15);assert.equal(order.remainingQty,0);
  assert.deepEqual(order.robotIds,['R1','R2']);assert.deepEqual(order.portIds,['P1']);
  assert.equal(order.pendingBinReturns,true);
  assert.ok(sim.orders.every(request=>request.status==='inProgress'));
  assert.throws(()=>book.clear(),/미반납/);
  for(const request of sim.orders)sim.returned(request.id);
  book.update();
  assert.equal(order.pendingBinReturns,false);assert.equal(order.shippedAt,15);
  assert.equal(book.getStats().packages,1);
  assert.equal(book.clear(),true);
});

test('single orders also require complete actual quantity, not request completion alone',()=>{
  const sim=fakeSim();const book=load(sim,[[['HW-0001',3]]]);
  const order=book.submit('ORD-0001');
  sim.orders[0].status='complete';book.update();
  assert.equal(order.status,'blocked');assert.equal(order.packageCount,0);assert.equal(order.pickedQty,0);
  sim.pick(sim.orders[0].id,2);book.update();
  assert.equal(order.status,'picking');assert.equal(order.packageCount,0);
  sim.pick(sim.orders[0].id,1);book.update();
  assert.equal(order.status,'shipped');assert.equal(order.packageCount,1);
});

test('preflight checks every line and enqueues nothing when any line cannot ship',()=>{
  const sim=fakeSim();const book=load(sim,[[['HW-0001',2],['HW-0002',2]]]);
  sim.skuMap.get('HW-0002').reachable=false;
  const order=book.submit('ORD-0001');
  assert.equal(order.status,'blocked');assert.match(order.reason,/출고 경로/);
  assert.equal(sim.orders.length,0);assert.equal(order.pickedQty,0);
  sim.skuMap.get('HW-0002').reachable=true;
  book.submit('ORD-0001');
  assert.equal(order.status,'queued');assert.equal(sim.orders.length,2);
});

test('external warehouse request received after generation is included in submit preflight',()=>{
  const sim=fakeSim(2,5);const book=load(sim,[[['HW-0001',4],['HW-0002',2]]]);
  sim.enqueueSku('HW-0001',3);
  const order=book.submit('ORD-0001');
  assert.equal(order.status,'blocked');assert.match(order.reason,/가용 재고 부족/);
  assert.equal(sim.orders.length,1);
  assert.equal(book.getReservedQty('HW-0001'),3);
});

test('an unexpected mid-submission error remains honest and does not duplicate accepted lines',()=>{
  const sim=fakeSim();const normal=sim.enqueueSku.bind(sim);let calls=0;
  sim.enqueueSku=(...args)=>{if(++calls===2)throw new Error('시험용 접수 오류');return normal(...args);};
  const book=load(sim,[[['HW-0001',1],['HW-0002',1],['HW-0003',1]]]);
  const order=book.submit('ORD-0001');
  assert.equal(order.status,'blocked');assert.equal(sim.orders.length,1);
  assert.equal(order.lines[1].requestId,null);assert.equal(order.lines[2].requestId,null);
  sim.pick(sim.orders[0].id);book.update();
  assert.equal(order.pickedQty,1);assert.equal(order.packageCount,0);assert.equal(order.status,'blocked');
  book.submit(order.id);assert.equal(sim.orders.length,1);assert.equal(calls,2);
});

test('engine rejection of a later line does not mark the whole package picked',()=>{
  const sim=fakeSim();const normal=sim.enqueueSku.bind(sim);let calls=0;
  sim.enqueueSku=(...args)=>{const request=normal(...args);if(++calls===2){request.status='blocked';request.reason='경로 변경';}return request;};
  const book=load(sim,[[['HW-0001',1],['HW-0002',1]]]);
  const order=book.submit('ORD-0001');
  sim.pick(sim.orders[0].id);book.update();
  assert.equal(order.status,'blocked');assert.equal(order.pickedQty,1);assert.equal(order.packageCount,0);
});

test('definitions export and import preserve only order definitions and restore drafts',()=>{
  const sim=fakeSim();const book=load(sim,[[['HW-0001',2],['HW-0002',3]],[['HW-0003',1]]]);
  book.submitAll();for(const request of sim.orders)sim.pick(request.id);book.update();
  const saved=book.exportDefinitions();
  assert.equal('status' in saved.orders[0],false);
  assert.equal('pickedQty' in saved.orders[0].lines[0],false);
  const restored=new OrderBook(fakeSim());restored.importDefinitions(JSON.stringify(saved));
  assert.deepEqual(restored.exportDefinitions(),saved);
  assert.ok(restored.orders.every(order=>order.status==='draft'&&order.packageCount===0&&order.shippedAt===null));
  assert.ok(restored.orders.every(order=>order.lines.every(line=>line.pickedQty===0&&line.requestId===null)));
  restored.generate(1);assert.equal(restored.orders.at(-1).id,'ORD-0003');
});

test('reset execution and clearing guard unreturned work, then preserve definitions after engine reset',()=>{
  const sim=fakeSim();const book=load(sim,[[['HW-0001',1]]]);const saved=book.exportDefinitions();
  book.submitAll();
  assert.throws(()=>book.resetExecution(),/미반납/);
  assert.throws(()=>book.importDefinitions(saved),/미반납/);
  sim.reset();book.resetExecution();
  assert.deepEqual(book.exportDefinitions(),saved);assert.equal(book.orders[0].status,'draft');
  assert.equal(book.getReservedQty('HW-0001'),1);
  sim.robots=[{job:{type:'return'}}];assert.throws(()=>book.clear(),/미반납/);
  sim.robots=[];assert.equal(book.clear(),true);assert.equal(book.orders.length,0);
});

test('malformed import is atomic and unavailable SKU definitions become honest blocked orders',()=>{
  const sim=fakeSim();const book=load(sim,[[['HW-0001',1]]]);const before=book.exportDefinitions();
  const malformed=definitions([[['HW-0002',1]],[['HW-0003',1],['HW-0003',2]]]);
  assert.throws(()=>book.importDefinitions(malformed),/중복/);
  assert.deepEqual(book.exportDefinitions(),before);
  assert.throws(()=>book.importDefinitions({...before,version:2}),/지원하지/);
  const unknown=definitions([[['HW-9999',1]]]);book.importDefinitions(unknown);
  assert.equal(book.orders[0].status,'draft');book.submitAll();
  assert.equal(book.orders[0].status,'blocked');assert.equal(sim.orders.length,0);
});

test('catalog deletion blocks unsubmitted orders on refresh while preserving completed shipments',()=>{
  const sim=fakeSim(),book=load(sim,[[['HW-0001',1]],[['HW-0002',1]]]);
  book.submit('ORD-0001');sim.pick(book.orders[0].lines[0].requestId);sim.returned(book.orders[0].lines[0].requestId);book.update();
  assert.equal(book.orders[0].status,'shipped');
  const shippedAt=book.orders[0].shippedAt;
  sim.skuMap.delete('HW-0001');sim.skuMap.delete('HW-0002');
  sim.catalog=sim.catalog.filter(sku=>!['HW-0001','HW-0002'].includes(sku.id));
  book.update();
  assert.equal(book.orders[0].status,'shipped');assert.equal(book.orders[0].shippedAt,shippedAt);
  assert.equal(book.orders[1].status,'blocked');assert.match(book.orders[1].reason,/SKU/);
  assert.equal(sim.orders.length,1);
  const restored=new OrderBook(sim);restored.importDefinitions(book.exportDefinitions());restored.update();
  assert.ok(restored.orders.every(order=>order.status==='blocked'));
});

test('stats distinguish package completion from warehouse bin returns',()=>{
  const sim=fakeSim();const book=load(sim,[[['HW-0001',2]],[['HW-0002',1],['HW-0003',3]],[['HW-0004',1]]]);
  assert.deepEqual(book.getStats(),{totalOrders:3,draftOrders:3,activeOrders:0,queuedOrders:0,pickingOrders:0,
    consolidatingOrders:0,shippedOrders:0,blockedOrders:0,singleOrders:2,combinedOrders:1,totalUnits:7,pickedUnits:0,packages:0});
  book.submit('ORD-0001');book.submit('ORD-0002');
  sim.pick(book.orders[0].lines[0].requestId);sim.pick(book.orders[1].lines[0].requestId);book.update();
  const stats=book.getStats();
  assert.equal(stats.shippedOrders,1);assert.equal(stats.consolidatingOrders,1);assert.equal(stats.activeOrders,1);
  assert.equal(stats.draftOrders,1);assert.equal(stats.totalUnits,7);assert.equal(stats.pickedUnits,3);assert.equal(stats.packages,1);
});

test('ten-thousand SKU catalogs participate in generation without a 1,000 SKU cutoff',()=>{
  const book=new OrderBook(fakeSim(10000,5));const orders=book.generate(50,{seed:1107});
  assert.equal(orders.length,50);
  assert.ok(orders.flatMap(order=>order.lines).some(line=>Number(line.skuId.slice(3))>1000));
  assert.deepEqual(book.generate(0),[]);
  assert.throws(()=>book.generate(10001),/10,000/);
});

test('large imported numeric identifiers cannot stall generated ID allocation',()=>{
  const book=new OrderBook(fakeSim());
  const payload=definitions([[['HW-0001',1]]]);
  payload.orders[0].id='ORD-999999999999999999999999999999999';
  book.importDefinitions(payload);
  const created=book.generate(2,{seed:99});
  assert.equal(created.length,2);
  assert.equal(new Set(book.orders.map(order=>order.id)).size,3);
  assert.deepEqual(created.map(order=>order.id),['ORD-0001','ORD-0002']);
});
