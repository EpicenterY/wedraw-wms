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
  }

  _now() { return Math.max(0, Number(this.sim.time) || 0); }
  _requests() { return Array.isArray(this.sim.orders) ? this.sim.orders : (this.sim.requests || []); }
  _catalog() { return this.sim.catalog || [...(this.sim.skuMap?.values() || [])]; }
  _sku(id) { return this.sim.skuMap?.get(id) || this._catalog().find(sku => sku.id === id); }

  /** Includes other, individually enqueued warehouse requests as well. */
  getReservedMap() {
    const result = new Map();
    const add = (skuId, qty) => { if (qty > 0) result.set(skuId, (result.get(skuId) || 0) + qty); };
    const seen = new Set();
    for (const request of this._requests()) {
      if (!ACTIVE_REQUESTS.has(request.status)) continue;
      const identity = request.id ?? request;
      if (seen.has(identity)) continue;
      seen.add(identity);
      add(request.skuId, Math.max(0, integer(request.qty) - integer(request.pickedQty)));
    }
    for (const order of this.orders) {
      if (order.status !== 'draft') continue;
      for (const line of order.lines) if (!line.requestId) add(line.skuId, line.qty);
    }
    return result;
  }

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
    return created;
  }

  _preflight(order) {
    const reserved = this.getReservedMap();
    // A draft already reserved its own units. Exclude those for its submission.
    if (order.status === 'draft') {
      for (const line of order.lines) {
        if (!line.requestId) reserved.set(line.skuId, (reserved.get(line.skuId) || 0) - line.qty);
      }
    }
    const reasons = [];
    for (const line of order.lines) {
      const sku = this._sku(line.skuId);
      let reason = '';
      if (!sku) reason = '존재하지 않는 SKU';
      else if (!sku.assigned) reason = '빈 미배정';
      else if (!sku.reachable) reason = '로봇과 포트의 출고 경로 없음';
      else if (sku.operational === false) reason = '포트 설치 조건 미충족';
      else {
        const free = Math.max(0, integer(sku.qty) - (reserved.get(line.skuId) || 0));
        if (free < line.qty) reason = `가용 재고 부족: 요청 ${line.qty}개, 가용 ${free}개`;
      }
      line.reason = reason;
      line.status = reason ? 'blocked' : 'draft';
      if (reason) reasons.push(`${line.skuId} · ${reason}`);
    }
    return reasons;
  }

  /** Idempotent for every order that has already submitted a warehouse request. */
  submit(orderId) {
    const order = this.orders.find(value => value.id === orderId);
    if (!order) throw new Error('출고할 고객 주문을 찾을 수 없습니다.');
    this.update();
    if (order.submittedAt !== null || order.lines.some(line => line.requestId) || order.status === 'shipped') return order;
    const reasons = this._preflight(order);
    if (reasons.length) {
      order.status = 'blocked';
      order.reason = reasons.join(' / ');
      return order;
    }
    order.submittedAt = this._now();
    order.status = 'queued';
    order.reason = '';
    let stopped = false;
    for (const line of order.lines) {
      if (stopped) {
        line.status = 'blocked';
        line.reason = '다른 구성품 접수 실패로 이 구성품의 접수를 중단했습니다.';
        continue;
      }
      try {
        const request = this.sim.enqueueSku(line.skuId, line.qty, {customerOrderId:order.id, lineId:line.id});
        if (!request || !request.id) throw new Error('창고 출고 요청이 생성되지 않았습니다.');
        line.requestId = request.id;
        line.requestStatus = request.status;
        line.binId = request.binId ?? this._sku(line.skuId)?.binId ?? null;
        line.status = request.status === 'blocked' ? 'blocked' : 'queued';
        line.reason = request.reason || '';
        if (request.status === 'blocked') stopped = true;
      } catch (error) {
        line.status = 'blocked';
        line.reason = error?.message || '창고 출고 요청을 처리하지 못했습니다.';
        stopped = true;
      }
    }
    this.update();
    return order;
  }

  submitAll() {
    const pending = this.orders.filter(order => order.status === 'draft');
    return pending.map(order => this.submit(order.id));
  }

  update() {
    const requests = new Map(this._requests().map(request => [request.id, request]));
    const now = this._now();
    for (const order of this.orders) {
      if (order.submittedAt === null && !order.lines.some(line => line.requestId)) {
        const missing = order.lines.filter(line => !this._sku(line.skuId));
        if (missing.length) {
          for (const line of missing) { line.status = 'blocked'; line.reason = '삭제되었거나 존재하지 않는 SKU'; }
          order.status = 'blocked';
          order.reason = missing.map(line => `${line.skuId} · ${line.reason}`).join(' / ');
        }
        continue;
      }
      for (const line of order.lines) {
        const request = requests.get(line.requestId);
        if (!request) {
          // A failed submission has no request; keep that specific failure reason.
          if (line.status !== 'blocked') {
            line.status = 'blocked';
            line.reason = '연결된 창고 작업이 없습니다. 실행을 초기화한 뒤 다시 접수하세요.';
          }
          continue;
        }
        line.requestStatus = request.status;
        line.pickedQty = Math.min(line.qty, integer(request.pickedQty));
        line.binId = request.binId ?? line.binId;
        line.portId = request.portId ?? line.portId;
        line.robotIds = unique([...(request.robotIds || []), request.robotId]);
        if (line.pickedQty >= line.qty) {
          line.status = 'picked';
          line.pickedAt = line.pickedAt ?? request.pickedAt ?? now;
          line.reason = '';
        } else if (request.status === 'blocked') {
          line.status = 'blocked';
          line.reason = request.reason || '창고 작업이 보류되었습니다.';
        } else if (request.status === 'complete') {
          line.status = 'blocked';
          line.reason = '작업 종료 후에도 요청 수량의 실제 피킹이 확인되지 않았습니다.';
        } else {
          line.status = request.status === 'inProgress' || line.pickedQty > 0 ? 'picking' : 'queued';
          line.reason = '';
        }
      }
      order.robotIds = unique(order.lines.flatMap(line => line.robotIds));
      order.portIds = unique(order.lines.map(line => line.portId));
      order.pickedQty = order.lines.reduce((sum, line) => sum + line.pickedQty, 0);
      order.totalQty = order.lines.reduce((sum, line) => sum + line.qty, 0);
      order.remainingQty = Math.max(0, order.totalQty - order.pickedQty);
      order.pendingBinReturns = order.lines.some(line => ACTIVE_REQUESTS.has(requests.get(line.requestId)?.status));
      const allPicked = order.lines.every(line => line.pickedQty >= line.qty);
      if (allPicked) {
        order.status = 'shipped';
        order.shippedAt = order.shippedAt ?? now;
        order.packageCount = 1;
        order.reason = '';
      } else if (order.lines.some(line => line.status === 'blocked')) {
        order.status = 'blocked';
        order.packageCount = 0;
        order.reason = unique(order.lines.filter(line => line.reason).map(line => `${line.skuId} · ${line.reason}`)).join(' / ');
      } else if (order.kind === 'combined' && order.pickedQty > 0) {
        order.status = 'consolidating';
        order.reason = '모든 구성품이 모이면 한 포장으로 출고합니다.';
      } else if (order.lines.some(line => line.status === 'picking')) {
        order.status = 'picking';
        order.reason = '';
      } else {
        order.status = 'queued';
        order.reason = '';
      }
    }
    return this.orders;
  }

  _assertIdle() {
    if (this._requests().some(request => ACTIVE_REQUESTS.has(request.status)) ||
        this.sim.robots?.some(robot => robot.job)) {
      throw new Error('진행 중이거나 빈이 미반납된 작업이 있습니다. 작업을 완료하거나 시뮬레이션을 초기화하세요.');
    }
  }

  /** Reset execution fields after the engine itself has been reset. */
  resetExecution() {
    this._assertIdle();
    this.orders = this.orders.map(order => newOrder({...order,
      lines:order.lines.map(line => {
        const restored = newLine(line.id, line.skuId, line.qty);
        restored.binId = this._sku(line.skuId)?.binId || null;
        return restored;
      })}));
    return this.orders;
  }

  clear() {
    this._assertIdle();
    this.orders = [];
    return true;
  }

  getStats() {
    const result = {totalOrders:this.orders.length, draftOrders:0, activeOrders:0,
      queuedOrders:0, pickingOrders:0, consolidatingOrders:0, shippedOrders:0,
      blockedOrders:0, singleOrders:0, combinedOrders:0, totalUnits:0, pickedUnits:0, packages:0};
    for (const order of this.orders) {
      if (ACTIVE_ORDERS.has(order.status)) result.activeOrders++;
      const statusKey = `${order.status}Orders`;
      if (Object.hasOwn(result, statusKey)) result[statusKey]++;
      result[`${order.kind}Orders`]++;
      result.totalUnits += order.lines.reduce((sum, line) => sum + line.qty, 0);
      result.pickedUnits += order.lines.reduce((sum, line) => sum + line.pickedQty, 0);
      result.packages += order.packageCount;
    }
    return result;
  }

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
    this.orders = replace ? restored : [...this.orders, ...restored];
    for (const order of this.orders) {
      const sequence = /^ORD-(\d+)$/.exec(order.id);
      if (sequence) this._sequence = Math.max(this._sequence, Number(sequence[1]) + 1);
    }
    return restored;
  }
}
