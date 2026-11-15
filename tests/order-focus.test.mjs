import test from 'node:test';
import assert from 'node:assert/strict';
import {OrderFocus} from '../dist/order-focus.js';
import {OrderBook} from '../dist/orders.js';
import {AutoStoreSim,createDefaultConfig} from '../dist/engine.js';

function fixture() {
  const catalog=['A','B','C','D'].map(id=>({id,qty:20,assigned:true,reachable:true,
    operational:true,binId:id==='B'?'BIN-A':`BIN-${id}`}));
  const sim={catalog,skuMap:new Map(catalog.map(sku=>[sku.id,sku])),orders:[],robots:[],time:0,
    bins:new Map(['BIN-A','BIN-C','BIN-D'].map(id=>[id,{id,location:{type:'grid',key:'1,1',level:0}}])),
    enqueueSku(skuId,qty,metadata={}) {
      const request={id:`REQ-${this.orders.length+1}`,skuId,qty,pickedQty:0,
        status:'queued',binId:this.skuMap.get(skuId).binId,...metadata};
      this.orders.push(request);return request;
    },
    pick(requestId,quantity) {
      const request=this.orders.find(value=>value.id===requestId);
      const qty=quantity??request.qty-request.pickedQty;
      assert.ok(qty>=0&&qty<=request.qty-request.pickedQty);
      request.pickedQty+=qty;request.status='inProgress';request.portId='P1';
      this.skuMap.get(request.skuId).qty-=qty;this.time+=5;
    },
    reset() {this.orders=[];this.time=0;for(const sku of this.catalog)sku.qty=20;}
  };
  const book=new OrderBook(sim);
  book.importDefinitions({version:1,type:'evio-customer-orders',orders:[
    {id:'SELECTED',kind:'combined',lines:[
      {id:'SELECTED-A',skuId:'A',qty:2},{id:'SELECTED-B',skuId:'B',qty:3},{id:'SELECTED-C',skuId:'C',qty:1}]},
    {id:'OTHER',kind:'single',lines:[{id:'OTHER-D',skuId:'D',qty:1}]}
  ]});
  return {sim,book,focus:new OrderFocus(sim,book)};
}

test('selection highlights unique real bins and never submits requests or mutates stock',()=>{
  const {sim,book,focus}=fixture();
  const before=JSON.stringify({catalog:sim.catalog,bins:[...sim.bins],requests:sim.orders,orders:book.orders});
  assert.equal(focus.snapshot(),null);assert.equal(focus.takeCompletion(),null);
  const selected=focus.select('SELECTED');
  assert.deepEqual(selected.binIds,['BIN-A','BIN-C']);
  assert.deepEqual(selected.missingSkuIds,[]);
  assert.equal(selected.totalQty,6);assert.equal(selected.pickedQty,0);assert.equal(selected.progress,0);
  assert.equal(JSON.stringify({catalog:sim.catalog,bins:[...sim.bins],requests:sim.orders,orders:book.orders}),before);
  assert.throws(()=>focus.select('MISSING'),/찾을 수/);
  assert.equal(focus.id,'SELECTED');
  focus.clear();assert.equal(focus.snapshot(),null);assert.equal(focus.takeCompletion(),null);
  assert.equal(sim.orders.length,0);
});

test('draft highlights resolve current layout while accepted requests retain bin identity through every handoff',()=>{
  const {sim,book,focus}=fixture();focus.select('SELECTED');
  // A layout rebuild may leave the definition's original line.binId stale.
  sim.bins.set('BIN-NEW',{id:'BIN-NEW',location:{type:'grid',key:'3,2',level:2}});
  sim.skuMap.get('C').binId='BIN-NEW';
  assert.equal(book.orders[0].lines[2].binId,'BIN-C');
  assert.deepEqual(focus.snapshot().binIds,['BIN-A','BIN-NEW']);
  const order=book.submit('SELECTED');
  sim.skuMap.get('C').binId='BIN-C';
  for(const type of ['grid','robot','port','robot','grid']){
    sim.bins.get('BIN-NEW').location={type};
    assert.deepEqual(focus.snapshot().binIds,['BIN-A','BIN-NEW']);
    assert.deepEqual(focus.snapshot().missingSkuIds,[]);
  }
  assert.equal(order.lines[2].binId,'BIN-NEW');
  sim.bins.delete('BIN-NEW');
  assert.deepEqual(focus.snapshot().binIds,['BIN-A']);
  assert.deepEqual(focus.snapshot().missingSkuIds,['C']);
});

test('only all actual units of the selected order produce one completion, independently of bin return',()=>{
  const {sim,book,focus}=fixture();focus.select('SELECTED');
  const selected=book.submit('SELECTED'),other=book.submit('OTHER');
  sim.pick(other.lines[0].requestId);book.update();
  assert.equal(other.status,'shipped');assert.equal(focus.takeCompletion(),null);
  sim.pick(selected.lines[0].requestId);sim.pick(selected.lines[1].requestId,2);book.update();
  assert.equal(selected.status,'consolidating');
  assert.equal(focus.snapshot().pickedQty,4);assert.equal(focus.snapshot().progress,4/6);
  assert.equal(focus.takeCompletion(),null);
  // A status label alone cannot start the fireworks while units are missing.
  selected.status='shipped';assert.equal(focus.takeCompletion(),null);book.update();
  sim.pick(selected.lines[1].requestId,1);book.update();
  assert.equal(focus.takeCompletion(),null);
  sim.pick(selected.lines[2].requestId);book.update();
  assert.equal(focus.takeCompletion(),selected);
  assert.equal(focus.snapshot().pendingReturns,true);
  assert.equal(focus.snapshot().progress,1);
  assert.equal(focus.takeCompletion(),null);
  for(const request of sim.orders)request.status='complete';
  book.update();
  assert.equal(focus.snapshot().pendingReturns,false);assert.equal(focus.takeCompletion(),null);
});

test('opening a completed order is silent and resetting the execution rearms only the next real completion',()=>{
  const {sim,book,focus}=fixture();
  const selected=book.submit('SELECTED');
  for(const line of selected.lines)sim.pick(line.requestId);
  book.update();focus.select('SELECTED');
  assert.equal(focus.takeCompletion(),null);
  focus.clear();focus.select('SELECTED');assert.equal(focus.takeCompletion(),null);
  sim.reset();book.resetExecution();focus.reset();
  assert.equal(focus.id,'SELECTED');assert.equal(focus.order.status,'draft');
  assert.equal(focus.snapshot().progress,0);assert.equal(focus.takeCompletion(),null);
  const replay=book.submit('SELECTED');
  for(const line of replay.lines)sim.pick(line.requestId);
  book.update();
  assert.equal(focus.takeCompletion(),replay);assert.equal(focus.takeCompletion(),null);
});

test('a chosen combined order completes through real grid, robot and port handoffs while other orders stay drafts',()=>{
  const sim=new AutoStoreSim(createDefaultConfig()),book=new OrderBook(sim);
  const bin=[...sim.bins.values()].find(value=>value.skuIds.length>=2&&
    value.skuIds.slice(0,2).every(id=>sim.skuMap.get(id)?.operational&&sim.skuMap.get(id).qty>=2));
  assert.ok(bin,'기본 설계에 실행 가능한 2개 SKU 빈이 있어야 합니다.');
  const otherSku=sim.catalog.find(sku=>sku.operational&&sku.binId!==bin.id);
  book.importDefinitions({version:1,type:'evio-customer-orders',orders:[
    {id:'WATCH',kind:'combined',lines:[{id:'WATCH-1',skuId:bin.skuIds[0],qty:2},{id:'WATCH-2',skuId:bin.skuIds[1],qty:1}]},
    {id:'WAIT',kind:'single',lines:[{id:'WAIT-1',skuId:otherSku.id,qty:1}]}
  ]});
  const focus=new OrderFocus(sim,book),initialStock=new Map(sim.catalog.map(sku=>[sku.id,sku.qty]));
  focus.select('WATCH');
  assert.equal(sim.orders.length,0);assert.deepEqual(focus.snapshot().binIds,[bin.id]);
  book.submit('WATCH');assert.equal(sim.orders.length,2);
  assert.ok(sim.orders.every(request=>request.customerOrderId==='WATCH'));
  assert.equal(sim.start(),true);
  const locations=new Set([sim.bins.get(bin.id).location.type]);let completions=0,sawUnreturnedCompletion=false,steps=0;
  while(sim.running&&steps<16000){
    sim.tick(.5);book.update();steps++;
    locations.add(sim.bins.get(bin.id).location.type);
    assert.deepEqual(focus.snapshot().binIds,[bin.id]);
    assert.equal(book.orders[1].status,'draft');
    const event=focus.takeCompletion();
    if(event){
      completions++;assert.equal(event.id,'WATCH');
      assert.ok(event.lines.every(line=>line.pickedQty===line.qty));
      sawUnreturnedCompletion ||= event.pendingBinReturns;
    }
    if(steps%100===0)sim.assertInvariants();
  }
  assert.ok(steps<16000,'선택 주문의 인출·피킹·복귀가 종료되어야 합니다.');
  assert.equal(completions,1);assert.ok(sawUnreturnedCompletion);
  for(const expected of ['grid','robot','port'])assert.ok(locations.has(expected),`${expected} 위치를 실제로 통과해야 합니다.`);
  assert.ok(sim.orders.every(request=>request.status==='complete'));
  assert.equal(book.orders[0].status,'shipped');assert.equal(book.orders[1].status,'draft');
  assert.equal(sim.bins.get(bin.id).location.type,'grid');
  for(const sku of sim.catalog){
    const picked=sim.orders.filter(request=>request.skuId===sku.id).reduce((sum,request)=>sum+request.pickedQty,0);
    assert.equal(sku.qty+picked,initialStock.get(sku.id));
  }
  sim.assertInvariants();assert.equal(focus.takeCompletion(),null);
});
