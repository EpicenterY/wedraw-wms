const PORT_STATUS = {
  reserved:'빈 도착 대기', waiting:'포트 대기', buffered:'버퍼 대기',
  'transfer-in':'버퍼로 이송 중', picking:'철물 피킹 중', picked:'피킹 완료',
  'transfer-out':'회수 위치로 이송 중', outbound:'로봇 회수 대기',
  awaitingReturn:'로봇 회수 대기', returnReady:'로봇 회수 대기',
};

/** A read-only selection of one SKU's physical bin, independent of camera or orders. */
export class InventoryFocus {
  constructor(sim) { this.sim=sim; this.skuId=null; this.binId=null; this.skuName=''; }

  select(skuId) {
    const sku=this.sim.skuMap.get(skuId),bin=sku?.binId&&this.sim.bins.get(sku.binId);
    if(!sku)throw new Error('추적할 SKU를 찾을 수 없습니다.');
    if(!sku.assigned||!bin)throw new Error('아직 빈에 배정되지 않은 SKU입니다.');
    this.skuId=sku.id;this.binId=bin.id;this.skuName=sku.name;
    return this.snapshot();
  }

  clear() { this.skuId=null;this.binId=null;this.skuName=''; }

  snapshot() {
    if(!this.skuId)return null;
    const sku=this.sim.skuMap.get(this.skuId),bin=this.sim.bins.get(this.binId),loc=bin?.location;
    const result={skuId:this.skuId,binId:this.binId,skuName:sku?.name||this.skuName,
      compartment:sku?.compartment??null,qty:sku?.qty??0,locationType:'missing',
      locationLabel:'현재 위치를 확인할 수 없습니다.',statusLabel:'추적 대상 없음',
      cell:null,robotId:null,portId:null,available:false};
    // Keep the originally chosen physical ID; never silently switch to another
    // bin after deletion, reassignment, or a layout rebuild.
    if(!sku){result.locationLabel='선택한 SKU가 삭제되었습니다.';return result;}
    if(!sku.assigned||sku.binId!==this.binId){result.locationLabel='SKU의 빈 배정이 변경되었습니다.';return result;}
    if(!loc)return result;
    if(loc.type==='grid'){
      const [keyX,keyZ]=String(loc.key||'').split(',').map(Number);
      const x=Number.isFinite(loc.x)?loc.x:keyX,z=Number.isFinite(loc.z)?loc.z:keyZ;
      if(!Number.isFinite(x)||!Number.isFinite(z)||!Number.isInteger(loc.level))return result;
      result.cell={x,z,level:loc.level+1};
      result.locationLabel=`셀 (${x+1}, ${z+1}) · ${loc.level+1}층`;
      result.statusLabel='그리드 적재';
    }else if(loc.type==='robot'){
      const robot=this.sim.robots.find(value=>value.id===loc.robotId);
      if(!robot||robot.carryingBinId!==this.binId)return result;
      result.robotId=robot.id;
      const number=/^R\d+$/.test(robot.id)?robot.id.slice(1).padStart(3,'0'):robot.id;
      result.locationLabel=`로봇 ${number} · 인양·운반 중`;
      result.statusLabel=robot.status||'로봇 운반 중';
    }else if(loc.type==='port'){
      const port=this.sim.ports.find(value=>value.id===loc.portId);
      const entry=port?.entries.find(value=>value.binId===this.binId);
      if(!port||!entry)return result;
      result.portId=port.id;
      result.locationLabel=`${port.id} 포트`;
      result.statusLabel=PORT_STATUS[entry.status]||'포트 내부 이송';
    }else return result;
    result.locationType=loc.type;result.available=true;
    return result;
  }
}
