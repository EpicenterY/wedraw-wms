import {RustWarehouse} from './rust-core.js';
import {reconcile} from './warehouse-runtime.js';
let nextBookId=0;
/**
 * Customer orders sit above the engine's warehouse pick requests (sim.orders).
 *
 * generate() returns newly appended draft orders. submit()/submitAll() enqueue
 * each line once. Call update() after sim.tick(). A package ships only when all
 * requested units have actually been picked; the robot may still return bins.
 * Reservations = unsubmitted draft lines + queued/inProgress unpicked requests.
 * Call sim.reset() before resetExecution() to replay the same order definitions.
 * exportDefinitions() returns a plain versioned object; importDefinitions()
 * ignores execution fields and always restores drafts. No browser APIs are used.
 */

const ACTIVE_REQUESTS = new Set(['queued', 'inProgress']);
const ACTIVE_ORDERS = new Set(['queued', 'picking', 'consolidating']);
const integer = value => Math.max(0, Math.floor(Number(value) || 0));
const unique = values => [...new Set(values.filter(value => value != null && value !== ''))];
const idIsValid = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(value);

function randomGenerator(seed) {
  let state = 2166136261;
  for (const char of String(seed)) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function newLine(id, skuId, qty) {
  return {id, skuId, qty, pickedQty:0, status:'draft', requestId:null,
    requestStatus:null, binId:null, portId:null, robotIds:[], pickedAt:null, reason:''};
}

function newOrder({id, kind, label, createdAt, lines}) {
  return {id, kind, label, name:label, status:'draft', lines, createdAt,
    submittedAt:null, shippedAt:null, reason:'', packageCount:0, robotIds:[],
    portIds:[], totalQty:lines.reduce((sum, line) => sum + line.qty, 0),
    pickedQty:0, remainingQty:lines.reduce((sum, line) => sum + line.qty, 0),
    pendingBinReturns:false};
}

export class OrderBook {
  constructor(sim, {seed='evio-customer-orders'} = {}) {
    if (!sim || typeof sim.enqueueSku !== 'function') {
      throw new Error('출고 요청을 처리할 시뮬레이터가 필요합니다.');
    }
    this.sim = sim;
    this.orders = [];
    this._sequence = 1;
    this._random = randomGenerator(seed);
    this._bookId=String(++nextBookId);this._bookCall('bookAttach',{orders:[]});
  }

  _bookCall(op,args={}){
    this.sim._ensureRuntime?.();
    const runtime=this.sim._runtime??(this._standalone??=new RustWarehouse());
    const external=this.sim._runtime?undefined:{skus:Object.fromEntries(this._catalog().map(s=>[s.id,s])),requests:Object.fromEntries(this._requests().map(r=>[r.id,r])),busy:!!this.sim.robots?.some(r=>r.job)};
    if(this._boundRuntime!==runtime){
      this._boundRuntime=runtime;
      if(!this.sim._runtime)runtime.call('init',{skus:{},orders:{},ports:{},config:{},components:[],metrics:{}});
      runtime.call('bookAttach',{bookId:this._bookId,orders:this.orders,external},this._now());
    }
    let result;
    if(this.sim._runtime)result=this.sim._rpc(op,{bookId:this._bookId,...args});
    else{
      const response=runtime.call(op,{bookId:this._bookId,external,...args},this._now());result=response.value;
      for(const [id,request] of Object.entries(response.delta.orders)){
        const target=this._requests().find(r=>r.id===id);if(target)reconcile(target,request);
      }
    }
    reconcile(this.orders,result.orders);return result.value;
  }
  _now() { return Math.max(0, Number(this.sim.time) || 0); }
  _requests() { return Array.isArray(this.sim.orders) ? this.sim.orders : (this.sim.requests || []); }
  _catalog() { return this.sim.catalog || [...(this.sim.skuMap?.values() || [])]; }
  _sku(id) { return this.sim.skuMap?.get(id) || this._catalog().find(sku => sku.id === id); }

  /** Includes other, individually enqueued warehouse requests as well. */
  getReservedMap(){return new Map(Object.entries(this._bookCall('bookReserved')));}
  getReservedQty(skuId) { return this.getReservedMap().get(skuId) || 0; }

  _nextId() {
    const used = new Set(this.orders.map(order => order.id));
    for (const request of this._requests()) {
      if (request.customerOrderId) used.add(request.customerOrderId);
    }
    let id;
    do {
      // Imported identifiers may have numeric suffixes beyond JS integer range.
      if (!Number.isSafeInteger(this._sequence) || this._sequence < 1) this._sequence = 1;
      id = `ORD-${String(this._sequence++).padStart(4, '0')}`;
    } while (used.has(id));
    return id;
  }

  /** Generate up to count feasible orders. A low-stock catalog may yield fewer. */
  generate(count=20, {combinedRatio=0.6, seed} = {}) {
    const requested = integer(count);
    if (requested > 10000) throw new Error('한 번에 생성할 주문은 10,000건 이하여야 합니다.');
    if (!requested) return [];
    this.update();
    const random = seed === undefined ? this._random : randomGenerator(seed);
    const ratio = Math.max(0, Math.min(1, Number.isFinite(Number(combinedRatio)) ? Number(combinedRatio) : 0.6));
    const reserved = this.getReservedMap();
    const available = new Map(this._catalog()
      .filter(sku => sku.assigned && sku.reachable && sku.operational !== false)
      .map(sku => [sku.id, Math.max(0, integer(sku.qty) - (reserved.get(sku.id) || 0))])
      .filter(([, qty]) => qty > 0));
    let totalAvailable = [...available.values()].reduce((sum, qty) => sum + qty, 0);
    const ensureBoth = ratio > 0 && ratio < 1 && requested >= 2 && available.size >= 2 && totalAvailable >= 3;
    const created = [];

    for (let index=0; index<requested && totalAvailable>0; index++) {
      const candidates = [...available.keys()];
      let combined = ensureBoth && index === 0 ? true
        : ensureBoth && index === 1 ? false : random() < ratio;
      if (candidates.length < 2) combined = false;
      const reserveAfter = ensureBoth && index === 0 ? 1 : 0;
      const maxLines = Math.min(5, candidates.length, totalAvailable - reserveAfter);
      if (maxLines < 2) combined = false;
      const lineCount = combined ? 2 + Math.floor(random() * (maxLines - 1)) : 1;
      const selected = [];
      // Only shuffle the prefix that this order uses (at most five SKUs).
      for (let position=0; position<lineCount; position++) {
        const chosen = position + Math.floor(random() * (candidates.length - position));
        [candidates[position], candidates[chosen]] = [candidates[chosen], candidates[position]];
        selected.push(candidates[position]);
      }
      const id = this._nextId();
      const lines = selected.map((skuId, position) => {
        const stillNeeded = lineCount - position - 1 + reserveAfter;
        const maximum = Math.min(3, available.get(skuId), totalAvailable - stillNeeded);
        const qty = 1 + Math.floor(random() * maximum);
        const remaining = available.get(skuId) - qty;
        if (remaining) available.set(skuId, remaining); else available.delete(skuId);
        totalAvailable -= qty;
        const line = newLine(`${id}-L${position+1}`, skuId, qty);
        line.binId = this._sku(skuId)?.binId || null;
        return line;
      });
      const kind = combined ? 'combined' : 'single';
      const label = `${combined ? '합포장' : '단품'} 주문 ${id.slice(4)}`;
      const order = newOrder({id, kind, label, createdAt:this._now(), lines});
      this.orders.push(order);
      created.push(order);
    }
    this._bookCall('bookAdd',{orders:created});
    return created.map(o=>this.orders.find(v=>v.id===o.id));
  }

  _preflight(order){return this._bookCall('bookPrepare',{orderId:order.id})?[]:[order.reason];}
  submit(orderId){
    if(!this._bookCall('bookPrepare',{orderId}))return this.orders.find(o=>o.id===orderId);
    const order=this.orders.find(o=>o.id===orderId);
    for(const line of order.lines){
      let request=null,error='';
      try{request=this.sim.enqueueSku(line.skuId,line.qty,{customerOrderId:order.id,lineId:line.id});if(!request?.id)error='창고 출고 요청이 생성되지 않았습니다.';}
      catch(e){error=e?.message||'창고 출고 요청을 처리하지 못했습니다.';}
      if(this._bookCall('bookReceipt',{orderId,lineId:line.id,request,error}))break;
    }
    this.update();return order;
  }
  submitAll() {
    const pending = this.orders.filter(order => order.status === 'draft');
    return pending.map(order => this.submit(order.id));
  }

  prioritize(orderId) {
    this.submit(orderId);
    const order=this.orders.find(o=>o.id===orderId);
    if(order?.status==='blocked')throw new Error(order.reason||'주문의 출고 조건을 확인하세요.');
    this._bookCall('bookPrioritize',{orderId});
    this.update();return order;
  }

  update(){this._bookCall('bookUpdate');return this.orders;}
  _assertIdle(){this._bookCall('bookIdle');}
  resetExecution(){this._bookCall('bookReset');return this.orders;}
  clear(){return this._bookCall('bookClear');}
  getStats(){return this._bookCall('bookStats');}
  exportDefinitions() {
    return {version:1, type:'evio-customer-orders', orders:this.orders.map(order => ({
      id:order.id, kind:order.kind, label:order.label, createdAt:order.createdAt,
      lines:order.lines.map(({id, skuId, qty}) => ({id, skuId, qty}))
    }))};
  }

  /** Execution fields are intentionally ignored. Valid but unavailable SKUs are
   * retained as drafts and will be diagnosed by submit()'s complete preflight.
   */
  importDefinitions(payload, {replace=true} = {}) {
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { throw new Error('고객 주문 JSON 형식이 올바르지 않습니다.'); }
    }
    if (!payload || payload.version !== 1 || payload.type !== 'evio-customer-orders' || !Array.isArray(payload.orders)) {
      throw new Error('지원하지 않는 고객 주문 정의 형식입니다.');
    }
    if (payload.orders.length > 10000) throw new Error('고객 주문 정의는 10,000건 이하여야 합니다.');
    if (replace) this._assertIdle();
    const orderIds = new Set(replace ? [] : this.orders.map(order => order.id));
    const lineIds = new Set(replace ? [] : this.orders.flatMap(order => order.lines.map(line => line.id)));
    const restored = payload.orders.map(definition => {
      if (!definition || !idIsValid(definition.id) || orderIds.has(definition.id)) throw new Error('주문 번호가 없거나 중복되었습니다.');
      orderIds.add(definition.id);
      if (!['single','combined'].includes(definition.kind) || !Array.isArray(definition.lines) ||
          (definition.kind === 'single' && definition.lines.length !== 1) ||
          (definition.kind === 'combined' && (definition.lines.length < 2 || definition.lines.length > 5))) {
        throw new Error('단품 주문은 1개, 합포장 주문은 2~5개의 서로 다른 SKU가 필요합니다.');
      }
      const skuIds = new Set();
      const lines = definition.lines.map((line, index) => {
        const lineId = line?.id ?? `${definition.id}-L${index+1}`;
        if (!line || !idIsValid(lineId) || lineIds.has(lineId) || !idIsValid(line.skuId) || skuIds.has(line.skuId) ||
            !Number.isSafeInteger(line.qty) || line.qty < 1 || line.qty > 1000000) {
          throw new Error('주문 구성품의 번호·SKU·수량이 올바르지 않거나 중복되었습니다.');
        }
        lineIds.add(lineId); skuIds.add(line.skuId);
        const restoredLine = newLine(lineId, line.skuId, line.qty);
        restoredLine.binId = this._sku(line.skuId)?.binId || null;
        return restoredLine;
      });
      const label = typeof definition.label === 'string' && definition.label.trim()
        ? definition.label.slice(0,160) : `${definition.kind === 'combined' ? '합포장' : '단품'} 주문 ${definition.id.slice(4)}`;
      return newOrder({id:definition.id, kind:definition.kind, label,
        createdAt:Number.isFinite(definition.createdAt) ? Math.max(0, definition.createdAt) : this._now(), lines});
    });
    // All definitions have been validated before replacing any existing orders.
    this._bookCall('bookReplace',{orders:restored,replace});
    for (const order of this.orders) {
      const sequence = /^ORD-(\d+)$/.exec(order.id);
      if (sequence) this._sequence = Math.max(this._sequence, Number(sequence[1]) + 1);
    }
    return restored.map(o=>this.orders.find(v=>v.id===o.id));
  }
}
