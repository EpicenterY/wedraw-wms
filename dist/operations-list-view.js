const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const numberFormat = new Intl.NumberFormat('ko-KR');
const count = value => Math.max(0, Math.round(Number(value) || 0));
const number = value => numberFormat.format(count(value));
const values = value => Array.isArray(value) ? value.filter(item => item !== null && item !== undefined && item !== '') : [];
const robotNumber = id => /^R\d+$/.test(String(id)) ? String(id).slice(1).padStart(3, '0') : String(id || '—');

function emptyList(stats) {
  const optimizing = Number(stats?.optimizingRobotCount) > 0;
  return `<div class="operations-empty"><strong>${optimizing ? '주문이 없어 배치를 최적화하고 있습니다.' : '진행 중인 반출 요청이 없습니다.'}</strong><p>${optimizing ? '아래 로봇·포트 현황에서 현재 재배치 중인 빈과 동작을 확인하세요.' : '재고에서 우선 반출하거나 주문목록에서 주문을 실행하세요.'}</p><button type="button" class="secondary-button" data-open-panel="orders">주문목록 보기</button></div>`;
}

function operationRow(group) {
  const requests = values(group.requests);
  const binIds = values(group.binIds);
  const robots = values(group.robotIds).map(robotNumber);
  const ports = values(group.portIds).map(String);
  const status = group.status === 'inProgress' ? '진행 중' : group.status === 'queued' ? '배정 대기' : '확인 필요';
  const state = group.status === 'inProgress' ? 'active' : group.status === 'queued' ? 'queued' : 'blocked';
  const urgent = group.priority === 'urgent';
  const stage = String(group.stageSummary || status);
  const reason = String(group.reason || '');
  const picked = count(group.pickedQty), total = count(group.totalQty);
  const suppliedProgress = Number(group.progress);
  const progress = Math.max(0, Math.min(100, (Number.isFinite(suppliedProgress) ? suppliedProgress : total ? picked / total : 0) * 100));
  const robotText = robots.join(' · ') || '미배정';
  const portText = ports.join(' · ') || '대기';
  const label = [group.id, group.kind, urgent ? '우선 반출' : '', status, stage !== status ? stage : '',
    `${number(picked)} / ${number(total)}개 피킹`, `${number(requests.length)} SKU`, `${number(binIds.length)}개 빈`,
    robots.length ? `로봇 ${robotText}` : '로봇 미배정', ports.length ? `포트 ${portText}` : '포트 배정 대기', reason,
    '상세 정보와 빈 위치 보기'].filter(Boolean).join(' · ');

  return `<div class="operation-list-row" role="listitem"><button type="button" class="operation-list-item${urgent ? ' is-priority' : ''}${!binIds.length ? ' has-no-bins' : ''}" data-inspect-operation="${escapeHTML(group.key)}" aria-label="${escapeHTML(label)}">
    <span class="operation-list-identity"><strong title="${escapeHTML(group.id)}">${escapeHTML(group.id)}</strong><span class="operation-list-kind">${escapeHTML(group.kind || '반출 요청')}${urgent ? '<span class="priority-badge">우선 반출</span>' : ''}</span></span>
    <span class="operation-list-state is-${state}"><span class="operation-state-dot" aria-hidden="true"></span><span class="operation-list-phase" title="${escapeHTML(stage)}">${escapeHTML(stage)}</span></span>
    <span class="operation-list-picking"><span class="operation-list-quantity"><strong>${number(picked)}</strong><span>/ ${number(total)}<span class="operation-list-unit">개</span></span></span><span class="operation-list-progress" aria-hidden="true"><i style="width:${progress.toFixed(2)}%"></i></span></span>
    <span class="operation-list-inventory"><span><strong>${number(requests.length)}</strong><small>SKU</small></span><span class="operation-list-bin-count${!binIds.length ? ' is-empty' : ''}"><strong>${number(binIds.length)}</strong><small>개 빈</small></span></span>
    <span class="operation-list-assignment"><span><small>로봇</small><span${robots.length ? '' : ' class="is-unassigned"'}>${escapeHTML(robotText)}</span></span><span><small>포트</small><span${ports.length ? '' : ' class="is-unassigned"'}>${escapeHTML(portText)}</span></span></span>
    <span class="operation-list-arrow" aria-hidden="true">›</span>
    ${reason ? `<span class="operation-list-reason"><span aria-hidden="true"></span>${escapeHTML(reason)}</span>` : ''}
  </button></div>`;
}

/** Present live submitted operations as comparable rows; selection stays delegated to the app. */
export function renderOperationList(groups = [], stats = {}) {
  const current = values(groups).filter(group => group && group.status !== 'complete');
  if (!current.length) return emptyList(stats);
  return `<div class="operations-list-heading" aria-hidden="true"><span>주문</span><span>상태 · 현재 단계</span><span>피킹 진행</span><span>SKU · 빈</span><span>담당 로봇 · 포트</span><span></span></div><div class="operations-list-body" role="list" aria-label="현재 반출 작업">${current.map(operationRow).join('')}</div>`;
}
