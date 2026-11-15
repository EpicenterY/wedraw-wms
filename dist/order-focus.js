/** Tracks an explicitly selected customer order without submitting or moving stock. */
export class OrderFocus {
  constructor(sim, book) { this.sim=sim; this.book=book; this.id=null; this.announced=false; }

  get order() { return this.book.orders.find(order=>order.id===this.id)||null; }

  select(id) {
    const order=this.book.orders.find(order=>order.id===id);
    if(!order)throw new Error('선택할 주문을 찾을 수 없습니다.');
    this.id=id;
    // Looking at an old shipment must never replay a completion event.
    this.announced=order.status==='shipped';
    return this.snapshot();
  }

  clear() { this.id=null; this.announced=false; }
  reset() { this.announced=false; }

  snapshot() {
    const order=this.order;
    if(!order)return null;
    const requests=new Map(this.sim.orders.map(request=>[request.id,request]));
    const binIds=new Set(),missingSkuIds=[];
    for(const line of order.lines){
      const sku=this.sim.skuMap.get(line.skuId),request=requests.get(line.requestId);
      // An active request keeps its physical bin identity through grid, robot,
      // and station handoffs. Drafts resolve against the current layout.
      const binId=request?.binId||sku?.binId;
      if(binId&&this.sim.bins.has(binId))binIds.add(binId);
      else missingSkuIds.push(line.skuId);
    }
    const totalQty=order.lines.reduce((sum,line)=>sum+line.qty,0);
    const pickedQty=order.lines.reduce((sum,line)=>sum+Math.min(line.qty,line.pickedQty||0),0);
    return {order,binIds:[...binIds],missingSkuIds,totalQty,pickedQty,
      progress:totalQty?pickedQty/totalQty:0,
      pendingReturns:!!order.pendingBinReturns};
  }

  takeCompletion() {
    const order=this.order;
    if(!order||this.announced||order.status!=='shipped'||!order.lines.length||
      !order.lines.every(line=>line.pickedQty>=line.qty))return null;
    this.announced=true;
    return order;
  }
}
