import {SimulationClock} from './simulation-clock.js';
const simulationClock=new SimulationClock();
import {STRATEGY_KEYS,normalizeStrategies} from './robot-strategies.js';
import {floorDimensions,floorFromArea,areaInUnit,configureFloor} from './floor-plan.js';
import {AutoStoreSim,createDefaultConfig,normalizeConfig,MAX_SKUS,MAX_ROBOTS} from './engine.js';
import {createScene} from './scene.js';
import {OrderBook} from './orders.js';
import {OrderFocus} from './order-focus.js';
import {InventoryFocus} from './inventory-focus.js';
import {getOperationGroups} from './operations.js';
import {renderOperationList} from './operations-list-view.js';
import {getDiggingContext} from './digging-focus.js';
import {createCelebration} from './celebration.js';
import {getBinColor} from './bin-colors.js';
import {LayoutEditor,paintCells,resizeLayout,makePortCandidate,compareLayouts} from './layout-editor.js';
import {mountEditorWorkspace} from './editor-workspace.js';

const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=v=>Math.round(Number(v)||0).toLocaleString('ko-KR');
const robotNumber=id=>/^R\d+$/.test(String(id))?String(id).slice(1).padStart(3,'0'):String(id||'—');
const key=(x,z)=>`${x},${z}`;
const storageKey='wedraw-wms-layout-v1',legacyStorageKey='evio-gridlab-layout-v1';
const markupCache=new WeakMap(),dismissedNotices=new Map();
function noticeHidden(id,message){if(dismissedNotices.get(id)!==message)dismissedNotices.delete(id);return !message||dismissedNotices.has(id);}
let pointerTarget=null;
let listInteractionUntil=0,listTouchActive=false,listOrderId=null;
function setHTML(selector,markup,force=false){
  const el=typeof selector==='string'?$(selector):selector;if(!el)return;
  if(!force&&pointerTarget?.isConnected&&el.contains(pointerTarget))return;
  const list=el.id==='customer-order-body'||el.id==='sku-table-body';
  // Native panning cancels pointer events before momentum scrolling ends.
  // Keep row nodes alive for the complete touch/scroll interaction.
  if(!force&&list&&(listTouchActive||Date.now()<listInteractionUntil))return;
  if(force||markupCache.get(el)!==markup){
    const active=list&&el.contains(document.activeElement)?document.activeElement:null;
    const identity=active&&[...active.attributes].find(a=>a.name==='id'||a.name.startsWith('data-'));
    const scrolls=list?[el.closest('.table-scroll'),el.closest('.panel-content')].filter(Boolean).map(node=>({node,top:node.scrollTop,left:node.scrollLeft})):[];
    el.innerHTML=markup;markupCache.set(el,markup);
    if(identity)el.querySelector(`[${identity.name}="${CSS.escape(identity.value)}"]`)?.focus({preventScroll:true});
    for(const {node,top,left} of scrolls){if(node.scrollTop!==top)node.scrollTop=top;if(node.scrollLeft!==left)node.scrollLeft=left;}
  }
}
function setText(selector,value){const el=$(selector);if(el&&el.textContent!==value)el.textContent=value;}
const categories=['경첩','피스','연결철물','브래킷','손잡이','서랍레일','선반받침','다리·레벨러','댐퍼·래치','캡·마감재'];
const toolNames={select:'↖ 선택',add:'＋ 셀 추가',erase:'− 셀 삭제',port:'⇄ 포트 배치',orbit:'⟳ 화면 회전'};
const hints={select:'클릭하여 선택 · 선택한 포트는 드래그하여 이동',add:'드래그로 추가 영역 미리보기 · 놓으면 초안에 반영',erase:'드래그로 삭제 영역과 영향 확인 · 놓으면 초안에 반영',port:'스테이션 전체를 확인하고 클릭하여 배치 · 기존 포트는 선택',orbit:'왼쪽 드래그로 회전 · 휠로 확대·축소'};
const touchLayout=matchMedia('(max-width:1024px), (pointer:coarse)');
function updateInputHints(){
  setText('#canvas-tool',editMode?toolNames[tool]:touchLayout.matches?'한 손가락 회전':'왼쪽 드래그로 회전');
  setText('#canvas-zoom-hint',touchLayout.matches?'두 손가락 이동·확대':'휠로 확대');
  if(editMode)renderEditor();
}
touchLayout.addEventListener('change',updateInputHints);
let strategyPreferences={completionTime:true,portPacing:true,timeReservations:true};
let orderPrefetch=true,pickingSeconds=3;
let config=createDefaultConfig(), saveAvailable=true,savedOrderDefinitions=null,idleOptimizationEnabled=true,demandBinCount=0;
try {const saved=JSON.parse(localStorage.getItem(storageKey)||localStorage.getItem(legacyStorageKey)||'null');if(saved?.version===1){config=validateConfig(saved.config);orderPrefetch=(saved.preferences?.orderPrefetch??saved.config.orderPrefetch)!==false;const savedPicking=Number(saved.preferences?.pickingSeconds??saved.config.pickingSeconds);if(Number.isFinite(savedPicking)&&savedPicking>=.5&&savedPicking<=60)pickingSeconds=savedPicking;savedOrderDefinitions=saved.customerOrders||null;idleOptimizationEnabled=saved.preferences?.idleOptimization!==false;if(saved.preferences?.robotStrategies||saved.config?.strategies)strategyPreferences=normalizeStrategies(saved.preferences?.robotStrategies||saved.config.strategies);}}catch{}
const sim=new AutoStoreSim({...config,strategies:strategyPreferences,orderPrefetch,pickingSeconds});config=sim.config;
const book=new OrderBook(sim);
const orderFocus=new OrderFocus(sim,book);
const inventoryFocus=new InventoryFocus(sim);
const celebration=createCelebration($('#celebration-canvas'));
let highlightSignature='',celebrationTimer=null;
let floorUnit='sqm',pendingFloor=floorDimensions(config);
try{if(savedOrderDefinitions)book.importDefinitions(savedOrderDefinitions);}catch{}
let scenePresentationBlocked=false;
let scene=null,tool='orbit',selected=null,selectedRobotId=null,tab='design',editMode=false,panelReturnFocus=null,page=1,rows=[],lastRowRevision=-1,lastUIPaint=0,lastFrame=0,lastScenePaint=0,toastTimer,wasRunning=false;
let sceneCells=[],sceneCellRevision=-1,sceneCellSource=null,followMode='none',autoFollowRobotId=null,sceneFollowId=null,lastMotionPaint=0,latestVisuals=[],latestPorts=[],portFollowId=null,orderPage=1;
const expandedOrders=new Set();
let editor=null,editPreview=null,editBrush='brush',editView='iso',selectedPortId=null,movingPortId=null,editResumeState=null;
let editorHoverKey='',lastPreviewSignature='',pendingSkuDeletion=[];
const inventorySelection=new Set();
const inventorySearchIndex=new WeakMap();
let lastRowSource=null,lastRowFilter='',traceSceneId=null;
let operationFocusKey=null,operationTraceSignature='',operationTraceBinIds=[],diggingTraceSignature='';
const viewSim=()=>editMode&&editor?editor.analysis.sim:sim;

function validateConfig(c){
  if(!c||typeof c!=='object'||!Array.isArray(c.activeCells)||!Array.isArray(c.ports))throw Error('설계 파일의 형식이 올바르지 않습니다.');
  if(c.ports.length>8)throw Error('지원하는 설계 크기를 초과했습니다.');
  if(c.ports.some(p=>!p||typeof p!=='object'))throw Error('포트 정보가 올바르지 않습니다.');
  return normalizeConfig({...c,ports:c.ports.map((p,i)=>({...p,type:p.type||(i===0?'buffer3':'single')})),width:c.width,depth:c.depth});
}
function toast(message,action=null){clearTimeout(toastTimer);const el=$('#toast');el.textContent=message;if(action){const button=document.createElement('button');button.className='toast-action';button.textContent='실행 취소';button.addEventListener('click',()=>{action();el.hidden=true;});el.appendChild(button);}el.hidden=false;toastTimer=setTimeout(()=>el.hidden=true,action?6500:3400);}
function syncDemandWeights(){
  const weights=new Map();
  for(const order of book.orders){
    const bins=new Set(order.lines.map(line=>sim.skuMap.get(line.skuId)?.binId).filter(id=>id&&sim.bins.has(id)));
    for(const binId of bins)weights.set(binId,(weights.get(binId)||0)+1);
  }
  demandBinCount=weights.size;
  sim.setDemandWeights?.([...weights].map(([binId,orderCount])=>({binId,orderCount})),{sampleSize:book.orders.length});
  sim.enableIdleOptimization?.(idleOptimizationEnabled);
}
function persist(){sim.setStrategies(strategyPreferences);sim.setOrderPrefetch(orderPrefetch);if(sim.config.pickingSeconds!==pickingSeconds)sim.setPickingSeconds(pickingSeconds);syncDemandWeights();try{localStorage.setItem(storageKey,JSON.stringify({version:1,config:sim.config,customerOrders:book.exportDefinitions(),preferences:{idleOptimization:idleOptimizationEnabled,robotStrategies:strategyPreferences,orderPrefetch,pickingSeconds}}));}catch{saveAvailable=false;$('#save-status').textContent='브라우저 저장 불가';}}
function clock(t){const v=Math.floor(t||0),h=Math.floor(v/3600),m=Math.floor(v%3600/60),s=v%60;return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;}
function changeConfig(next){
  if(!editMode||!editor){toast('편집 메뉴를 열어 그리드를 수정하세요.');return false;}
  clearEditPreview();
  if(!editor.replace(next))return false;
  syncDraft();return true;
}
function syncDraft(){
  config=editor.config;
  if(selected&&(selected.x>=config.width||selected.z>=config.depth))selected=null;
  if(selectedPortId&&!config.ports.some(p=>p.id===selectedPortId))selectedPortId=movingPortId=null;
  scene?.setSelected(selected);syncControls();refresh(true);refreshScene();
}
function syncControls(){
  const warehouse=viewSim();
  $('#grid-width').value=config.width;$('#grid-depth').value=config.depth;
  pendingFloor=floorDimensions(config);renderFloorInputs();
  $('#height-range').min=config.binHeightM;$('#height-number').min=config.binHeightM;
  $('#height-range').value=config.maxHeightM;$('#height-number').value=config.maxHeightM;
  $('#height-min').textContent=`1층 · ${config.binHeightM.toFixed(config.binHeightM===.425?3:2)}m`;
  $('#bin-height').value=config.binHeightM;$('#compartments').value=config.compartments;
  for(const option of $('#compartments').options)option.disabled=config.binHeightM===.425&&Number(option.value)>8;
  $('#robot-count').value=config.robotCount;$('#robot-count').max=MAX_ROBOTS;$('#robots-minus').disabled=config.robotCount<=1;$('#robots-plus').disabled=config.robotCount>=MAX_ROBOTS;
  const robotStats=warehouse.getStats();
  setText('#robot-capacity-note',robotStats.unplacedRobotCount?`요청 ${config.robotCount}대 중 ${robotStats.placedRobotCount}대 배치 가능 · ${robotStats.unplacedRobotCount}대는 2셀 주행 공간 부족으로 미배치됩니다.`:`최대 ${MAX_ROBOTS}대 · 현재 설계에 ${robotStats.placedRobotCount}대 배치 가능`);
  $('#cooperative-digging').checked=config.cooperativeDigging!==false;
  $('#order-prefetch').checked=orderPrefetch;$('#picking-seconds').value=pickingSeconds;
  $$('[data-picking-seconds]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.pickingSeconds)===pickingSeconds)));
  if($('#idle-optimization'))$('#idle-optimization').checked=idleOptimizationEnabled;
  for(const k of STRATEGY_KEYS)if(document.querySelector('[data-robot-strategy='+k+']'))document.querySelector('[data-robot-strategy='+k+']').checked=strategyPreferences[k];
  $('#catalog-target').value=sim.catalog.length;$('#catalog-target').min=0;$('#catalog-target').max=MAX_SKUS;
  $('#nav-sku-count').textContent=n(config.skuCount);$('#sidebar-sku-count').textContent=`${n(config.skuCount)} SKU · 10개 분류`;
  setHTML('#follow-robot','<option value="none">전체 그리드</option><option value="auto">작업 로봇 자동</option>'+sim.robots.map(r=>`<option value="${e(r.id)}">로봇 ${e(robotNumber(r.id))} 따라보기</option>`).join(''));
  if(!['none','auto',...sim.robots.map(r=>r.id)].includes(followMode))followMode='none';
  $('#follow-robot').value=followMode;autoFollowRobotId=null;
  $('#grid-size-label').textContent=`${config.width} × ${config.depth}`;
  $('#footprint').textContent=`전체 외곽 ${(config.width*.705).toFixed(2)} × ${(config.depth*.480).toFixed(2)}m · 셀 간격 기준`;
  $('#layer-count').textContent=`${warehouse.levels}층`;
  $('#actual-height').textContent=`실제 적층 ${warehouse.actualHeightM.toFixed(2)}m · 상부 공간 별도`;
  $('#port-count').textContent=config.ports.length;
  setHTML('#port-list',config.ports.length?config.ports.map(p=>`<div class="port-config-row"><button class="port-locate" data-port-locate="${e(p.id)}">${e(p.id)} <small>${p.x+1}, ${p.z+1}</small></button><select data-port-type="${e(p.id)}" aria-label="${e(p.id)} 포트 종류"><option value="single" ${p.type!=='buffer3'?'selected':''}>일반 · 1빈</option><option value="buffer3" ${p.type==='buffer3'?'selected':''}>버퍼 · 3빈</option></select><button data-port-remove="${e(p.id)}" aria-label="${e(p.id)} 포트 삭제">×</button></div>`).join(''):'<p class="field-note">그리드에서 포트 위치를 선택하세요.</p>',true);
  $$('.preset').forEach(x=>x.classList.remove('active'));
  if(config.activeCells.length===config.width*config.depth)$('[data-preset="rectangle"]').classList.add('active');
}
function setTool(next){
  if(['add','erase','port','select'].includes(next)&&!editMode)next='orbit';
  if(tool!==next){scene?.cancelEditGesture?.();clearEditPreview();if(next!=='port')movingPortId=null;}
  tool=next;if(['add','erase','port'].includes(next))setFollow('none');scene?.setTool(tool);
  $$('[data-tool]').forEach(b=>{const active=b.dataset.tool===tool;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});$('#tool-hint').textContent=hints[tool];updateInputHints();
  renderEditor();
}
function setEditMode(enabled){
  const next=!!enabled;if(next===editMode)return true;
  if(!next)return requestExitEditing();
  clearInventoryTrace();
  editResumeState={running:sim.running,paused:sim.paused};sim.pause();
  editor=new LayoutEditor(sim.config);config=editor.config;editMode=true;selectedPortId=movingPortId=null;editView='top';editBrush='rectangle';
  dismissCelebration();clearEditPreview();
  document.body.classList.toggle('editing',editMode);$('#edit-menu-button')?.setAttribute('aria-pressed',String(editMode));
  if($('#edit-mode-indicator'))$('#edit-mode-indicator').hidden=!editMode;
  if($('#edit-toolsbar'))$('#edit-toolsbar').hidden=!editMode;
  scene?.setOptions({editing:true,highlightBinIds:[]});scene?.setEditOptions?.({brush:editBrush,selectedPortId:null,movingPortId:null,topView:true});
  setFollow('none');setTool('select');syncControls();refresh(true);refreshScene();scene?.setView('fit');scene?.setView('top');return true;
}
function finishEditing(restoreRuntime){
  scene?.cancelEditGesture?.();clearEditPreview();editor=null;editMode=false;config=sim.config;selectedPortId=movingPortId=null;
  document.body.classList.remove('editing');$('#edit-menu-button').setAttribute('aria-pressed','false');
  $('#edit-mode-indicator').hidden=true;$('#edit-toolsbar').hidden=true;
  scene?.setOptions({editing:false});scene?.setEditOptions?.({selectedPortId:null,movingPortId:null,topView:false});
  if(editView==='top')scene?.setView('iso');editView='iso';
  if(restoreRuntime&&editResumeState){sim.running=editResumeState.running;sim.paused=editResumeState.paused;}
  editResumeState=null;setTool('orbit');closePanel();syncControls();refresh(true);refreshScene();
}
function requestExitEditing(){
  if(!editMode)return true;
  scene?.cancelEditGesture?.();editor?.endGroup();clearEditPreview();
  if(editor?.dirty){openApplyEdit();return false;}
  finishEditing(true);toast('편집을 종료했습니다. 기존 운영 상태로 돌아왔습니다.');return true;
}
function cancelEditing(){
  if(!editMode)return;const changed=editor?.dirty;
  $('#edit-apply-dialog')?.close();finishEditing(true);
  toast(changed?'편집 초안을 취소했습니다. 기존 재고와 실행 상태를 유지합니다.':'기존 운영 화면으로 돌아왔습니다.');
}
function openApplyEdit(){
  if(!editor)return;editor.endGroup();clearEditPreview();
  if(!editor.dirty){finishEditing(true);return;}
  const a=editor.baseline.stats,b=editor.analysis.stats;
  setHTML('#edit-apply-summary',`<dl><div><dt>최대 수용 SKU</dt><dd>${n(a.capacitySkus)} → <strong>${n(b.capacitySkus)}</strong></dd></div><div><dt>저장 가능한 빈</dt><dd>${n(a.usableBinCapacity)} → ${n(b.usableBinCapacity)}</dd></div><div><dt>그리드 셀 / 포트</dt><dd>${a.cellCount} / ${a.portCount} → ${b.cellCount} / ${b.portCount}</dd></div></dl>`);
  const issues=editor.analysis.warnings;
  $('#edit-apply-warning').textContent=[issues.slice(0,3).join(' '),'적용하면 재고와 시뮬레이션 실행 기록이 초기화되고, 기존 주문목록은 대기 상태로 돌아갑니다.'].filter(Boolean).join('\n');
  $('#edit-apply-confirm').textContent=b.operational?'변경 적용':'보관 설계 적용';$('#edit-apply-dialog').showModal();
}
function applyEditing(){
  if(!editor)return;const next=editor.config;
  sim.reconfigure(next);config=sim.config;book.resetExecution();orderFocus.reset();highlightSignature='';dismissCelebration();lastRowRevision=-1;wasRunning=false;
  $('#edit-apply-dialog').close();finishEditing(false);persist();
  toast('설계를 적용했습니다. 주문목록은 유지하고 실행을 새로 준비했습니다.');
}
function inspectCell(x,z){
  if(x<0||z<0||x>=config.width||z>=config.depth)return;
  if(!editMode&&!sim.cells.has(key(x,z))){clearSceneSelection();return;}
  if(!editMode){if(selected?.x===x&&selected?.z===z){clearSceneSelection();return;}setFollow('none',{preserveCamera:true});selectedRobotId=null;}
  if(editMode){const p=portAtCell(x,z);if(p){selectEditPort(p.id);return;}}
  selected={x,z};scene?.setSelected(selected);renderSelection();openPanel('inspect');
}
function clearSceneSelection({close=true}={}){
  if(editMode)return;
  selected=null;selectedRobotId=null;scene?.setSelected(null);
  if(close&&tab==='inspect')closePanel();
}
function inspectRobot(id){
  if(editMode)return;
  if(selectedRobotId===id){clearSceneSelection();return;}
  setFollow('none',{preserveCamera:true});selected=null;selectedRobotId=id;
  scene?.setSelectedRobot(id);openPanel('inspect');renderSelection();
}
function portAtCell(x,z){
  if(!editor)return null;
  const k=key(x,z),ports=editor.analysis.sim.getPortVisuals();
  return ports.find(p=>p.x===x&&p.z===z)||ports.find(p=>p.footprintReservedKeys?.includes(k));
}
function clearEditPreview(){
  editPreview=null;editorHoverKey='';lastPreviewSignature='';scene?.setEditPreview?.(null);
  if($('#edit-impact-card'))$('#edit-impact-card').hidden=true;
}
function showEditPreview(analysis,meta={}){
  if(!editor)return;
  const impact=compareLayouts(editor.analysis,analysis);
  editPreview={analysis,impact,...meta};
  scene?.setEditPreview?.({cells:meta.cells||[],mode:meta.mode||tool,port:meta.port||null,status:meta.status||'valid',
    affectedKeys:impact.inaccessibleKeys,affectedPortIds:impact.affectedPortIds,reason:meta.reason||'',capacityDelta:impact.capacityDelta});
  renderEditor();
}
function onEditorHover(x,z){
  $('#hover-coordinate').textContent=x>=0?`X ${x+1} / Y ${z+1}`:'wedraw WMS';
  if(!editMode||!editor||tool!=='port')return;
  const signature=`${x},${z}:${movingPortId||''}:${$('#new-port-type').value}`;
  if(editorHoverKey===signature)return;editorHoverKey=signature;
  if(x<0||z<0){clearEditPreview();renderEditor();return;}
  if(!movingPortId&&portAtCell(x,z)){clearEditPreview();$('#edit-port-instruction').textContent='기존 포트를 클릭하면 선택합니다.';return;}
  const candidate=makePortCandidate(config,{x,z,type:$('#new-port-type').value,portId:movingPortId});
  showEditPreview(candidate.analysis,{...candidate,cells:[candidate.placement],mode:movingPortId?'move-port':'port',title:movingPortId?`${movingPortId} 이동 미리보기`:'포트 배치 미리보기'});
}
function onEditGesture(event){
  if(!editMode||!editor)return;
  const {phase,tool:gestureTool,cells=[],x,z,portId}=event;
  if(phase==='cancel'){clearEditPreview();renderEditor();return;}
  if(gestureTool==='add'||gestureTool==='erase'){
    const next=paintCells(config,cells,gestureTool);
    if(phase==='commit'){changeConfig(next);return;}
    const sig=JSON.stringify([gestureTool,cells]);if(lastPreviewSignature===sig)return;lastPreviewSignature=sig;
    showEditPreview(editor.preview(next),{cells,mode:gestureTool,status:gestureTool==='erase'?'warning':'valid',title:gestureTool==='erase'?'셀 삭제 미리보기':'셀 추가 미리보기'});return;
  }
  if(gestureTool==='port'||gestureTool==='move-port'){
    const moveId=portId||movingPortId;
    if(!moveId){const existing=portAtCell(x,z);if(existing&&phase==='commit'){selectEditPort(existing.id);return;}}
    const candidate=makePortCandidate(config,{x,z,type:$('#new-port-type').value,portId:moveId});
    if(phase==='preview'){showEditPreview(candidate.analysis,{...candidate,cells:[candidate.placement],mode:moveId?'move-port':'port',title:moveId?`${moveId} 이동 미리보기`:'포트 배치 미리보기'});return;}
    if(!candidate.canPlace){toast(candidate.reason);showEditPreview(candidate.analysis,{...candidate,mode:'port',title:'포트 배치 위치 확인'});return;}
    changeConfig(candidate.config);movingPortId=null;
    if(candidate.port){selectedPortId=candidate.port.id;selected={x:candidate.placement.x,z:candidate.placement.z};scene?.setSelected(selected);}
    if(moveId){setTool('select');toast(`${moveId} 위치를 편집 초안에 반영했습니다.`,undo);}
    else toast(`${candidate.port?.id||'포트'}를 초안에 배치했습니다. 다른 위치에 계속 배치할 수 있습니다.`,undo);
    renderEditor();
  }
}
function selectEditPort(id){
  if(!editMode||!editor)return;
  const p=config.ports.find(p=>p.id===id);if(!p)return;
  movingPortId=null;selectedPortId=id;selected={x:p.x,z:p.z};clearEditPreview();setTool('select');scene?.setSelected(selected);if(tab!=='edit')closePanel();renderEditor();
}
function removeEditPort(id=selectedPortId){
  if(!editor||!id)return;
  if(changeConfig({...config,ports:config.ports.filter(p=>p.id!==id)})){selectedPortId=movingPortId=null;renderEditor();toast(`${id} 포트를 편집 초안에서 삭제했습니다.`,undo);}
}
function previewExpansion(axis){
  if(!editor)return;
  if(!axis){clearEditPreview();renderEditor();return;}
  const width=config.width+(axis==='width'?1:0),depth=config.depth+(axis==='depth'?1:0);

  const next=resizeLayout(config,width,depth),analysis=editor.preview(next),diff=compareLayouts(editor.analysis,analysis);
  showEditPreview(analysis,{cells:diff.addedKeys.map(k=>{const[x,z]=k.split(',').map(Number);return{x,z};}),mode:'add',title:axis==='width'?'가로 한 열 확장':'세로 한 행 확장'});
}
function expandGrid(axis){
  if(!editor)return;

  changeConfig(resizeLayout(config,config.width+(axis==='width'?1:0),config.depth+(axis==='depth'?1:0)));
  scene?.setView(editView==='top'?'top':'fit');
}
function renderEditor(){
  for(const id of ['edit-capacity-card','edit-port-inspector'])if($('#'+id))$('#'+id).hidden=!editMode||(id==='edit-port-inspector'&&!selectedPortId);
  if(!editMode||!editor){if($('#edit-impact-card'))$('#edit-impact-card').hidden=true;return;}
  const analysis=editPreview?.analysis||editor.analysis,s=analysis.stats,base=editor.baseline.stats,delta=s.capacitySkus-base.capacitySkus;
  setText('#edit-capacity-max',n(s.capacitySkus));setText('#edit-capacity-current',n(s.skuCount));
  const remaining=s.capacitySkus-s.skuCount;
  setText('#edit-capacity-remaining',n(Math.abs(remaining)));setText('#edit-capacity-remaining-label',remaining<0?'공간 부족':'추가 수용 여유');
  $('#edit-capacity-remaining').classList.toggle('bad',remaining<0);
  setText('#edit-capacity-delta',`${editPreview?'미리보기 · ':editor.dirty?'편집 초안 · ':''}${delta?`${delta>0?'+':'−'}${n(Math.abs(delta))} SKU`:'용량 변경 없음'}`);
  $('#edit-capacity-delta').classList.toggle('positive',delta>0);$('#edit-capacity-delta').classList.toggle('negative',delta<0);
  const warnings=[];if(s.unassignedSkuCount)warnings.push(`미배정 ${n(s.unassignedSkuCount)} SKU`);
  if(!s.portCount)warnings.push('포트 없음 · 출고 불가');else if(s.assignedSkuCount>s.operationalSkuCount)warnings.push(`출고 불가 ${n(s.assignedSkuCount-s.operationalSkuCount)} SKU`);
  if(s.unplacedRobotCount)warnings.push(`로봇 ${s.unplacedRobotCount}대 배치 불가`);
  if(!s.operational&&s.portCount)warnings.push(s.operationalReason);
  $('#edit-capacity-warning').hidden=noticeHidden('edit-capacity-warning',warnings.join(' · '));setText('#edit-capacity-warning',warnings.join(' · '));
  setText('#edit-capacity-detail',`구획당 SKU 1종 기준. 포트 설비 ${n(s.equipmentReservedCellCount)}셀·출고 접근 불가 ${n(s.accessReservedCellCount)}셀을 제외한 저장 셀 ${n(s.storageCellCount)}개 × ${s.levels}층에서 디깅 여유를 확보한 ${n(s.usableBinCapacity)}빈 × ${config.compartments}구획입니다. 현재 출고 가능 ${n(s.operationalSkuCount)} / ${n(s.skuCount)} SKU. 물품 수량과 부피에 따른 실물 수용량은 별도입니다.`);
  $('#edit-undo').disabled=!editor.canUndo;$('#edit-redo').disabled=!editor.canRedo;$('#finish-edit').disabled=!editor.dirty;$('#edit-cancel').disabled=false;
  $('#edit-settings').setAttribute('aria-expanded',String(tab==='edit'));
  $('#edit-settings').classList.toggle('active',tab==='edit');
  setText('#edit-draft-state',editor.dirty?'● 적용하지 않은 변경사항이 있습니다':'✓ 변경 없음 · 바로 종료할 수 있습니다');
  $('#edit-draft-state').dataset.dirty=String(editor.dirty);
  $('#edit-brush-options').hidden=!['add','erase'].includes(tool);$('#edit-port-options').hidden=tool!=='port';
  const touchHints={select:'탭하여 선택 · 선택한 포트는 끌어서 이동',add:'한 손가락으로 셀 배치',erase:'한 손가락으로 셀 삭제',port:'탭하여 포트 배치',orbit:'한 손가락으로 회전'};
  setText('#edit-tool-context',touchLayout.matches?`${touchHints[tool]} · 두 손가락 이동·확대`:`${hints[tool]} · 오른쪽 드래그 회전 · Shift+드래그 이동`);
  setText('#edit-port-instruction',movingPortId?`${movingPortId} 이동 · 위치 선택 · Esc 취소`:'위치 선택 · 초록 배치 가능 · 노랑 설치 조건 확인 · Esc 취소');
  $$('[data-brush]').forEach(button=>{const active=button.dataset.brush===editBrush;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  const nextView=editView==='top'?'입체':'평면';
  setText('#edit-view-switch',nextView);$('#edit-view-switch').setAttribute('aria-label',nextView+' 보기로 전환');$('#edit-view-switch').title=nextView+' 보기로 전환';
  setText('[data-tool="orbit"] .tool-label',editView==='top'?'이동':'회전');
  $('[data-tool="orbit"]').title=editView==='top'?'화면 이동 (5)':'화면 회전 (5)';
  scene?.setEditOptions?.({brush:editBrush,selectedPortId,movingPortId,topView:editView==='top'});
  const selectedPort=editor.analysis.sim.getPortVisuals().find(p=>p.id===selectedPortId);
  $('#edit-port-inspector').hidden=!selectedPort;
  if(selectedPort){setText('#edit-selected-port-name',`${selectedPort.id} · ${selectedPort.x+1}, ${selectedPort.z+1}`);$('#edit-selected-port-type').value=selectedPort.type;setText('#edit-port-status',selectedPort.operational?'선택한 포트를 드래그하거나 이동 버튼으로 위치를 바꿉니다.':selectedPort.operationalReason);}
  const impact=editPreview?.impact;
  $('#edit-impact-card').hidden=!editPreview;
  if(editPreview){
    const sign=v=>`${v>0?'+':v<0?'−':''}${n(Math.abs(v))}`;
    const parts=[editPreview.reason,`셀 ${sign(impact.cellDelta)} · 최대 수용 ${sign(impact.capacityDelta)} SKU`];
    if(impact.affectedPortIds.length)parts.push(`포트 ${impact.affectedPortIds.join(', ')} 영향`);
    if(impact.unavailableSkuDelta>0)parts.push(`출고 불가 +${n(impact.unavailableSkuDelta)} SKU`);
    if(impact.unassignedSkuDelta>0)parts.push(`공간 부족 +${n(impact.unassignedSkuDelta)} SKU`);
    setText('#edit-impact-title',editPreview.title||'변경 미리보기');setText('#edit-impact-detail',parts.filter(Boolean).join(' · '));
    $('#edit-impact-card').dataset.status=editPreview.status||'valid';
    $('#edit-impact-card').hidden=noticeHidden('edit-impact-card',$('#edit-impact-title').textContent+'|'+$('#edit-impact-detail').textContent);
  }
}
function syncScenePresentation(){
  const blocked=!['design','edit','inspect'].includes(tab)||!!document.querySelector('dialog[open]');
  if(blocked===scenePresentationBlocked)return;
  scenePresentationBlocked=blocked;document.body.classList.toggle('scene-obscured',blocked);
  scene?.setRenderSuspended(blocked);
  if(!blocked)refreshScene();
}
function refreshScene(){
  if(!scene||scenePresentationBlocked)return;
  const warehouse=viewSim();
  if(sceneCellSource!==warehouse.cells||sceneCellRevision!==warehouse.revision){
    const ports=new Map(warehouse.ports.map(p=>[key(p.x,p.z),p]));
    sceneCells=[...warehouse.cells.values()].map(c=>({x:c.x,z:c.z,isEquipment:!!c.isEquipment,equipmentPortId:c.equipmentPortId??c.facilityPortIds?.[0]??null,facilityPortIds:c.facilityPortIds||[],portId:ports.get(c.key)?.id??null,portType:ports.get(c.key)?.type??'single',portBinId:ports.get(c.key)?.binId??null,portBusy:ports.get(c.key)?.status==='picking',reachable:c.reachable??warehouse.components[c.component]?.ports.length>0,bins:c.stack.map(id=>binVisual(id,warehouse))}));
    sceneCellSource=warehouse.cells;sceneCellRevision=warehouse.revision;
  }
  latestVisuals=warehouse.getRobotVisuals();
  const robots=latestVisuals.map(r=>({...r,bin:r.hoist?.binId?binVisual(r.hoist.binId,warehouse):null}));
  const activePaths=warehouse.robots.filter(r=>r.job).map((r,i)=>({color:i%2?'#6e8a73':'#215732',cells:r.currentOperation?.type==='move'?r.currentOperation.path.map(k=>{const[x,z]=k.split(',').map(Number);return{x,z};}):[]}));
  latestPorts=warehouse.getPortVisuals().map(p=>({...p,bins:p.bins.map(b=>({...binVisual(b.id||b.binId,warehouse),...b}))}));
  scene.setData({width:config.width,depth:config.depth,floorWidthM:config.floorWidthM,floorDepthM:config.floorDepthM,levels:warehouse.levels,binHeight:config.binHeightM,compartments:config.compartments,cells:sceneCells,robots,ports:latestPorts,activePaths,motionConfig:warehouse.getMotionConfig()});
  const target=observedRobot();const nextFollow=followMode==='none'||portFollowId?null:target?.id??null;
  if(nextFollow!==sceneFollowId){sceneFollowId=nextFollow;scene.setOptions({followRobotId:nextFollow});}
}
function binVisual(id,warehouse=sim){const b=warehouse.bins.get(id),skus=(b?.skuIds||[]).map(id=>warehouse.skuMap.get(id)).filter(Boolean);return{id,color:getBinColor(id),compartments:config.compartments,category:skus[0]?.category||'',skuCount:skus.length,weightKg:b?.weightKg||0,contents:skus.map(s=>({skuId:s.id,category:s.category,qty:s.qty,compartment:s.compartment}))};}
function setFollow(value,{preserveCamera=false}={}){if(value!=='none')clearInventoryTrace();if(value==='none'&&preserveCamera)scene?.stopFollowing?.();followMode=value;portFollowId=null;autoFollowRobotId=null;$('#follow-robot').value=value;sceneFollowId=undefined;scene?.setOptions({followPortId:null});refreshScene();}
function focusPort(id,{operator=false}={}){clearInventoryTrace();setFollow('none');portFollowId=id;closePanel();scene?.focusPort(id,{operator});renderMotion();}

function requestPriorityOutbound(skuId){
  if(editMode){toast('편집 내용을 적용하거나 취소한 뒤 반출하세요.');return;}
  const sku=sim.skuMap.get(skuId);
  if(!sku?.assigned||!sku.reachable||sku.operational===false||sku.qty-book.getReservedQty(skuId)<1){
    toast('출고 가능한 가용 재고와 설치 조건을 확인하세요.');return;
  }
  try{
    const request=sim.enqueueSku(skuId,1,{priority:'urgent',source:'inventory'});
    if(!request)return;
    lastRowRevision=-1;
    if(request.status==='blocked'){toast(`${request.id} 반출 보류 · ${request.reason}`);refresh(true);return;}
    const started=sim.start();
    selectInventorySku(skuId);refresh(true);refreshScene();
    const pending=sim.getStats().priorityRequestCount||1;
    toast(started?`${request.id} · ${request.binId} 우선 반출 접수${pending>1?` · 우선 요청 ${pending}건을 접수 순서대로 처리합니다.`:' · 빨간 빈의 이동을 확인하세요.'}`:`${request.id} 우선 반출 대기 · 포트와 로봇의 운영 조건을 확인하세요.`);
  }catch(err){toast(err.message);}
}
function selectInventorySku(id){
  if(editMode)return;
  try{
    const focus=inventoryFocus.select(id);
    clearOperationTrace();
    orderFocus.clear();dismissCelebration();selected=null;selectedRobotId=null;scene?.setSelected(null);setFollow('none');
    closePanel();refreshScene();renderInventoryTrace();scene?.focusBin?.(focus.binId);
  }catch(err){toast(err.message);}
}
function clearInventoryTrace({fit=false}={}){
  clearOperationTrace();
  inventoryFocus.clear();traceSceneId=null;scene?.setOptions({traceBinId:null});
  document.body.classList.remove('inventory-tracing');$('#inventory-trace-card').hidden=true;

}
function clearOperationTrace({fit=false}={}){
  operationFocusKey=null;operationTraceSignature='';operationTraceBinIds=[];scene?.setOptions({traceBinIds:[]});clearDiggingTrace();
  document.body.classList.remove('operation-tracing');$('#operation-trace-card').hidden=true;

}
function inspectOperation(groupKey){
  if(editMode)return;
  const operation=getOperationGroups(sim,book).find(group=>group.key===groupKey);
  if(!operation){toast('이 작업은 초기화되어 현재 목록에 없습니다.');return;}
  clearInventoryTrace();orderFocus.clear();dismissCelebration();
  operationFocusKey=groupKey;selected=null;selectedRobotId=null;scene?.setSelected(null);setFollow('none',{preserveCamera:true});
  closePanel();refreshScene();
}
function renderOperationFocus(groups){
  const operation=operationFocusKey&&!editMode?groups?.find(group=>group.key===operationFocusKey):null;
  if(operationFocusKey&&!operation){clearOperationTrace();return;}
  const card=$('#operation-trace-card');card.hidden=!operation;
  document.body.classList.toggle('operation-tracing',!!operation);
  if(!operation)return;
  operationTraceBinIds=operation.availableBinIds;
  const signature=operation.availableBinIds.join('|');
  if(signature!==operationTraceSignature){operationTraceSignature=signature;scene?.setOptions({traceBinIds:operation.availableBinIds});}
  setText('#operation-trace-title',operation.id);
  setText('#operation-trace-kind',`${operation.priority==='urgent'?'최우선 · ':''}${operation.kind} · ${operation.requests.length} SKU · ${operation.binIds.length}개 빈`);
  setText('#operation-trace-state',`${sim.paused?'일시정지 · ':''}${operation.stageSummary}`);
  setText('#operation-trace-progress',`${n(operation.pickedQty)} / ${n(operation.totalQty)}개 피킹`);
  $('#operation-trace-fill').style.width=`${Math.min(100,operation.progress*100)}%`;
  setText('#operation-trace-reason',operation.reason||(!operation.availableBinIds.length?'현재 추적할 수 있는 빈이 없습니다.':'빨간 빈은 이 주문에 포함된 실제 빈입니다. 위치는 작업 중에도 갱신됩니다.'));
  setHTML('#operation-trace-bins',operation.bins.map(bin=>`<button class="operation-bin-location" data-focus-operation-bin="${e(bin.binId)}" ${bin.available?'':'disabled'} aria-label="${e(bin.binId)} 위치에 맞춤"><span><i aria-hidden="true"></i><strong>${e(bin.binId)}</strong><small>${e(bin.stateLabel)}</small></span><b>${e(bin.label)}<span class="operation-bin-depth" data-digging-depth="${e(bin.binId)}"></span></b></button>`).join(''));
  setHTML('#operation-trace-requests',operation.requests.map(request=>`<div class="operation-request"><strong>${e(request.skuId)}<span>${request.pickedQty} / ${request.qty}개</span></strong><p>${e(request.name)}</p><small>${e(request.binId||'미배정')} · ${e(request.stageLabel)}${request.portId?` · ${e(request.portId)}`:''}</small>${request.activeTasks.map(task=>`<small>로봇 ${e(robotNumber(task.robotId))} · ${e(task.label)}${task.binId!==request.binId?` · 상부 빈 ${e(task.binId)}`:''}</small>`).join('')}${request.reason?`<small class="operation-wait-reason">${e(request.reason)}</small>`:''}</div>`).join(''));
  $('#operation-trace-fit').disabled=!operation.availableBinIds.length;
}
function renderOperations(groups,stats){
  const current=groups.filter(group=>group.status!=='complete');
  const active=current.filter(group=>group.status==='inProgress'),queued=current.filter(group=>group.status==='queued'),blocked=current.filter(group=>group.status==='blocked');
  const urgent=current.filter(group=>group.priority==='urgent'&&group.status!=='blocked');
  setText('#operations-state',`${$('#system-status-label').textContent} · ${$('#system-status-detail').textContent}`);
  setText('#operations-active',`${active.length}건`);setText('#operations-queued',`${queued.length}건`);setText('#operations-urgent',`${urgent.length}건`);
  setText('#operations-count',`${current.length}건${blocked.length?` · 확인 필요 ${blocked.length}건`:''}`);
  setHTML('#operations-list',renderOperationList(groups,stats));
  setText('#operations-resource-count',`로봇 ${stats.activeRobotCount}대 작업 · 포트 ${sim.ports.length}곳`);
  setHTML('#operations-resources',sim.robots.map(robot=>`<div class="operation-resource"><strong>로봇 ${e(robotNumber(robot.id))}</strong><span>${e(robot.job?(robot.currentOperation?.label||robot.status):'대기 중')}</span><small>${robot.job?`${robot.job.kind==='optimize'?'유휴 최적화':e(robot.job.order.customerOrderId||robot.job.order.id)} · ${e(robot.job.binId)}`:'다음 작업 배정을 기다립니다.'}</small></div>`).join('')+sim.getPortVisuals().map(port=>`<div class="operation-resource"><strong>${e(port.id)} 포트</strong><span>${e(portStatusNames[port.status]||'빈 도착 대기')} · ${port.occupied||0}/${port.capacity}빈</span><small>${port.accessibleBinId?`${e(port.accessibleBinId)} 작업자에게 제시 중`:'작업창 닫힘'}</small></div>`).join(''));
}
function renderInventoryTrace(){
  const focus=editMode?null:inventoryFocus.snapshot(),card=$('#inventory-trace-card');
  card.hidden=!focus;document.body.classList.toggle('inventory-tracing',!!focus);
  const id=focus?.available?focus.binId:null;
  if(id!==traceSceneId){traceSceneId=id;scene?.setOptions({traceBinId:id});}
  if(!focus)return;
  setText('#inventory-trace-bin',focus.binId);
  setText('#inventory-trace-sku',`${focus.skuId} · ${focus.compartment||'—'}번 구획`);
  setText('#inventory-trace-name',focus.skuName);
  setText('#inventory-trace-location',focus.locationLabel);
  setText('#inventory-trace-state',focus.statusLabel);
  setText('#inventory-trace-qty',`${n(focus.qty)}개`);
  setText('#inventory-trace-note',focus.available?'창고는 와이어프레임 · 빨간 빈의 실제 이동을 추적합니다.':'현재 빈을 찾을 수 없습니다. 재고에서 다른 품목을 선택하세요.');
  card.dataset.locationType=focus.locationType;$('#inventory-trace-fit').disabled=!focus.available;
}
function clearDiggingTrace(){
  if(diggingTraceSignature)scene?.setOptions({traceBlockerBinIds:[],traceDiggingTargets:[],traceDiggingRobots:[]});
  diggingTraceSignature='';
  for(const prefix of ['inventory','operation'])$(`#${prefix}-digging`).hidden=true;
}
function renderDiggingTrace(){
  const ids=editMode?[]:traceSceneId?[traceSceneId]:operationFocusKey?operationTraceBinIds:orderFocus.snapshot()?.binIds||[];
  if(!ids.length){clearDiggingTrace();return;}
  const context=getDiggingContext(sim,ids);
  const options={traceBlockerBinIds:[...new Set([...context.blockerBinIds,...context.movingBlockerBinIds])],
    traceDiggingTargets:context.targets.map(target=>({binId:target.binId,remainingCount:target.remainingCount})),
    traceDiggingRobots:context.robots.map(robot=>({robotId:robot.robotId,number:robot.number,targetBinId:robot.targetBinId,targetBinIds:robot.targetBinIds,blockerBinId:robot.blockerBinId,relatedBinId:robot.relatedBinId,requestId:robot.requestId,role:robot.role,taskKind:robot.taskKind,phase:robot.phase,phaseLabel:robot.phaseLabel}))};
  const signature=JSON.stringify(options);
  if(signature!==diggingTraceSignature){diggingTraceSignature=signature;scene?.setOptions(options);}
  const targetMap=new Map(context.targets.map(target=>[target.binId,target]));
  for(const el of $$('[data-digging-depth]')){const target=targetMap.get(el.dataset.diggingDepth),text=target?.locationType==='grid'?` · 상부 ${target.remainingCount}개`:'';if(el.textContent!==text)el.textContent=text;}
  for(const prefix of ['inventory','operation']){
    const container=$(`#${prefix}-digging`),card=$(`#${prefix}-trace-card`);
    container.hidden=card.hidden||!context.targets.length;if(container.hidden)continue;
    setText(`#${prefix}-digging-count`,`${n(context.remainingBlockerCount)}개`);
    const meta=[context.targets.length>1?'중복 제외 · 현재 적층 기준':'현재 적층 기준'];
    if(context.movingBlockerBinIds.length)meta.push(`상부 빈 ${context.movingBlockerBinIds.length}개 운반 중`);
    if(context.robots.length)meta.push(`담당 로봇 ${context.robots.length}대`);
    setText(`#${prefix}-digging-meta`,meta.join(' · '));
    let note=context.remainingBlockerCount?'회색 상부 빈을 옮기면 빨간 목표 빈에 접근할 수 있습니다.':context.targets.every(target=>['robot','port'].includes(target.locationType))?'목표 빈이 인출되어 운반·포트 단계에 있습니다.':context.targets.some(target=>target.locationType==='grid')?'목표 빈 위에 쌓인 빈이 없습니다.':'현재 적층 위치를 확인할 수 없습니다.';
    if(context.selectedBlockerCount)note+=` 상부에 포함된 목표 빈 ${context.selectedBlockerCount}개는 빨간색으로 유지합니다.`;
    if(sim.paused)note+=' 현재 일시정지 상태입니다.';
    setText(`#${prefix}-digging-note`,note);
    setHTML(`#${prefix}-digging-robots`,context.robots.length?context.robots.map(robot=>{
      const task=robot.role==='blocker'?'상부 빈 재배치':robot.taskKind==='return'?'목표 빈 보관 복귀':robot.taskKind==='optimize'?'목표 빈 최적화 재배치':robot.taskKind==='dig'?'선택 빈 재배치':'목표 빈 반출';
      const related=robot.relatedBinId||robot.blockerBinId||robot.targetBinId;
      return `<div class="trace-digging-robot" data-digging-robot="${e(robot.robotId)}" data-task-role="${e(robot.role||'blocker')}"><b>${e(robot.number)}</b><span><strong>${sim.paused?'일시정지 · ':''}${e(robot.phaseLabel)}</strong><small>${e(related)} · ${e(task)}${robot.role==='blocker'&&context.targets.length>1?` · ${e(robot.targetBinId)} 목표`:''}</small></span></div>`;
    }).join(''):`<p class="trace-digging-idle">${context.remainingBlockerCount?'상부 빈을 옮길 로봇의 배정을 기다립니다.':context.targets.some(target=>target.locationType==='port')?'목표 빈이 포트에 있습니다. 회수 로봇이 배정되면 함께 표시합니다.':'현재 이 빈을 처리하는 로봇이 없습니다.'}</p>`);
  }
}
function observedRobot(){
  if(followMode!=='none'&&followMode!=='auto')return latestVisuals.find(r=>r.id===followMode&&r.available!==false);
  let active=sim.robots.find(r=>r.id===autoFollowRobotId&&r.job);
  if(!active){active=sim.robots.find(r=>r.job);autoFollowRobotId=active?.id??null;}
  return latestVisuals.find(r=>r.id===active?.id)||latestVisuals.find(r=>r.available!==false&&r.onGrid);
}
function renderMotion(){
  renderInventoryTrace();
  renderDiggingTrace();
  if(editMode){if($('#focus-card'))$('#focus-card').hidden=true;return;}
  if($('#focus-card'))$('#focus-card').hidden=!portFollowId&&followMode==='none';
  if(portFollowId){
    const p=latestPorts.find(p=>p.id===portFollowId);
    if(p){
      $('#motion-robot').textContent=`${p.id} · ${p.type==='buffer3'?'3빈 버퍼 포트':'일반 포트'}`;
      $('#motion-phase').textContent=portStatusNames[p.status]||'포트 대기';
      $('#motion-detail').textContent=`작업 중 1개씩 제시 · 입고 예약 ${p.reserved||0}개 · ${p.activeRequestId||'다음 피킹 대기'}`;
      $('#motion-belt-label').textContent='수용 빈';$('#motion-speed-label').textContent='피킹 진행';$('#motion-bin-label').textContent='제시된 빈';
      $('#motion-belt').textContent=`${p.occupied||0} / ${p.capacity}`;$('#motion-speed').textContent=`${Math.round(Math.max(0,Math.min(1,p.progress||0))*100)}%`;$('#motion-bin').textContent=p.accessibleBinId||'—';
      if($('#focus-label')){$('#focus-label').textContent=`${p.id} · 스테이션`;$('#focus-state').textContent=portStatusNames[p.status]||'대기';$('#focus-caption').textContent=p.operational===false?p.operationalReason||'설치 조건 확인':`${p.accessibleBinId||'작업창 닫힘'} · ${p.occupied||0}/${p.capacity} 빈`;}
      $('#hoist-gauge-fill').style.height=`${Math.max(3,(p.progress||0)*100)}%`;return;
    }
  }
  $('#motion-belt-label').textContent='벨트 길이';$('#motion-speed-label').textContent='승강 속도';$('#motion-bin-label').textContent='결합된 빈';
  const r=observedRobot(),h=r?.hoist,mc=sim.getMotionConfig();
  const belt=Math.max(0,(mc.beltTopY??sim.actualHeightM+.592)-(h?.gripperY??mc.restGripperY??sim.actualHeightM+config.binHeightM+.09)-(mc.beltBottomOffset??.025));
  $('#motion-robot').textContent=r?`로봇 ${robotNumber(r.id)} · 2셀 / 4벨트`:'ROBOT · 미배치';
  $('#motion-phase').textContent=r?.status||'로봇을 놓을 두 칸이 필요합니다';
  const requestId=r?.requestId||r?.parentOrderId||r?.orderId;
  if($('#focus-label')){$('#focus-label').textContent=r?`로봇 ${robotNumber(r.id)}`:'로봇';$('#focus-state').textContent=r?.status||'대기';$('#focus-caption').textContent=h?.binId?`${h.binId} · ${requestId||''}`:'상부 그리드에서 주행';}
  $('#motion-detail').textContent=(requestId?`${requestId} · `:'')+(h?.loaded?'그리퍼와 빈이 결합된 상태입니다.':sim.running?'그리퍼 승강과 포트 인계를 진행합니다.':'디깅 시연으로 하강·결합·상승을 가까이 보세요.');
  $('#motion-belt').innerHTML=`${belt.toFixed(2)} <small>m</small>`;
  $('#motion-speed').innerHTML=`${(sim.running?Math.abs(h?.speedMps||0):0).toFixed(2)} <small>m/s</small>`;
  $('#motion-bin').textContent=h?.loaded?h.binId:'—';
  $('#hoist-gauge-fill').style.height=`${Math.min(100,Math.max(3,belt/(sim.actualHeightM+config.binHeightM)*100))}%`;
}
function startDigDemo(){
  if(editMode){toast('편집을 적용하거나 취소한 뒤 실행하세요.');return;}
  if(sim.getStats().operational===false){toast('설치 조건을 충족한 뒤 디깅을 실행할 수 있습니다.');openPanel('more');return;}
  setEditMode(false);
  resetExecution();
  const candidates=[...sim.bins.values()].filter(b=>b.location.type==='grid'&&b.skuIds.some(id=>sim.skuMap.get(id)?.reachable));
  candidates.sort((a,b)=>{const ac=sim.cells.get(a.location.key),bc=sim.cells.get(b.location.key);return (bc.stack.length-1-b.location.level)-(ac.stack.length-1-a.location.level)||a.location.level-b.location.level;});
  const bin=candidates[0];
  if(!bin){toast('두 칸 로봇이 포트까지 이동할 수 있는 재고가 필요합니다.');refresh(true);refreshScene();return;}
  const sku=bin.skuIds.map(id=>sim.skuMap.get(id)).find(s=>s.reachable&&s.qty>0);
  if(!sku)return;
  const above=sim.cells.get(bin.location.key).stack.length-1-bin.location.level;
  sim.enqueueSku(sku.id,1);$('#sim-speed').value='1';$('#cutaway').checked=true;scene?.setOptions({cutaway:true});
  setTool('orbit');setTab('design');setFollow(config.cooperativeDigging?'none':'auto');if(config.cooperativeDigging)scene?.setView('fit');sim.start();
  refresh(true);refreshScene();
  toast(`${bin.id} 인출 시연 · 상부 빈 ${above}개 · ${config.cooperativeDigging?'여러 로봇의 인출·운반을 함께 확인하세요.':'0.25×로 더 천천히 볼 수 있습니다.'}`);
}
function resetExecution(){
  if(editMode){toast('편집을 적용하거나 취소한 뒤 실행을 초기화하세요.');return;}
  clearInventoryTrace();
  sim.reset();book.resetExecution();orderFocus.reset();dismissCelebration();lastRowRevision=-1;wasRunning=false;autoFollowRobotId=null;
  config=sim.config;persist();refresh(true);refreshScene();
}
function expandCatalog(total){
  if(editMode)return;
  const value=Number(total);
  if(!Number.isInteger(value)||value<0||value>MAX_SKUS){toast(`전체 SKU 수는 0~${n(MAX_SKUS)}개의 정수로 입력하세요.`);return;}
  if(value===sim.catalog.length){toast('현재 SKU 수와 같습니다.');return;}
  if(value<sim.catalog.length){requestSkuDeletion(sim.catalog.slice(value).map(s=>s.id));return;}
  try{const before=sim.catalog.length;sim.setSkuCount(value);config=sim.config;lastRowRevision=-1;page=1;syncControls();persist();setTab(tab);refreshScene();toast(`${n(sim.catalog.length-before)}개 SKU를 추가했습니다. 전체 ${n(sim.catalog.length)}개입니다.`);}catch(err){toast(err.message);}
}
function requestSkuDeletion(ids){
  if(editMode)return;
  if(!sim.canAddSkus()){toast('빈 운반과 포트 작업을 마친 뒤 정지하면 삭제할 수 있습니다.');return;}
  const targets=[...new Set(ids)].filter(id=>sim.skuMap.has(id));if(!targets.length)return;
  const targetSet=new Set(targets),busy=sim.orders.filter(o=>targetSet.has(o.skuId)&&['queued','inProgress'].includes(o.status));
  if(busy.length){toast(`선택한 SKU의 피킹 요청 ${busy.length}건을 마친 뒤 삭제해 주세요.`);return;}
  pendingSkuDeletion=targets;
  const linked=book.orders.filter(o=>o.lines.some(line=>targetSet.has(line.skuId))),open=linked.filter(o=>o.status!=='shipped');
  const names=targets.slice(0,6).map(id=>{const s=sim.skuMap.get(id);return `<li><strong>${e(id)}</strong> ${e(s.name)}</li>`;}).join('');
  setHTML('#sku-delete-summary',`<p><strong>${n(targets.length)} SKU</strong>를 삭제합니다. 전체 ${n(sim.catalog.length)} → <strong>${n(sim.catalog.length-targets.length)} SKU</strong></p><ul>${names}</ul>${targets.length>6?`<p class="field-note">외 ${n(targets.length-6)}개 품목</p>`:''}<p class="field-note">해당 품목의 재고를 제거합니다. 남은 품목과 빈 위치, 완료된 출고 기록은 유지됩니다.</p>`);
  setHTML('#sku-delete-orders',linked.length?`<strong>연결된 주문 ${linked.length}건</strong><p>${e(linked.slice(0,5).map(o=>o.id).join(', '))}${linked.length>5?' 외':''}</p><p>${open.length?`미완료 ${open.length}건은 삭제된 SKU가 포함되어 출고 보류됩니다.`:'완료된 주문 기록은 유지됩니다.'}</p>`:'');
  $('#sku-delete-confirm').textContent=`${n(targets.length)} SKU 삭제`;$('#sku-delete-dialog').showModal();
}
function deleteSelectedSkus(){
  if(!pendingSkuDeletion.length)return;
  try{
    const removed=new Set(pendingSkuDeletion);const result=sim.removeSkus(pendingSkuDeletion);
    if(removed.has(inventoryFocus.skuId))clearInventoryTrace();
    for(const order of book.orders)if(order.status!=='shipped'&&order.lines.some(line=>removed.has(line.skuId))){order.status='blocked';order.reason='삭제된 SKU가 포함된 주문입니다. 재고 구성을 확인해 주세요.';}
    for(const id of removed)inventorySelection.delete(id);
    config=sim.config;pendingSkuDeletion=[];lastRowRevision=-1;page=1;$('#sku-delete-dialog').close();
    persist();syncControls();refresh(true);refreshScene();toast(`${n(result.removed)} SKU를 삭제했습니다. 전체 ${n(sim.catalog.length)} SKU입니다.`);
  }catch(err){toast(err.message);}
}
function generateOrders(count=Number($('#order-generate-count').value),show=true){
  if(editMode){toast('편집을 적용하거나 취소한 뒤 주문을 생성하세요.');return[];}
  try{const created=book.generate(Math.max(1,Math.min(200,Math.floor(count)||20)),{combinedRatio:Number($('#order-combined-ratio').value)});lastRowRevision=-1;orderPage=Math.max(1,Math.ceil(book.orders.length/25));persist();if(show)setTab('orders');refresh(true);toast(created.length?`${created.length}건 생성 · 단품 ${created.filter(o=>o.kind==='single').length} / 합포장 ${created.filter(o=>o.kind==='combined').length}`:'생성할 가용 재고가 없습니다. 재고 배정과 주문 예약을 확인하세요.');return created;}catch(err){toast(err.message);return[];}
}
function runOrderList(id=null){
  if(editMode){toast('편집을 적용하거나 취소한 뒤 실행하세요.');return;}
  try{
    if(sim.getStats().operational===false){toast('포트 설치 조건을 확인하세요.');return;}
    setEditMode(false);
    if(id)book.submit(id);else book.submitAll();
    book.update();lastRowRevision=-1;
    if(sim.orders.some(o=>o.status==='queued'||o.status==='inProgress'))sim.start();
    else toast('실행할 주문이 없습니다. 대기 주문과 가용 재고를 확인하세요.');
    persist();refresh(true);
  }catch(err){toast(err.message);}
}
function selectCustomerOrder(id){
  if(editMode)return;
  try{
    clearInventoryTrace();
    book.update();sim.pause();setEditMode(false);dismissCelebration();
    const focus=orderFocus.select(id);selected=null;selectedRobotId=null;scene?.setSelected(null);setFollow('none',{preserveCamera:true});
    $('#show-bins').checked=true;scene?.setOptions({showBins:true});
    closePanel();refreshScene();
    toast(focus.missingSkuIds.length?`${focus.missingSkuIds.length}개 SKU는 빈 배정이 필요합니다.`:`${id} · 필요한 빈 ${focus.binIds.length}개를 와이어프레임으로 추적합니다.`);
  }catch(err){toast(err.message);}
}
function chooseListOrder(id){
  listOrderId=listOrderId===id?null:id;pointerTarget=null;listInteractionUntil=0;renderCustomerOrders();
}
function runListSelection(priority=false){
  if(editMode||!listOrderId)return;
  try{
    if(sim.getStats().operational===false)throw new Error('포트 설치 조건을 확인하세요.');
    const order=priority?book.prioritize(listOrderId):book.submit(listOrderId);
    book.update();lastRowRevision=-1;
    if(order.status==='blocked')throw new Error(order.reason||'출고 조건을 확인하세요.');
    if(order.status==='shipped')return;
    sim.start();persist();refresh(true);
    toast(priority?`${order.id} 우선 처리 · 진행 중인 이송·피킹 후 먼저 배정합니다.`:`${order.id} 실행을 시작했습니다.`);
  }catch(err){refresh(true);toast(err.message);}
}
function renderListSelection(system){
  const order=book.orders.find(o=>o.id===listOrderId),bar=$('#order-action-bar');
  bar.hidden=!order;if(!order){listOrderId=null;return;}
  setText('#list-selected-title',order.id);
  setText('#list-selected-summary',`${order.lines.length}종 · ${n(order.pickedQty)} / ${n(order.totalQty)}개 · ${orderStatusNames[order.status]}`);
  setText('#list-selected-note',order.reason|| (order.status==='shipped'?'모든 구성품이 출고되었습니다. 빈 위치와 기록을 확인할 수 있습니다.':order.priority==='urgent'?'우선 처리 중 · 진행 중인 이송·피킹은 마친 뒤 배정합니다.':'우선 처리는 남은 구성품 전체에 적용됩니다. 기존 요청은 중복 접수하지 않습니다.'));
  const unavailable=system.operational===false||order.status==='shipped'||order.status==='blocked'&&order.submittedAt!==null;
  $('#list-order-priority').disabled=unavailable||order.priority==='urgent';
  setText('#list-order-priority',order.status==='shipped'?'✓ 출고 완료':order.priority==='urgent'?'✓ 우선 처리 중':'↑ 우선 처리');
  $('#list-order-run').disabled=unavailable||sim.running&&order.submittedAt!==null;
  setText('#list-order-run',order.submittedAt!==null?'실행 계속':'일반 실행');
}
function clearSelectedOrder(){orderFocus.clear();dismissCelebration();refresh(true);}
function runSelectedOrder(){
  if(editMode){toast('편집을 적용하거나 취소한 뒤 실행하세요.');return;}
  const order=orderFocus.order;if(!order)return;
  if(order.status==='shipped')return;
  if(sim.getStats().operational===false){openPanel('more');toast('포트 설치 조건을 확인하세요.');return;}
  if(sim.running&&order.submittedAt!==null){sim.pause();refresh(true);return;}
  try{
    setEditMode(false);
    if(order.submittedAt===null)book.submit(order.id);
    book.update();lastRowRevision=-1;
    if(order.status==='blocked'){toast(order.reason||'이 주문의 출고 조건을 확인하세요.');refresh(true);return;}
    closePanel();sim.start();persist();refresh(true);refreshScene();
  }catch(err){toast(err.message);}
}
function dismissCelebration(){
  clearTimeout(celebrationTimer);celebration.stop();
  if($('#celebration-message'))$('#celebration-message').hidden=true;
}
function showOrderCompletion(order){
  dismissCelebration();
  $('#celebration-title').textContent=`${order.id} 피킹 완료`;
  $('#celebration-caption').textContent=`${order.lines.length}종 · ${n(order.totalQty)}개를 모두 피킹했습니다. ${order.kind==='combined'?'한 포장으로 출고합니다.':'출고 준비가 끝났습니다.'}`;
  $('#celebration-message').hidden=false;celebration.play();
  celebrationTimer=setTimeout(()=>{$('#celebration-message').hidden=true;},10000);
}
function renderSelectedOrder(system=sim.getStats()){
  const focus=orderFocus.snapshot(),card=$('#selected-order-card');
  const ids=editMode?[]:focus?.binIds||[],signature=ids.join('|');
  if(signature!==highlightSignature||focus){highlightSignature=signature;scene?.setOptions({highlightBinIds:[],traceBinIds:operationFocusKey?operationTraceBinIds:ids});}
  if(!card)return;
  card.hidden=!focus||editMode;
  document.body.classList.toggle('has-selected-order',!!focus&&!editMode);
  if(!focus)return;
  const {order,totalQty,pickedQty,progress,missingSkuIds}=focus;
  card.classList.toggle('completed',order.status==='shipped');
  $('#selected-order-title').textContent=order.id;
  $('#selected-order-summary').textContent=`${order.kind==='combined'?'합포장':'단품'} · ${order.lines.length} SKU · ${ids.length}개 빈 · ${n(totalQty)}개`;
  $('#selected-order-summary').title=order.lines.map(line=>`${line.skuId}: ${sim.skuMap.get(line.skuId)?.name||''} ${line.qty}개`).join('\n');
  setText('#selected-order-progress',`${n(pickedQty)} / ${n(totalQty)}개 피킹 · ${order.status==='shipped'?(focus.pendingReturns?'피킹 완료 · 빈 복귀 중':'피킹 완료'):missingSkuIds.length?`${missingSkuIds.length} SKU 미배정`:orderStatusNames[order.status]||order.status}`);
  $('#selected-order-fill').style.width=`${Math.min(100,progress*100)}%`;
  const run=$('#selected-order-run');
  run.disabled=system.operational===false||!!missingSkuIds.length||order.status==='shipped'||order.status==='blocked'&&order.submittedAt!==null;
  setHTML(run,order.status==='shipped'?'✓ 피킹 완료':sim.running&&order.submittedAt!==null?'Ⅱ 일시정지':order.submittedAt!==null?'▶ 피킹 계속':'▶ 선택 주문 실행');
  const complete=orderFocus.takeCompletion();if(complete)showOrderCompletion(complete);
}
function renderSystemStatus(s){
  let state=s.systemState||'idle',label=s.systemStateLabel||'대기 중',detail=s.systemStateDetail||'처리할 주문을 기다립니다.';
  if(sim.running&&s.priorityRequestCount>0){
    state='priority';label='우선순위 반출 중';
    detail=s.systemStateDetail||`${s.priorityRequest?.binId||'요청한 빈'} · 우선 요청 ${n(s.priorityRequestCount)}건`;
  }else if(sim.running&&state==='processing'){
    const jobs=sim.robots.filter(robot=>robot.job),digging=jobs.filter(robot=>robot.job.kind==='dig').length,
      returning=jobs.filter(robot=>robot.job.kind==='return').length,picking=sim.ports.filter(port=>port.status==='picking').length;
    const groups=new Map();
    for(const robot of jobs){const id=robot.job.order.id;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(robot);}
    const collaborators=[...groups.values()].filter(group=>group.length>1&&group.some(robot=>robot.job.kind==='dig')).sort((a,b)=>b.length-a.length)[0];
    label=collaborators?'협업 디깅 중':digging>1?'병렬 디깅 중':digging?'디깅 중':picking?'포트 피킹 중':returning===jobs.length&&returning?'빈 복귀 중':jobs.length?'빈 운반 중':'주문 배정 중';
    const parts=[];if(collaborators)parts.push(`같은 요청 ${collaborators.length}대 동시 작업`);else if(digging)parts.push(`디깅 로봇 ${digging}대`);if(picking)parts.push(`피킹 포트 ${picking}곳`);
    if(jobs.length-digging)parts.push(`운반·복귀 로봇 ${jobs.length-digging}대`);if(s.queuedOrders)parts.push(`대기 요청 ${s.queuedOrders}건`);
    detail=parts.join(' · ')||'요청한 빈의 작업 순서를 배정합니다.';
  }else if(sim.running&&state==='optimizing'){
    label='유휴시간 최적화 중';detail=`자주 요청된 빈을 상단으로 옮깁니다 · 재배치 ${n(s.optimizationMoves||0)}회`;
  }else if(sim.running&&state==='waiting'){
    label='운영 대기 중';detail=idleOptimizationEnabled?'새 주문을 기다리며 배치 개선 여부를 확인합니다.':'새 출고 요청을 기다립니다.';
  }
  if(editMode){state='editing';label='레이아웃 편집 중';detail='편집을 마치면 시뮬레이션으로 돌아갑니다.';}
  else if(s.operational===false){state='unavailable';label='설치 조건 확인';detail=s.operationalReason||'포트와 그리드 설정을 확인하세요.';}
  else if(sim.stalled){state='blocked';label='경로 확인 필요';detail='빈 이송·포트 회수 경로가 막혀 정지했습니다. 진행 작업에서 대기 사유를 확인하세요.';}
  else if(!sim.running&&!sim.paused&&s.blockedOrders&&!s.queuedOrders&&!s.activeOrders){state='blocked';label='보류 요청 확인';detail=`${n(s.blockedOrders)}건의 반출 조건을 확인해야 합니다. 진행 작업에서 상세 사유를 확인하세요.`;}
  else if(!sim.running){state=sim.paused?'paused':s.priorityRequestCount?'ready':sim.time?'complete':'ready';label=sim.paused?'일시정지':s.priorityRequestCount?'우선 반출 대기':sim.time?'작업 완료':'운영 준비';detail=s.priorityRequestCount?`우선 반출 ${n(s.priorityRequestCount)}건 대기 · ${sim.paused?'재개하면 우선 작업을 이어갑니다.':'운영 조건을 확인한 뒤 시작하세요.'}`:sim.paused?'로봇·포트·자동 최적화를 모두 멈췄습니다.':sim.time?'접수한 작업과 빈 복귀를 마쳤습니다.':'주문을 선택하거나 시뮬레이션을 시작하세요.';}
  const labelEl=$('#system-status-label'),detailEl=$('#system-status-detail');
  if(labelEl&&labelEl.textContent!==label)labelEl.textContent=label;
  if(detailEl&&detailEl.textContent!==detail){detailEl.textContent=detail;detailEl.title=detail;}
  if($('#system-status')){$('#system-status').dataset.state=state;$('#system-status').title=detail;}
  $('#system-status').setAttribute('aria-expanded',String(tab==='operations'));$('#system-status').disabled=editMode;
  if($('#optimization-moves'))$('#optimization-moves').textContent=`${n(s.optimizationMoves||0)}회`;
  if($('#optimization-demand'))$('#optimization-demand').textContent=`${n(s.demandSampleSize??book.orders.length)}건 주문 · ${n(demandBinCount)}개 빈`;
}
const orderStatusNames={draft:'주문 대기',queued:'피킹 대기',picking:'피킹 중',consolidating:'합포장 대기',shipped:'출고 완료',blocked:'보류'};
const requestStatusNames={queued:'대기',inProgress:'디깅·운반',complete:'빈 복귀 완료',blocked:'보류'};
const portStatusNames={idle:'빈 도착 대기',empty:'비어 있음',reserved:'입고 예약',receiving:'빈 입고 중',buffered:'순서 대기',waiting:'순서 대기',ready:'피킹 완료 · 회수 대기',presenting:'작업 위치로 이동',picking:'철물 피킹 중',picked:'피킹 완료',returning:'회수 위치로 이동',collecting:'로봇이 빈 회수 중',rotating:'다음 빈으로 회전',moving:'포트 내부 이송',done:'빈 회수 대기',awaitingReturn:'빈 회수 대기',returnReady:'빈 회수 대기',inbound:'빈 인계 완료','transfer-in':'버퍼로 이송 중','transfer-out':'회수 위치로 이송',outbound:'로봇 회수 대기'};
function portCard(p,compact=false){
  const slots=p.slots||[],progress=Math.max(0,Math.min(1,p.progress||0));
  return `<div class="port-buffer-card ${p.type==='buffer3'?'triple':''} ${compact?'compact-port':''}"><div class="port-card-heading"><strong>${e(p.id)} <span>${p.type==='buffer3'?'3빈 버퍼':'일반 · 1빈'}</span></strong><button data-port-operator="${e(p.id)}" class="text-button">작업자 시점 ↗</button></div><div class="port-card-state"><span>${e(p.operational===false?'설치 확인':portStatusNames[p.status]||'포트 대기')}</span><strong>${p.occupied||0} / ${p.capacity}<small>빈${p.reserved?` · 예약 ${p.reserved}`:''}</small></strong></div><div class="port-slots ${p.capacity===1?'one-slot':''}">${slots.map((s,i)=>{const active=s.binId&&s.binId===p.accessibleBinId,occupied=!!s.binId,reserved=s.status==='reserved';return `<div class="port-slot ${active?'presented':occupied?'occupied':reserved?'reserved':''}"><span>${active?'피킹 위치':s.role==='work'?'작업 위치':`내부 슬롯 ${i+1}`}</span><b>${e(s.binId||(reserved?'입고 예정':'빈 자리'))}</b><small>${e(portStatusNames[s.status]||(occupied?'대기':'비어 있음'))}</small></div>`;}).join('')}</div><div class="port-progress"><span style="width:${progress*100}%"></span></div><small class="port-card-foot">${p.operational===false?e(p.operationalReason||'포트 설치 조건을 확인하세요.'):p.accessibleBinId?`${e(p.accessibleBinId)} · 작업자에게 제시 중`:p.aperture?.state==='closing'?'회전과 함께 작업창 닫는 중':p.aperture?.openness>0?'작업창 여는 중 · 회전 종료·안착 후 피킹합니다.':'작업창 닫힘 · 빈 도착 대기'}</small><button data-port-focus="${e(p.id)}" class="text-button">스테이션 전체 보기</button></div>`;
}
function renderPorts(){latestPorts=sim.getPortVisuals();setHTML('#port-buffer-cards',latestPorts.map(p=>portCard(p)).join('')||'<p class="empty-copy">포트를 배치하면 빈 대기와 피킹 진행이 여기에 표시됩니다.</p>');}
function filteredCustomerOrders(){
  const q=$('#order-search').value.trim().toLowerCase(),kind=$('#order-kind-filter').value,status=$('#order-status-filter').value;
  return book.orders.filter(o=>(kind==='all'||o.kind===kind)&&(status==='all'||status==='urgent'&&o.priority==='urgent'&&o.status!=='shipped'||status==='active'&&['queued','picking','consolidating'].includes(o.status)||o.status===status)&&(!q||`${o.id} ${o.label||''} ${o.lines.map(l=>`${l.skuId} ${sim.skuMap.get(l.skuId)?.name||''}`).join(' ')}`.toLowerCase().includes(q)));
}
function renderCustomerOrders(){
  const s=book.getStats(),list=filteredCustomerOrders(),pages=Math.max(1,Math.ceil(list.length/25));orderPage=Math.min(orderPage,pages);
  $('#orders-total').textContent=n(s.totalOrders);$('#orders-kind-summary').textContent=`단품 ${n(s.singleOrders)} · 합포장 ${n(s.combinedOrders)}`;
  $('#orders-active').textContent=n(s.draftOrders+s.activeOrders);$('#orders-active-detail').textContent=`주문 대기 ${n(s.draftOrders)} · 합포장 대기 ${n(s.consolidatingOrders)}${s.blockedOrders?` · 보류 ${n(s.blockedOrders)}`:''}`;
  $('#orders-picked').textContent=`${n(s.pickedUnits)} / ${n(s.totalUnits)}`;$('#orders-shipped').textContent=n(s.shippedOrders);$('#orders-packages').textContent=`${n(s.packages)}개 포장 출고`;
  const warehousePending=sim.orders.some(o=>o.status==='queued'||o.status==='inProgress');
  const system=sim.getStats();renderListSelection(system);
  $('#run-orders').disabled=system.operational===false||(!s.draftOrders&&(sim.running||!warehousePending));setHTML('#run-orders',sim.running?'▶ 추가 대기 실행':warehousePending?'▶ 주문 처리 계속':'▶ 전체 대기 실행');
  $('#pause-orders').disabled=!sim.running;$('#orders-speed').value=$('#sim-speed').value;
  $('#order-generation-note').textContent=system.operational===false?'설치 조건을 충족하면 주문을 실행할 수 있습니다.':`출고 가능 ${n(system.operationalSkuCount??system.reachableSkuCount)} SKU · 예약 수량을 제외하고 생성`;
  const requests=new Map(sim.orders.map(o=>[o.id,o]));
  setHTML('#customer-order-body',list.slice((orderPage-1)*25,orderPage*25).map(o=>{
    const units=o.lines.reduce((a,l)=>a+l.qty,0),picked=o.lines.reduce((a,l)=>a+(l.pickedQty||0),0),percent=units?Math.min(100,picked/units*100):0,open=expandedOrders.has(o.id);
    const chip=o.status==='shipped'?'success':o.status==='blocked'?'orange':o.status==='consolidating'?'purple':o.status==='draft'?'gray':'';
    const names=o.lines.slice(0,2).map(l=>sim.skuMap.get(l.skuId)?.name||l.skuId);
    const details=o.lines.map(l=>{const sku=sim.skuMap.get(l.skuId),r=requests.get(l.requestId),done=(l.pickedQty||0)>=l.qty,robotIds=r?.robotIds||[r?.robotId].filter(Boolean);return `<div class="customer-line"><span class="line-sku">${e(l.skuId)}<small>${e(l.binId||sku?.binId||'미배정')}</small></span><span>${e(sku?.name||l.skuId)}<small>${r?`${e(r.id)} · ${e(r.portId||'포트 배정 대기')} · ${e(robotIds.map(robotNumber).join(', ')||'로봇 배정 대기')}`:'실행 전 · 가용 재고 확인 대기'}</small></span><strong>${n(l.pickedQty||0)} / ${n(l.qty)}</strong><span class="status-chip ${done?'success':r?.status==='blocked'?'orange':'gray'}">${done?'피킹 완료':r?.reason?e(r.reason):r?e(requestStatusNames[r.status]||r.status):'주문 대기'}</span></div>`;}).join('');
    return `<tr class="customer-order-row ${o.id===listOrderId?'order-selected':''}"><td><button class="order-expand" data-order-expand="${e(o.id)}" aria-expanded="${open}"><span>${open?'−':'＋'}</span><strong>${e(o.id)}</strong></button>${o.priority==='urgent'?'<span class="order-priority-label">↑ 우선 처리</span>':''}${o.shippedAt!=null?`<small class="sku-sub">${clock(o.shippedAt)} 출고</small>`:''}</td><td><span class="order-kind ${o.kind==='combined'?'combined':''}">${o.kind==='combined'?'합포장':'단품'}</span><small class="sku-sub">${o.status==='shipped'?'1개 포장 완료':o.kind==='combined'?'구성품 전체를 1포장':'1개 주문 · 1포장'}</small></td><td class="order-products"><strong>${o.lines.length}종 · ${n(units)}개</strong><small>${e(names.join(' / '))}${o.lines.length>2?` 외 ${o.lines.length-2}종`:''}</small></td><td><span class="order-progress-text">${n(picked)} / ${n(units)}개</span><div class="order-progress"><span style="width:${percent}%"></span></div></td><td><span class="status-chip ${chip}">${e(orderStatusNames[o.status]||o.status)}</span>${o.reason?`<small class="sku-sub order-reason">${e(o.reason)}</small>`:''}</td><td><div class="order-row-actions"><button class="order-select-button" data-choose-order="${e(o.id)}" aria-pressed="${o.id===listOrderId}" aria-label="${e(o.id)} 주문 선택">${o.id===listOrderId?'✓ 선택됨':'주문 선택'}</button><button class="quiet-button" data-select-order="${e(o.id)}" aria-label="${e(o.id)} 빈 추적">빈 추적 ↗</button></div></td></tr>${open?`<tr class="order-detail-row"><td colspan="6"><div class="customer-lines">${details}</div></td></tr>`:''}`;
  }).join('')||`<tr><td colspan="6"><div class="orders-empty"><strong>${book.orders.length?'검색 조건에 맞는 주문이 없습니다.':'아직 주문이 없습니다.'}</strong><p>${book.orders.length?'검색어와 필터를 바꿔 보세요.':'주문 생성 · 실행 설정을 열어 첫 주문을 만드세요.'}</p>${book.orders.length?'<button class="filter-reset" data-reset-filters="orders">검색·필터 초기화</button>':''}</div></td></tr>`);
  $('#customer-order-count').textContent=`전체 ${n(book.orders.length)}건 중 ${n(list.length)}건 · 페이지당 25건`;
  $('#order-page-label').textContent=`${orderPage} / ${pages}`;$('#order-page-prev').disabled=orderPage<=1;$('#order-page-next').disabled=orderPage>=pages;
}
function refresh(force=false){
  sim.setStrategies(strategyPreferences);
  const enabled=STRATEGY_KEYS.filter(k=>strategyPreferences[k]).length;
  setText('#strategy-summary',enabled?enabled+'개 전략 사용 중':orderPrefetch?'선행 준비 사용 중':'기본 운용');
  setText('#strategy-empty-travel',(sim.metrics.emptyTravelMeters||0).toFixed(1)+' m');
  setText('#strategy-port-wait',(sim.metrics.portStarvedSec||0).toFixed(1)+' 초');
  setText('#strategy-port-idle',(sim.metrics.portIdleDemandSec||0).toFixed(1)+' 초');
  setText('#strategy-traffic-wait',(sim.metrics.trafficWaitSec||0).toFixed(1)+' 초');
  book.update();
  const s=sim.getStats();
  $('#metric-total').textContent=n(s.skuCount);$('#metric-assigned').textContent=n(s.assignedSkuCount);
  setText('#inventory-allocation',`빈 배정 ${n(s.assignedSkuCount)} SKU · 미배정 ${n(s.unassignedSkuCount)} SKU · 수용량 ${n(s.capacitySkus)} SKU${s.accessReservedCellCount?` · 출고 접근 확보 ${n(s.accessReservedCellCount)}셀 비움`:``}`);
  $('#metric-unassigned').textContent=`미배정 ${n(s.unassignedSkuCount)} SKU`;$('#metric-unassigned').classList.toggle('bad',s.unassignedSkuCount>0);
  $('#metric-capacity').innerHTML=`${n(s.capacitySkus)}<em>SKU</em>`;$('#capacity-note').textContent=`여유 ${n(s.reserveSlots)}칸 제외 · ${config.compartments}구획/빈`;
  $('#metric-bins').innerHTML=`${n(s.binCount)}<em>개</em>`;$('#bin-note').textContent=`저장 셀 ${n(s.storageCellCount)}개 · ${(s.occupancy*100).toFixed(0)}% 적재`;
  $('#metric-reachable').textContent=n(s.operationalSkuCount??s.reachableSkuCount);$('#reachable-note').textContent=s.operational===false?'포트 설치 조건 미충족':s.unservedSkuCount?`출고 경로 없음 ${n(s.unservedSkuCount)} SKU`:`운영 포트 ${s.operationalPortCount??s.portCount}개`;
  $('#reachable-note').classList.toggle('bad',s.unservedSkuCount>0);
  $('#sim-time').textContent=clock(sim.time);$('#sim-completed').textContent=`${s.completedOrders} / ${sim.orders.length}`;$('#sim-relocations').textContent=`${s.relocations} 회`;
  $('#sim-active').textContent=`${s.activeRobotCount} / ${config.robotCount}`;$('#sim-average').textContent=s.completedOrders?`${s.avgOrderSec.toFixed(1)}초`:'—';
  setText('#run-state',editMode?'편집 모드':sim.running?'자동 운영':s.operational===false?'운영 불가':sim.time>0?'정지':'시뮬레이션');
  document.body.classList.toggle('simulation-running',sim.running);
  setHTML('#play',sim.running?'<span aria-hidden="true">Ⅱ</span>일시정지':`<span aria-hidden="true">▶</span>${orderFocus.order&&orderFocus.order.status!=='shipped'?'선택 주문 실행':sim.time>0?'운영 재개':'시뮬레이션 시작'}`);
  $('#play').disabled=!s.portCount||!s.reachableSkuCount||s.operational===false;
  $('#demo-dig').disabled=!s.portCount||!s.reachableSkuCount||s.operational===false;
  const bs=book.getStats();$('#nav-order-count').textContent=n(bs.totalOrders);$('#nav-sku-count').textContent=n(s.skuCount);
  $('#sim-shipments').textContent=`${bs.shippedOrders} / ${bs.totalOrders}`;
  $('#sim-collaboration').textContent=`${sim.orders.filter(o=>(o.diggingRobotIds||[]).length>1).length}건`;
  const portVisuals=sim.getPortVisuals();$('#sim-port-buffer').textContent=`${portVisuals.reduce((a,p)=>a+(p.occupied||0),0)} / ${portVisuals.reduce((a,p)=>a+p.capacity,0)}`;
  const editable=sim.canAddSkus();$('#apply-catalog').disabled=!editable;$('#catalog-target').disabled=!editable;
  $$('[data-add-skus]').forEach(b=>b.disabled=!editable||s.skuCount+Number(b.dataset.addSkus)>MAX_SKUS);
  $('#catalog-edit-note').textContent=editable?'늘리면 더미 품목을 추가하고, 줄이면 목록 뒤의 품목부터 삭제 대상을 확인합니다. 선택한 품목만 삭제할 수도 있습니다.':sim.running&&!s.activeRobotCount&&!s.portBinCount?'자동 운영을 일시정지하면 SKU를 추가·삭제할 수 있습니다.':'빈 운반과 포트 작업을 마친 뒤 정지하면 추가·삭제할 수 있습니다. 자동 최적화는 더보기에서 끌 수 있습니다.';
  const warnings=sim.getWarnings();const warningText=warnings.join('  ·  ');$('#warnings').hidden=noticeHidden('warnings',warningText);$('#warnings').textContent=warningText;
  if($('#model-invalid')){$('#model-invalid').hidden=s.operational!==false||noticeHidden('model-invalid',s.operationalReason||(s.portCount?'포트 설치 조건을 확인하세요.':'편집 메뉴에서 포트를 배치하세요.')); $('#model-invalid-text').textContent=s.operationalReason||(s.portCount?'포트 설치 조건을 확인하세요.':'편집 메뉴에서 포트를 배치하세요.');}
  renderSelectedOrder(s);
  renderInventoryTrace();
  renderSystemStatus(s);
  const operations=operationFocusKey||tab==='operations'?getOperationGroups(sim,book):null;
  renderOperationFocus(operations);
  renderDiggingTrace();
  if(tab==='operations')renderOperations(operations,s);
  renderEditor();
  if(tab==='inventory')renderInventory();if(tab==='activity')renderActivity();if(tab==='orders')renderCustomerOrders();
  if(force||tab==='inspect')renderSelection();if(force||tab==='more')renderRecent();if(force||tab==='ports')renderPorts();
  if(wasRunning&&!sim.running&&!sim.paused&&sim.orders.length&&s.queuedOrders===0&&s.activeOrders===0)toast(`실행 완료 · ${s.completedOrders}건 완료${s.blockedOrders?` · ${s.blockedOrders}건 보류`:''}`);
  wasRunning=sim.running;
}
function selectCell(x,z){inspectCell(x,z);}
function renderSelection(){
  const sim=viewSim();$('#inspect-panel-title').textContent=selectedRobotId?'선택한 로봇':'선택한 셀';
  if(selectedRobotId){
    const r=sim.getRobotVisuals().find(r=>r.id===selectedRobotId),id=r?.hoist?.binId||r?.jobTargetBinId;
    $('#selection-title').textContent='로봇 '+String(selectedRobotId).replace(/\D/g,'').padStart(3,'0');$('#selection-tag').textContent='ROBOT';
    setHTML('#selection-content',r?'<div class="inspector-summary"><span>'+e(r.status)+'</span><span>'+e(r.hoist?.loaded?'빈 운반 중':'빈 미적재')+'</span></div><p class="field-note">'+(id?'강조된 빈 <strong>'+e(id)+'</strong> · '+(r.hoist?.binId?'현재 운반 중':'다음 작업 대상'):'다음 작업 배정을 기다리고 있습니다.')+'</p><p class="field-note">'+(r.route?.length>1?'초록 경로 · 현재 위치에서 다음 이동 목적지까지<br>':'')+'배경 클릭 또는 닫기로 선택을 해제합니다.</p>':'<p class="empty-copy">로봇을 찾을 수 없습니다.</p>');return;
  }
  if(!selected){$('#selection-title').textContent='셀을 선택해 보세요';$('#selection-tag').textContent='INSPECT';setHTML('#selection-content','<p class="empty-copy">그리드의 셀을 누르면 쌓인 빈과 각 빈의 철물을 확인할 수 있습니다.</p><div class="inspect-hint"><span>01</span>도구 선택<span>02</span>셀 클릭<span>03</span>빈 확인</div>');return;}
  const c=sim.cells.get(key(selected.x,selected.z));$('#selection-title').textContent=`셀 (${selected.x+1}, ${selected.z+1})`;
  if(!c){$('#selection-tag').textContent='빈 공간';setHTML('#selection-content','<p class="empty-copy">아직 그리드가 없는 자리입니다. ‘셀 추가’ 또는 ‘포트’ 도구로 배치할 수 있습니다.</p>');return;}
  if(c.isPort||c.isEquipment){const p=sim.getPortVisuals().find(p=>key(p.x,p.z)===c.key||c.facilityPortIds?.includes(p.id)||c.equipmentPortId===p.id||p.footprintReservedKeys?.includes(c.key));$('#selection-tag').textContent=p?.id||'설비 영역';setHTML('#selection-content',`<p class="field-note">포트의 승강·회전 영역입니다. 저장 빈을 배정하지 않으며 상부 레일은 유지합니다.</p>${p?portCard(p,true):'<p class="empty-copy">포트 설비를 위해 확보한 공간입니다.</p>'}`);return;}
  if(c.storageExcluded){$('#selection-tag').textContent='빈 배정 제외';setHTML('#selection-content','<p class="empty-copy">2칸 로봇과 상부 대기 위치를 고려했을 때 포트로 출고할 수 없는 열입니다. 빈 배정·재배치·복귀 대상에서 제외하고 비워 둡니다. 포트 위치나 로봇 수, 셀 배치를 변경하면 다시 계산합니다.</p>');return;}
  const reachable=c.reachable??sim.components[c.component]?.ports.length>0;$('#selection-tag').textContent=`${c.stack.length} / ${sim.levels}층`;
  setHTML('#selection-content',`<div class="inspector-summary"><span>${c.stack.length}개 빈</span><span>${n(c.stack.reduce((sum,id)=>sum+sim.bins.get(id).skuIds.length,0))} SKU</span><span>${reachable?'2셀 출고 경로':'출고 경로 없음'}</span></div><div class="bin-stack-list">${c.stack.length?c.stack.slice().reverse().map((id,j)=>{const b=sim.bins.get(id),first=sim.skuMap.get(b.skuIds[0]);return `<div class="bin-row"><b>${c.stack.length-j}층</b><button data-bin-inventory="${e(id)}"><strong>${e(id)}</strong><small>${e(first?.category)} 외 ${b.skuIds.length} SKU · ${b.weightKg.toFixed(2)}kg</small></button><span class="tiny-count">${j===0?'최상단':'상부 '+j+'개'}</span></div>`;}).join(''):'<p class="empty-copy">빈이 없는 열입니다. 다른 빈의 재배치 공간으로 사용할 수 있습니다.</p>'}</div>`);
}
function eventHtml(v){return `<div class="event"><time>${clock(v.time)}</time><span class="event-dot"></span><p><strong>${e(v.title)}</strong>${v.detail?`<br>${e(v.detail)}`:''}</p></div>`;}
function renderRecent(){setHTML('#recent-events',sim.logs.slice(0,3).map(eventHtml).join('')||'<p class="empty-copy">아직 작업 기록이 없습니다.</p>');}
function scrollListStart(panel){
  listInteractionUntil=0;listTouchActive=false;
  const list=$(`#${panel}-panel .table-scroll`),content=list.closest('.panel-content');
  list.scrollTop=0;content.scrollTop+=list.getBoundingClientRect().top-content.getBoundingClientRect().top-8;
}
function filteredRows(){
  const q=$('#sku-search').value.trim().toLocaleLowerCase(),cat=$('#category-filter').value,status=$('#status-filter').value;
  const filterKey=JSON.stringify([q,cat,status]);
  if(lastRowSource===sim.catalog&&lastRowRevision===sim.revision&&lastRowFilter===filterKey)return rows;
  rows=!q&&cat==='all'&&status==='all'?sim.catalog:sim.catalog.filter(s=>{
    if(cat!=='all'&&s.category!==cat)return false;
    if(status==='assigned'&&!s.assigned||status==='unassigned'&&s.assigned||status==='unreachable'&&(!s.assigned||s.reachable))return false;
    if(!q)return true;
    let text=inventorySearchIndex.get(s);
    if(!text){text=`${s.code} ${s.name} ${s.spec}`.toLocaleLowerCase();inventorySearchIndex.set(s,text);}
    return text.includes(q)||(s.binId||'').toLocaleLowerCase().includes(q);
  });
  lastRowSource=sim.catalog;lastRowRevision=sim.revision;lastRowFilter=filterKey;return rows;
}
function renderInventory(){
  const reserved=book.getReservedMap(),list=filteredRows(),pages=Math.max(1,Math.ceil(list.length/50));page=Math.min(page,pages);
  const visible=sim.getSkuRows(list.slice((page-1)*50,page*50)).map(s=>({...s,reservedQty:reserved.get(s.id)||0}));
  for(const id of inventorySelection)if(!sim.skuMap.has(id))inventorySelection.delete(id);
  setHTML('#sku-table-body',visible.map(s=>`<tr class="${inventoryFocus.skuId===s.id?'inventory-tracked-row':''}"><td class="sku-selection-cell"><input type="checkbox" data-select-sku="${e(s.id)}" aria-label="${e(s.id)} 선택" ${inventorySelection.has(s.id)?'checked':''}></td><td>${s.binId?`<button class="sku-code sku-track-link" data-track-sku="${e(s.id)}" aria-label="${e(s.id)} 빈 위치 추적">${e(s.code)}</button>`:`<span class="sku-code">${e(s.code)}</span>`}<small class="sku-sub">${e(s.category)}</small></td><td>${e(s.name)}<small class="sku-sub">단위중량 ${Math.round(s.unitWeightKg*1000)}g · ${s.unit}</small></td><td><strong>${n(s.qty)}</strong> ${e(s.unit)}${s.reservedQty?`<small class="sku-sub">예약 ${n(s.reservedQty)} · 가용 ${n(Math.max(0,s.qty-s.reservedQty))}</small>`:''}</td><td>${s.binId?`<button class="table-link bin-trace-link" data-track-sku="${e(s.id)}" aria-label="${e(s.id)}의 ${e(s.binId)} 추적"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9"/></svg>${e(s.binId)}</button><small class="sku-sub">${s.compartment}번 구획</small>`:'—'}</td><td>${s.binId?`<button class="table-link" data-track-sku="${e(s.id)}" aria-label="${e(s.id)} 현재 위치 추적">${e(s.locationLabel)}<small class="sku-sub">빈 추적 ↗</small></button>`:e(s.locationLabel)}</td><td><span class="status-chip ${!s.assigned?'gray':!s.reachable||s.operational===false?'orange':''}">${!s.assigned?'미배정':!s.reachable?'출고 경로 없음':s.operational===false?'설치 확인':'배정됨'}</span></td><td><button class="row-pick" data-pick-sku="${e(s.id)}" title="일반 주문과 유휴 최적화보다 먼저 배정하고 빈을 추적합니다." ${!s.assigned||!s.reachable||s.operational===false||s.qty-s.reservedQty<=0?'disabled':''}>1개 우선 반출</button></td></tr>`).join('')||'<tr><td colspan="8" class="empty-table"><strong>일치하는 품목이 없습니다.</strong><button class="filter-reset" data-reset-filters="inventory">검색·필터 초기화</button></td></tr>');
  $('#inventory-selection-bar').hidden=!inventorySelection.size;setText('#inventory-selected-count',n(inventorySelection.size));
  $('#inventory-delete-selected').disabled=!sim.canAddSkus();
  $('#sku-select-page').checked=visible.length>0&&visible.every(s=>inventorySelection.has(s.id));$('#sku-select-page').indeterminate=visible.some(s=>inventorySelection.has(s.id))&&!$('#sku-select-page').checked;$('#sku-select-page').disabled=!visible.length;
  $('#inventory-count').textContent=`전체 ${n(sim.catalog.length)} SKU 중 ${n(list.length)}개 · 페이지당 50개`;
  $('#page-label').textContent=`${page} / ${pages}`;$('#page-prev').disabled=page<=1;$('#page-next').disabled=page>=pages;
}
function renderActivity(){
  const statusNames={queued:'대기',inProgress:'진행 중',complete:'완료',blocked:'보류'};
  $('#activity-status').textContent=sim.running?'실행 중':`${sim.orders.length}건의 요청`;
  setHTML('#order-list',sim.orders.slice().reverse().map(o=>`<div class="order-row ${o.priority==='urgent'?'priority-request':''}"><div><strong>${e(o.id)} · ${e(o.skuId)}${o.priority==='urgent'?'<span class="priority-badge">최우선</span>':''}</strong><small>${e(o.customerOrderId||(o.priority==='urgent'?'재고 우선 반출':'개별 반출'))} · ${e(o.binId||'미배정')} · ${o.pickedQty||0}/${o.qty}개 · ${e(o.portId||'포트 대기')}</small><small>${(o.diggingRobotIds||[]).length>1?`협업 디깅 ${e(o.diggingRobotIds.join(' + '))}`:`참여 ${e((o.robotIds||[o.robotId].filter(Boolean)).join(', ')||'배정 대기')}`}${o.reason?' · '+e(o.reason):''}</small></div><span class="status-chip ${o.status==='blocked'?'orange':o.status==='queued'?'gray':o.status==='complete'?'success':''}">${statusNames[o.status]||e(o.status)}</span></div>`).join('')||'<p class="empty-copy">주문목록에서 주문을 생성해 실행하거나, 철물 재고에서 품목을 선택하세요.</p>');
  setHTML('#full-events',sim.logs.map(eventHtml).join(''));
}
function openPanel(name){
  if(name==='design'){closePanel();return;}
  if(editMode&&!['edit','inspect'].includes(name)){toast('편집 내용을 적용하거나 취소한 뒤 다른 메뉴를 열어 주세요.');return;}
  const target=$(`#${name}-panel`);if(!target)return;
  if(name==='edit')setEditMode(true);
  if(tab==='inspect'&&name!=='inspect')clearSceneSelection({close:false});
  const opening=tab==='design',changed=tab!==name;
  if(opening)panelReturnFocus=document.activeElement;
  tab=name;$$('.floating-panel').forEach(p=>p.hidden=p!==target);
  const layer=$('#panel-layer');if(layer){layer.hidden=false;layer.dataset.panel=name;}
  document.body.classList.add('panel-open');
  document.body.dataset.panel=name;
  syncScenePresentation();
  const modal=!['edit','inspect'].includes(name);target.setAttribute('aria-modal',String(modal));
  $$('[data-background-ui]').forEach(el=>el.inert=modal);$('#design-panel').inert=modal;
  $$('[data-tab]').forEach(b=>{const active=b.dataset.tab===name;b.classList.toggle('active',active);b.setAttribute('aria-expanded',String(active));b.removeAttribute('aria-current');});
  if($('#page-title'))$('#page-title').textContent='wedraw WMS';
  refresh(true);
  if(changed)requestAnimationFrame(()=>{if(tab===name)(target.querySelector('[data-close-panel]')||target).focus({preventScroll:true});});
}
function closePanel(){
  if(tab==='inspect')clearSceneSelection({close:false});
  const hadPanel=tab!=='design';tab='design';
  const layer=$('#panel-layer');if(layer)layer.hidden=true;
  $$('.floating-panel').forEach(p=>p.hidden=true);document.body.classList.remove('panel-open');
  delete document.body.dataset.panel;
  syncScenePresentation();
  $$('[data-background-ui]').forEach(el=>el.inert=false);$('#design-panel').inert=false;
  $$('[data-tab]').forEach(b=>{const main=b.dataset.tab==='design';b.classList.toggle('active',main);b.setAttribute('aria-expanded','false');if(main)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  if(hadPanel&&panelReturnFocus?.isConnected)panelReturnFocus.focus({preventScroll:true});
  requestAnimationFrame(()=>scene?.resize());refresh(true);
}
function setTab(name){openPanel(name);}
function togglePlay(){
  if(editMode){toast('편집 내용을 적용하거나 취소한 뒤 실행하세요.');return;}
  if(sim.running){sim.pause();refresh();return;}
  if(orderFocus.order&&orderFocus.order.status!=='shipped'){runSelectedOrder();return;}
  if(sim.getStats().operational===false){openPanel('more');toast('설치 조건을 확인한 뒤 실행하세요.');return;}
  setEditMode(false);
  try{
    // Resuming a paused warehouse must not submit other, still-draft orders.
    if(sim.time>0){sim.start();refresh(true);return;}
    if(!sim.orders.some(o=>o.status==='queued'||o.status==='inProgress')){
      if(!book.orders.length){const added=generateOrders(20,false);if(!added.length){refresh();return;}}
      if(book.orders.some(o=>o.status==='draft')){book.submitAll();lastRowRevision=-1;}
    }
    sim.start();refresh(true);
  }catch(err){toast(err.message);}
}
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function undo(){if(!editor)return;scene?.cancelEditGesture?.();clearEditPreview();if(editor.undo()){syncDraft();toast('직전 편집을 되돌렸습니다.');}}
function redo(){if(!editor)return;scene?.cancelEditGesture?.();clearEditPreview();if(editor.redo()){syncDraft();toast('편집을 다시 적용했습니다.');}}
function changePortType(id,type){
  if(!editor)return;
  const next={...config,ports:config.ports.map(p=>p.id===id?{...p,type}:p)},analysis=editor.preview(next),port=analysis.sim.ports.find(p=>p.id===id);
  if(/겹/.test(port?.operationalReason||'')){toast(port.operationalReason);syncControls();renderEditor();return;}
  changeConfig(next);
}

// Build the scene after all action handlers have been defined.
try {scene=createScene($('#scene'),{onInspect:inspectCell,onInspectRobot:inspectRobot,onClearSelection:clearSceneSelection,onHover:onEditorHover,onEditGesture,onSelectPort:selectEditPort,onExpand:expandGrid,onExpandPreview:previewExpansion,onEditViewChange:view=>{editView=view;renderEditor();}});scene.setOptions({editing:false,showPaths:false,showLabels:false,cutaway:false,stationInterior:false});scene.setTool('orbit');}catch(err){$('#scene-error').hidden=false;$('#scene-error').textContent=`3D 화면을 열 수 없습니다. ${err.message} 재고와 주문은 메뉴에서 확인할 수 있습니다.`;}
$$('[data-tool]').forEach(b=>b.addEventListener('click',()=>{if(!editMode)return;setTool(b.dataset.tool);if(tab!=='edit')closePanel();}));
$$('[data-brush]').forEach(b=>b.addEventListener('click',()=>{scene?.cancelEditGesture?.();clearEditPreview();editBrush=b.dataset.brush;renderEditor();}));
$('#edit-view-switch').addEventListener('click',()=>{if(!editor)return;scene?.cancelEditGesture?.();clearEditPreview();editView=editView==='top'?'iso':'top';scene?.setEditOptions?.({topView:editView==='top'});scene?.setView(editView);renderEditor();});
$('#edit-cell-zoom').addEventListener('click',()=>{if(!editor)return;clearEditPreview();scene?.zoomToCells();renderEditor();});
$('#edit-fit').addEventListener('click',()=>{scene?.cancelEditGesture?.();clearEditPreview();const view=editView;scene?.setView('fit');if(view==='top')scene?.setView('top');renderEditor();});
$('#edit-undo').addEventListener('click',undo);$('#edit-redo').addEventListener('click',redo);
$('#edit-cancel').addEventListener('click',requestExitEditing);
$('#edit-settings').addEventListener('click',()=>{if(tab==='edit')closePanel();else openPanel('edit');});
$('#list-order-clear').addEventListener('click',()=>{listOrderId=null;renderCustomerOrders();});
$('#list-order-priority').addEventListener('click',()=>runListSelection(true));
$('#list-order-run').addEventListener('click',()=>runListSelection());
$('#list-order-trace').addEventListener('click',()=>selectCustomerOrder(listOrderId));$('#finish-edit').addEventListener('click',openApplyEdit);
$('#edit-apply-back').addEventListener('click',()=>$('#edit-apply-dialog').close());$('#edit-apply-confirm').addEventListener('click',applyEditing);
$('#edit-apply-discard').addEventListener('click',cancelEditing);
$('#edit-port-selection-close').addEventListener('click',()=>{selectedPortId=movingPortId=null;scene?.setSelected(null);clearEditPreview();renderEditor();});
$('#edit-port-delete').addEventListener('click',()=>removeEditPort());
$('#edit-port-move').addEventListener('click',()=>{if(!selectedPortId)return;setTool('port');movingPortId=selectedPortId;clearEditPreview();renderEditor();toast('새 위치를 선택하거나 포트를 드래그해 옮기세요. Esc로 이동을 취소합니다.');});
$('#edit-selected-port-type').addEventListener('change',ev=>changePortType(selectedPortId,ev.target.value));
$('#new-port-type').addEventListener('change',()=>{clearEditPreview();renderEditor();});
$$('[data-view]').forEach(b=>b.addEventListener('click',()=>{setFollow('none');scene?.setView(b.dataset.view);if(b.dataset.view!=='fit')$$('[data-view]').forEach(v=>v.classList.toggle('active',v===b));}));
$$('[data-tab]').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.tab)));
$('.brand').addEventListener('click',ev=>{ev.preventDefault();closePanel();setFollow('none');scene?.setView('fit');});
$('#add-port').addEventListener('click',()=>{setTab('design');setTool('port');toast('그리드에서 포트로 사용할 셀을 클릭하세요.');});
function renderFloorInputs(){
  const {widthM,depthM}=pendingFloor,area=widthM*depthM;
  $('#floor-unit').value=floorUnit;$('#floor-area').value=Number(areaInUnit(area,floorUnit).toFixed(3));
  $('#floor-width').value=Number(widthM.toFixed(4));$('#floor-depth').value=Number(depthM.toFixed(4));
  setText('#floor-summary',area.toLocaleString('ko-KR',{maximumFractionDigits:2})+' ㎡ · '+areaInUnit(area,'pyeong').toLocaleString('ko-KR',{maximumFractionDigits:2})+'평');
  setText('#floor-grid-count',Math.floor((widthM+1e-9)/.705)+' × '+Math.floor((depthM+1e-9)/.480)+' 격자 · 1셀 0.705 × 0.480m');
}
$('#floor-unit').addEventListener('change',ev=>{floorUnit=ev.target.value;renderFloorInputs();});
$('#floor-area').addEventListener('change',ev=>{try{pendingFloor=floorFromArea(ev.target.value,floorUnit,pendingFloor.widthM,pendingFloor.depthM);renderFloorInputs();}catch(error){toast(error.message);renderFloorInputs();}});
for(const axis of ['width','depth'])$('#floor-'+axis).addEventListener('change',ev=>{
  const value=Number(ev.target.value);if(!Number.isFinite(value)||value<=0){toast('바닥 길이를 양수로 입력해 주세요.');renderFloorInputs();return;}
  pendingFloor={...pendingFloor,[axis+'M']:value};renderFloorInputs();
});
$('#apply-floor').addEventListener('click',()=>{
  try{const next=configureFloor(config,pendingFloor.widthM,pendingFloor.depthM);changeConfig(next);editView='top';editBrush='rectangle';scene?.setEditOptions({brush:editBrush,topView:true});scene?.setView('fit');scene?.setView('top');setTool('add');renderEditor();toast('바닥 격자를 드래그해 셀을 배치하세요. 직사각형과 자유 그리기를 전환할 수 있습니다.');}
  catch(error){toast(error.message);}
});
function dimensionsChanged(){changeConfig(resizeLayout(config,$('#grid-width').value,$('#grid-depth').value));}
$('#grid-width').addEventListener('change',dimensionsChanged);$('#grid-depth').addEventListener('change',dimensionsChanged);
function heightChanged(v){changeConfig({...config,maxHeightM:Math.min(6,Math.max(config.binHeightM,+v||config.binHeightM))});}
$('#height-range').addEventListener('pointerdown',()=>editor?.beginGroup());
$('#height-range').addEventListener('input',ev=>{if(editor&&!editor.inGroup)editor.beginGroup();heightChanged(ev.target.value);});
for(const event of ['change','pointerup','blur'])$('#height-range').addEventListener(event,()=>{editor?.endGroup();renderEditor();});
$('#height-range').addEventListener('pointercancel',()=>{if(editor?.cancelGroup())syncDraft();});
$('#height-number').addEventListener('change',ev=>heightChanged(ev.target.value));
$('#height-number').addEventListener('blur',ev=>heightChanged(ev.target.value));
$('#height-number').addEventListener('keydown',ev=>{if(ev.key==='Enter'){heightChanged(ev.target.value);ev.target.blur();}});
$('#bin-height').addEventListener('change',ev=>changeConfig({...config,binHeightM:+ev.target.value,maxHeightM:Math.max(config.maxHeightM,+ev.target.value)}));
$('#compartments').addEventListener('change',ev=>changeConfig({...config,compartments:+ev.target.value}));
$('#robots-minus').addEventListener('click',()=>changeConfig({...config,robotCount:config.robotCount-1}));$('#robots-plus').addEventListener('click',()=>changeConfig({...config,robotCount:config.robotCount+1}));
function commitRobotCount(){
  if(!editMode)return;
  const input=$('#robot-count'),value=Math.max(1,Math.min(MAX_ROBOTS,Math.round(Number(input.value)||1)));
  input.value=value;if(value!==config.robotCount)changeConfig({...config,robotCount:value});
}
$('#robot-count').addEventListener('change',commitRobotCount);
$('#robot-count').addEventListener('blur',commitRobotCount);
$('#robot-count').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();commitRobotCount();}});
$('#cooperative-digging').addEventListener('change',ev=>changeConfig({...config,cooperativeDigging:ev.target.checked}));
$$('[data-preset]').forEach(b=>b.addEventListener('click',()=>{const type=b.dataset.preset,cells=[];for(let z=0;z<config.depth;z++)for(let x=0;x<config.width;x++){const middle=x>=Math.floor(config.width*.3)&&x<Math.ceil(config.width*.7);if(type==='empty'||type==='l'&&x>=Math.ceil(config.width*.48)&&z<Math.floor(config.depth*.55)||type==='u'&&middle&&z<Math.ceil(config.depth*.62))continue;cells.push(key(x,z));}const ports=type==='empty'?[]:[{id:'P1',x:0,z:config.depth-1,type:'buffer3'},{id:'P2',x:type==='l'?0:config.width-1,z:0,type:'single'}];changeConfig({...config,activeCells:cells,ports});$$('.preset').forEach(p=>p.classList.toggle('active',p===b));if(type==='empty')setTool('add');}));
$('#reset-design').addEventListener('click',()=>{changeConfig({...createDefaultConfig(),skuCount:config.skuCount,catalogIds:config.catalogIds,nextSkuNumber:config.nextSkuNumber});setFollow('none');selected=null;selectedRobotId=null;scene?.setSelected(null);scene?.setView('fit');editView='iso';toast('기본 12 × 8 그리드를 편집 초안에 불러왔습니다.');refresh(true);});
$('#play').addEventListener('click',togglePlay);$('#step-order').addEventListener('click',()=>generateOrders(20,true));
$('#operation-trace-clear').addEventListener('click',()=>{clearOperationTrace({fit:true});refreshScene();});
$('#operation-trace-fit').addEventListener('click',()=>{const group=getOperationGroups(sim,book).find(value=>value.key===operationFocusKey);if(group)scene?.focusBins?.(group.availableBinIds);});
$('#operation-trace-list').addEventListener('click',()=>openPanel('operations'));
$('#reset-sim').addEventListener('click',()=>{resetExecution();toast('재고와 실행을 초기화했습니다. 같은 주문을 다시 실행할 수 있습니다.');});
$('#sim-speed').addEventListener('change',ev=>$('#orders-speed').value=ev.target.value);
$('#orders-speed').addEventListener('change',ev=>$('#sim-speed').value=ev.target.value);
$('#apply-catalog').addEventListener('click',()=>expandCatalog($('#catalog-target').value));
$('#catalog-target').addEventListener('keydown',ev=>{if(ev.key==='Enter')expandCatalog(ev.target.value);});
$('#sku-select-page').addEventListener('change',ev=>{for(const s of filteredRows().slice((page-1)*50,page*50))if(ev.target.checked)inventorySelection.add(s.id);else inventorySelection.delete(s.id);renderInventory();});
$('#inventory-clear-selection').addEventListener('click',()=>{inventorySelection.clear();renderInventory();});
$('#inventory-delete-selected').addEventListener('click',()=>requestSkuDeletion([...inventorySelection]));
$('#sku-delete-cancel').addEventListener('click',()=>{pendingSkuDeletion=[];$('#sku-delete-dialog').close();});
$('#sku-delete-confirm').addEventListener('click',deleteSelectedSkus);
$('#generate-orders').addEventListener('click',()=>generateOrders());
$('#run-orders').addEventListener('click',()=>runOrderList());
$('#pause-orders').addEventListener('click',()=>{sim.pause();refresh(true);});
$('#reset-orders-run').addEventListener('click',()=>{resetExecution();toast('같은 주문을 대기 상태로 돌렸습니다. 대기 주문 실행을 누르세요.');});
$('#show-bins').addEventListener('change',ev=>scene?.setOptions({showBins:ev.target.checked}));$('#show-paths').addEventListener('change',ev=>scene?.setOptions({showPaths:ev.target.checked}));
$('#cutaway').addEventListener('change',ev=>scene?.setOptions({cutaway:ev.target.checked}));
$('#station-interior')?.addEventListener('change',ev=>scene?.setOptions({stationInterior:ev.target.checked}));
function changePickingSeconds(value){
  try{pickingSeconds=sim.setPickingSeconds(value);syncControls();persist();refresh(true);toast('피킹 시간을 개당 '+pickingSeconds+'초로 적용했습니다.');}
  catch(error){$('#picking-seconds').value=pickingSeconds;toast(error.message);}
}
$('#picking-seconds').addEventListener('change',ev=>changePickingSeconds(ev.target.value));
$$('[data-picking-seconds]').forEach(button=>button.addEventListener('click',()=>changePickingSeconds(button.dataset.pickingSeconds)));
$('#order-prefetch').addEventListener('change',ev=>{orderPrefetch=ev.target.checked;persist();refresh(true);toast(orderPrefetch?'다음 빈의 선행 리프팅·포트 근접 대기·완료 빈 회수를 조율합니다.':'빈 선행 공급을 껐습니다.');});
$$('[data-robot-strategy]').forEach(input=>input.addEventListener('change',()=>{
  strategyPreferences={...strategyPreferences,[input.dataset.robotStrategy]:input.checked};sim.setStrategies(strategyPreferences);persist();refresh(true);
  toast('운용 전략을 저장했습니다. 다음 작업 배정부터 적용합니다.');
}));
$('#idle-optimization')?.addEventListener('change',ev=>{idleOptimizationEnabled=ev.target.checked;persist();refresh(true);toast(idleOptimizationEnabled?'주문이 없을 때 빈 배치를 최적화합니다.':'자동 최적화를 껐습니다. 진행 중인 빈 이동은 마무리합니다.');});
$('#show-labels')?.addEventListener('change',ev=>scene?.setOptions({showLabels:ev.target.checked}));
$('#follow-robot').addEventListener('change',ev=>{setFollow(ev.target.value);if(ev.target.value==='none')scene?.setView('fit');closePanel();});
$('#selected-order-run')?.addEventListener('click',runSelectedOrder);
$('#selected-order-clear')?.addEventListener('click',clearSelectedOrder);
$('#inventory-trace-clear').addEventListener('click',()=>{clearInventoryTrace({fit:true});refresh(true);});
$('#inventory-trace-fit').addEventListener('click',()=>{const focus=inventoryFocus.snapshot();if(focus?.available)scene?.focusBin?.(focus.binId);});
$('#inventory-trace-inventory').addEventListener('click',()=>openPanel('inventory'));
$('#celebration-dismiss')?.addEventListener('click',dismissCelebration);
$('#leave-focus')?.addEventListener('click',()=>{setFollow('none');scene?.setView('fit');renderMotion();});
$('#demo-dig').addEventListener('click',startDigDemo);
$('#mobile-settings').addEventListener('click',()=>openPanel('edit'));
$('#panel-scrim')?.addEventListener('click',closePanel);
$('#category-filter').innerHTML='<option value="all">모든 분류</option>'+categories.map(c=>`<option>${e(c)}</option>`).join('');
for(const id of ['sku-search','category-filter','status-filter'])$('#'+id).addEventListener(id==='sku-search'?'input':'change',()=>{page=1;renderInventory();});
$('#page-prev').addEventListener('click',()=>{page--;renderInventory();scrollListStart('inventory');});$('#page-next').addEventListener('click',()=>{page++;renderInventory();scrollListStart('inventory');});
for(const id of ['order-search','order-kind-filter','order-status-filter'])$('#'+id).addEventListener(id==='order-search'?'input':'change',()=>{orderPage=1;renderCustomerOrders();});
$('#order-page-prev').addEventListener('click',()=>{orderPage--;renderCustomerOrders();scrollListStart('orders');});$('#order-page-next').addEventListener('click',()=>{orderPage++;renderCustomerOrders();scrollListStart('orders');});
document.addEventListener('change',ev=>{let b=ev.target.closest('[data-port-type]');if(b&&editMode)changePortType(b.dataset.portType,b.value);b=ev.target.closest('[data-select-sku]');if(b){if(b.checked)inventorySelection.add(b.dataset.selectSku);else inventorySelection.delete(b.dataset.selectSku);renderInventory();}});
const listPanelTarget=target=>target?.closest?.('#orders-panel .panel-content,#inventory-panel .panel-content');
document.addEventListener('touchstart',ev=>{if(listPanelTarget(ev.target))listTouchActive=true;},{capture:true,passive:true});
for(const event of ['touchend','touchcancel'])document.addEventListener(event,()=>{listTouchActive=false;listInteractionUntil=Date.now()+350;},{capture:true,passive:true});
document.addEventListener('scroll',ev=>{if(listPanelTarget(ev.target))listInteractionUntil=Date.now()+350;},{capture:true,passive:true});
document.addEventListener('pointerdown',ev=>{pointerTarget=ev.target;},true);
document.addEventListener('pointerup',()=>{setTimeout(()=>pointerTarget=null,80);},true);
document.addEventListener('pointercancel',()=>{pointerTarget=null;},true);
document.addEventListener('click',ev=>{
  let b=ev.target.closest('[data-open-panel]');if(b){openPanel(b.dataset.openPanel);return;}
  b=ev.target.closest('[data-close-panel]');if(b){closePanel();return;}
  b=ev.target.closest('[data-open-tab]');if(b){setTab(b.dataset.openTab);return;}
  b=ev.target.closest('[data-add-skus]');if(b&&!b.disabled){expandCatalog(sim.catalog.length+Number(b.dataset.addSkus));return;}
  b=ev.target.closest('[data-order-expand]');if(b){const id=b.dataset.orderExpand;expandedOrders.has(id)?expandedOrders.delete(id):expandedOrders.add(id);renderCustomerOrders();return;}
  b=ev.target.closest('[data-choose-order]');if(b){chooseListOrder(b.dataset.chooseOrder);return;}
  b=ev.target.closest('[data-reset-filters]');if(b){const orders=b.dataset.resetFilters==='orders';for(const id of orders?['order-search','order-kind-filter','order-status-filter']:['sku-search','category-filter','status-filter'])$('#'+id).value=id.endsWith('search')?'':'all';if(orders){orderPage=1;renderCustomerOrders();}else{page=1;renderInventory();}return;}
  b=ev.target.closest('[data-select-order]');if(b){selectCustomerOrder(b.dataset.selectOrder);return;}
  b=ev.target.closest('[data-submit-order]');if(b){runOrderList(b.dataset.submitOrder);return;}
  b=ev.target.closest('[data-port-operator]');if(b){focusPort(b.dataset.portOperator,{operator:true});return;}
  b=ev.target.closest('[data-port-focus]');if(b){focusPort(b.dataset.portFocus);return;}
  b=ev.target.closest('[data-port-remove]');if(b){removeEditPort(b.dataset.portRemove);return;}
  b=ev.target.closest('[data-port-locate]');if(b){if(editMode)selectEditPort(b.dataset.portLocate);else{const p=config.ports.find(p=>p.id===b.dataset.portLocate);if(p)selectCell(p.x,p.z);}return;}
  b=ev.target.closest('[data-location]');if(b){const[x,z]=b.dataset.location.split(',').map(Number);selectCell(x,z);return;}
  b=ev.target.closest('[data-track-sku]');if(b){selectInventorySku(b.dataset.trackSku);return;}
  b=ev.target.closest('[data-inspect-operation]');if(b){inspectOperation(b.dataset.inspectOperation);return;}
  b=ev.target.closest('[data-focus-operation-bin]');if(b&&!b.disabled){scene?.focusBin?.(b.dataset.focusOperationBin);return;}
  b=ev.target.closest('[data-digging-fit]');if(b){scene?.focusDigging?.();return;}
  b=ev.target.closest('[data-bin-inventory]');if(b){$('#sku-search').value=b.dataset.binInventory;$('#category-filter').value='all';$('#status-filter').value='all';page=1;setTab('inventory');return;}
  b=ev.target.closest('[data-pick-sku]');if(b&&!b.disabled){requestPriorityOutbound(b.dataset.pickSku);return;}
});
document.addEventListener('keydown',ev=>{
  if(document.querySelector('dialog[open]'))return;
  if(ev.key==='Escape'){
    ev.preventDefault();if(tab!=='design')closePanel();else if(editMode)requestExitEditing();else{clearInventoryTrace();clearSelectedOrder();}return;
  }
  if(ev.key==='Tab'&&!['design','edit','inspect'].includes(tab)){
    const panel=$(`#${tab}-panel`),items=Array.from(panel?.querySelectorAll('button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"],summary')||[]).filter(el=>el.getClientRects().length>0);
    if(items.length){const first=items[0],last=items[items.length-1];if(ev.shiftKey&&(document.activeElement===first||!panel.contains(document.activeElement))){ev.preventDefault();last.focus();}else if(!ev.shiftKey&&(document.activeElement===last||!panel.contains(document.activeElement))){ev.preventDefault();first.focus();}}
    return;
  }
  if(/INPUT|SELECT|TEXTAREA/.test(ev.target.tagName))return;
  if(editMode&&(ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='z'){ev.preventDefault();if(ev.shiftKey)redo();else undo();return;}
  if(editMode&&(ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='y'){ev.preventDefault();redo();return;}
  if(editMode&&selectedPortId&&(ev.key==='Delete'||ev.key==='Backspace')){ev.preventDefault();removeEditPort();return;}
  const t={'1':'select','2':'add','3':'erase','4':'port','5':'orbit'}[ev.key];if(t&&editMode){setTool(t);if(tab!=='edit')closePanel();}
  if(ev.code==='Space'&&tab==='design'&&!/BUTTON|A|SUMMARY/.test(ev.target.tagName)){ev.preventDefault();if(!editMode)togglePlay();}
});
$('#export-design').addEventListener('click',()=>{download('wedraw-wms-layout.json',JSON.stringify({version:1,title:'wedraw WMS 설계',config},null,2),'application/json');toast('현재 그리드 설계를 내보냈습니다.');});
$('#import-design').addEventListener('click',()=>$('#import-file').click());
$('#import-file').addEventListener('change',async ev=>{const file=ev.target.files[0];if(!file)return;try{if(file.size>5*1024*1024)throw Error('5MB 이하의 설계 JSON 파일을 선택하세요.');const json=JSON.parse(await file.text());if(json.version!==1)throw Error('지원하지 않는 설계 버전입니다.');const next=validateConfig(json.config);setEditMode(true);changeConfig(next);setFollow('none');scene?.setView('fit');openPanel('edit');toast('설계를 불러왔습니다. 편집 메뉴에서 확인하세요.');}catch(err){toast('불러오기 실패: '+err.message);}finally{ev.target.value='';}});
$('#export-csv').addEventListener('click',()=>{const list=sim.getSkuRows(filteredRows()),line=values=>values.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',');const csv=[line(['SKU','분류','철물명','규격','수량','단위','빈','구획','위치','배정 상태','출고 가능'])].concat(list.map(s=>line([s.code,s.category,s.name,s.spec,s.qty,s.unit,s.binId,s.compartment,s.locationLabel,s.assigned?'배정':'미배정',s.assigned&&s.reachable&&s.operational!==false?'가능':'불가']))).join('\r\n');download('wedraw-wms-inventory.csv','\uFEFF'+csv,'text/csv;charset=utf-8');toast(`${n(list.length)}개 품목을 CSV로 내보냈습니다.`);});
$('#export-orders').addEventListener('click',()=>{book.update();const list=filteredCustomerOrders(),line=values=>values.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',');const csv=[line(['주문번호','유형','주문상태','SKU','철물명','주문수량','피킹수량','피킹요청','출고시각(모의초)','포장수'])].concat(list.flatMap(o=>o.lines.map(l=>line([o.id,o.kind==='combined'?'합포장':'단품',orderStatusNames[o.status],l.skuId,sim.skuMap.get(l.skuId)?.name,l.qty,l.pickedQty||0,l.requestId,o.shippedAt,o.status==='shipped'?1:0])))).join('\r\n');download('wedraw-wms-orders.csv','\uFEFF'+csv,'text/csv;charset=utf-8');toast(`${n(list.length)}건 주문을 CSV로 내보냈습니다.`);});
for(const id of ['help-button','model-info'])$('#'+id).addEventListener('click',()=>$('#help-dialog').showModal());
for(const id of ['close-help','help-done'])$('#'+id).addEventListener('click',()=>$('#help-dialog').close());
// Dismiss on the next outside interaction; opening clicks cannot close a new notice.
document.addEventListener('pointerdown',ev=>{
  for(const id of ['toast','celebration-message','warnings','model-invalid','edit-capacity-warning','edit-impact-card']){
    const el=$('#'+id);if(!el||el.hidden||el.contains(ev.target))continue;
    if(id==='celebration-message')dismissCelebration();
    else {el.hidden=true;if(id==='toast')clearTimeout(toastTimer);if(['warnings','model-invalid','edit-capacity-warning','edit-impact-card'].includes(id))dismissedNotices.set(id,id==='model-invalid'?$('#model-invalid-text').textContent:id==='edit-impact-card'?$('#edit-impact-title').textContent+'|'+$('#edit-impact-detail').textContent:el.textContent);}
  }
},true);
for(const dialog of $$('dialog')){
  let backdropDown=false;
  const outside=ev=>{const r=dialog.getBoundingClientRect();return ev.target===dialog&&(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',ev=>{backdropDown=outside(ev);});
  dialog.addEventListener('click',ev=>{if(backdropDown&&outside(ev))dialog.close();backdropDown=false;});
}
$('#sku-delete-dialog').addEventListener('close',()=>{pendingSkuDeletion=[];});

mountEditorWorkspace();
syncControls();setTool('orbit');refresh(true);refreshScene();persist();
function frame(ts){
  const dt=lastFrame?Math.min((ts-lastFrame)/1000,.2):0;lastFrame=ts;
  syncScenePresentation();
  // Presentation can rest behind a modal; the warehouse clock and jobs cannot.
  if(sim.running&&!editMode){try{simulationClock.advance(sim,dt,Number($('#sim-speed').value));}catch(err){sim.pause();toast('실행을 멈췄습니다: '+err.message);console.error(err);}}else simulationClock.reset();
  if(!scenePresentationBlocked&&ts-lastScenePaint>=(sim.running?16:100)){lastScenePaint=ts;refreshScene();}
  if(!scenePresentationBlocked&&ts-lastMotionPaint>100){lastMotionPaint=ts;renderMotion();}
  if(ts-lastUIPaint>350){lastUIPaint=ts;refresh();}
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

updateInputHints();
