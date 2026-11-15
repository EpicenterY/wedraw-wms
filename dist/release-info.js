/** New releases go first. Version, date and notes are rendered from this list. */
export const RELEASES=Object.freeze([
  Object.freeze({version:'1.12.0',date:'2026-11-15',changes:Object.freeze([
    '품목 순서 제약 없는 선행 공급 · 리프팅 후 포트 입구 예약',
    '포트 가까운 안전한 위치에서 대기 · 준비된 운반 로봇의 인계 순서 유지',
    '피킹 종료에 맞춘 근거리 회수 로봇 확보 · 완료 빈 우선 회수',
    '다음 주문 빈을 다시 덮는 배치 최소화 · 긴급 선행 빈과 단독 작업 복귀 보호',
    '동일한 6개 시나리오에서 공급 공백·전체 완료·완료 빈 체류 시간 감소 확인',
  ])}),
  Object.freeze({version:'1.11.0',date:'2026-11-15',changes:Object.freeze([
    '포트 상황에 맞춘 디깅·선행 리프팅 · 회수용 여유 로봇 확보',
    '3빈 포트 앞쪽 피킹과 후면 인계 병렬 진행 · 회전 안전 잠금 유지',
    '수량별 반복 피킹 애니메이션 · 주문·빈 추적의 강제 라벨 제거',
    '프레임별 계산 분산 · 경로 검증·바퀴 형상·GPU 버퍼 재사용',
    '공급 빈 없음과 실제 피킹 중단 시간을 분리 표시',
  ])}),
  Object.freeze({version:'1.10.0',date:'2026-11-15',changes:Object.freeze([
    '주문 목록 순서 선행 준비 · 다음 빈 디깅과 포트 공급을 병렬 배정',
    '개당 피킹 시간 0.5~60초 설정 · 기본 3초 · 진행률 유지와 자동 저장',
    '우선처리·포트 슬롯 예약 유지 · 준비된 빈부터 피킹해 순서 대기 완화',
  ])}),
  Object.freeze({version:'1.9.4',date:'2026-11-15',changes:Object.freeze([
    '편집 그리드 맞춤 여백 축소 · 평면·입체 모두 실제 영역에 맞춤',
    '셀 확대 · 짧은 변 44px 이상 · 평면 이동 도구로 한 손가락 이동',
    '하단바 간격·SVG 아이콘·선택 표시 통일 · 모바일 두 줄 도구 정리',
  ])}),
  Object.freeze({version:'1.9.3',date:'2026-11-15',changes:Object.freeze([
    '설정창과 그리드 공간 분리 · 남은 화면에 그리드 자동 맞춤',
    '설정창을 연 상태로 셀 배치·삭제·실행 취소 · 모바일 상하 분할',
    '하단 편집 도구 정리 · 브러시·시점·전체 맞춤은 그리드 위로 이동',
  ])}),
  Object.freeze({version:'1.9.2',date:'2026-11-15',changes:Object.freeze([
    '편집 수용량을 상단바에 고정 · 설정창을 열어도 항상 표시',
    '설계 설정과 하단 배치 도구 분리 · 편집 종료·변경 적용 버튼 통합',
    '설정 접기·다시 열기 · 상단 수용량과 하단 도구 사이에서 설정창 스크롤',
  ])}),
  Object.freeze({version:'1.9.1',date:'2026-11-15',changes:Object.freeze([
    '셀을 배치하지 않은 바닥은 선택·호버 대상에서 제외 · 편집 배치는 유지',
    '큰 모달의 굴절 필터와 내부 블러 중첩 제거 · 유리 질감 유지',
    '모달 뒤 3D 재그리기만 대기 · 운용은 계속 진행 · 닫을 때 현재 상태 복원',
    '셀·로봇 상세 보기에서는 이동과 카메라 갱신 속도 유지',
  ])}),
  Object.freeze({version:'1.9.0',date:'2026-11-15',changes:Object.freeze([
    '로고·운영 상태·핵심 현황·메뉴를 하나의 반응형 글라스 상단바로 통합',
    '상시 조작 안내 및 선택 로봇의 머리 위 상태 라벨 숨김',
    '셀·로봇 선택은 카메라를 유지하며 임시 와이어프레임 · 배경 클릭·닫기로 해제',
    '모든 시점의 셀 전체 강조 · 선택 로봇·다음 작업 빈·남은 이동 경로 강조',
    '3빈 포트 회전 80%부터 뚜껑 열림 · 회전 시작과 동시 닫힘 · 안착 후 피킹 · 불투명도 95%',
    '바닥·포트 공식 심볼과 워드마크 · 로봇 상단 번호 · 측면 번호/심볼 분리',
    '방향별 바퀴 승강 · 완전 복귀한 리프트 커버와 본체 지붕 높이 일치',
  ])}),
  Object.freeze({version:'1.8.1',date:'2026-11-15',changes:Object.freeze([
    '마우스를 올린 셀의 모든 빈을 옅은 반투명 음영과 테두리로 미리 강조',
    '호버·클릭 선택·빨간 추적 빈의 강조 구분 및 드래그·터치 잔상 방지',
    '빈 내부 칸막이 형상 제거 · 하나의 열린 수납공간으로 표시',
    '와이어프레임 추적 빈과 리프터 상판·벨트의 깊이 순서 수정',
  ])}),
  Object.freeze({version:'1.8.0',date:'2026-11-14',changes:Object.freeze([
    '1빈 포트를 전면 작업창·수직 셔터·승강 통로가 분리된 구조로 재설계',
    '고정 바코드 리더기와 물품 상승·스캔·인식·반출 애니메이션',
    '선택 셀에 쌓인 빈 전체를 초록 음영과 층별 테두리로 강조',
    '일반·와이어프레임 공통 적용 · 추적 빈의 빨간색 우선 유지',
  ])}),
  Object.freeze({version:'1.7.0',date:'2026-11-14',changes:Object.freeze([
    '버튼 R8·그룹 R10·카드 R14·패널 R18로 모서리 반경 축소',
    '작업 상세·빈 위치의 불투명 목록 배경 제거와 디깅 카드 글라스 통일',
    '전체 그리드·전체 빈·디깅 맞춤은 포트 작업면을 앞쪽으로 표시',
    '실제 피킹 진행률에 맞춘 물품 반출 애니메이션 · 일시정지·재생 속도 연동',
    '리프트를 막힌 상판으로 수정하고 WEDRAW 심볼 적용',
    '작업 초기화 버튼을 시작·일시정지 바로 옆으로 이동',
  ])}),
  Object.freeze({version:'1.6.0',date:'2026-11-14',changes:Object.freeze([
    '완료시간 기반 배정·포트 흐름 조율·시간대별 경로 예약을 개별 옵션으로 추가',
    'Rust의 후보 작업 평가와 시간 예약 검증 · 운용 지표와 옵션 자동 저장',
    '진행 중인 작업을 유지하며 다음 배정부터 전략 변경 · 모두 끄면 기본 운용',
    '모달 크기 축소 · 폴더블 설정 패널 개선 · 재고·주문·포트 목록의 글라스 배경 통일',
  ])}),
  Object.freeze({version:'1.5.2',date:'2026-11-14',changes:Object.freeze([
    '버튼·입력창 R12, 도구 모음 R16과 패널 모서리의 공통 디자인 규격 적용',
    '버튼·검색·선택 필드 높이와 간격 통일 · 닫기 버튼 원형 규격 정리',
    '모바일 44px 터치 영역과 편집·주문·재고 패널의 중첩 곡률 개선',
  ])}),
  Object.freeze({version:'1.5.1',date:'2026-11-14',changes:Object.freeze([
    '실제 배경 굴절·투명한 틴트·가장자리 반사를 갖춘 Liquid Glass 스타일 UI',
    '모바일 패널 크기에 맞춘 유리 렌즈 · 목록·상태 문구 대비 보강',
    '3빈 포트의 계단형 외장을 연속 곡면으로 변경하고 원형 구조선 정리',
    '상판·타워 모서리의 겹친 면을 제거해 표면 지글거림 수정',
  ])}),
  Object.freeze({version:'1.5.0',date:'2026-11-14',changes:Object.freeze([
    '공식 WEDRAW 로고·딥그린 포인트와 중성색 프로스티드 글라스 UI',
    '모바일 목록·선택 작업 바·편집·알림 패널의 대비와 시각적 일관성 개선',
    '3빈 포트 서비스 도어·금속 상판·타워 이음새·작업 콘솔 모델 정교화',
    '실제 포트 모델의 구조선과 회전대·셔터 상태를 공유하는 와이어프레임',
  ])}),
  Object.freeze({version:'1.4.0',date:'2026-11-14',changes:Object.freeze([
    '모바일 재고·주문 연속 스크롤과 터치 중 목록 위치 유지',
    '목록 선택 작업 바 · Rust 기반 합포장 전체 우선 처리·기존 요청 승격',
    '편집 설정 하단의 종료·적용 버튼과 변경 상태 표시',
    '출고 접근 불가 열을 비워 초기 배정·추가·재배치·복귀에서 제외',
    '알림과 확인창 바깥 클릭 닫기 · 검색 초기화·가독성 개선',
  ])}),
  Object.freeze({version:'1.3.2',date:'2026-11-14',changes:Object.freeze([
    '주문 추적 시작 시 자동 전체 빈 맞춤 제거 · 현재 카메라 유지',
    '로봇·포트 따라보기에서 주문 추적으로 전환해도 시점 유지',
  ])}),
  Object.freeze({version:'1.3.1',date:'2026-11-14',changes:Object.freeze([
    '폴더블의 펼친 화면·접힌 화면·가로 방향에 맞춘 모바일 배치',
    '두 손가락으로 3D 화면 이동·확대 · 편집 중 다중 터치 오배치 방지',
    '터치 버튼과 입력창 확대 · 주문 목록과 바닥 설정 가독성 개선',
  ])}),
  Object.freeze({version:'1.3.0',date:'2026-11-14',changes:Object.freeze([
    '주문·재고·포트 상태, 작업 배정과 유휴 최적화를 Rust로 전환',
    '선택 주문을 동일한 와이어프레임 추적으로 표시',
    '일반 뷰 전환 시 카메라 위치·확대·회전·패닝 유지',
    '바닥 면적을 ㎡·평으로 구성하고 셀 크기 격자에서 직접 배치',
    '기존 셀 수 상한 제거 · 사각형·브러시 편집과 실행 취소 지원',
  ])}),
  Object.freeze({version:'1.2.0',date:'2026-11-14',changes:Object.freeze([
    'v1.1.0의 30대 로봇·연속 작업·포트·추적 개선 유지',
    '로봇 경로와 접근 가능 영역 계산을 Rust·WebAssembly로 전환',
    '빈 수용량과 이동·승강 가감속 계산을 Rust 코어로 통합',
    '기존 웹 화면과 설계·주문 저장 형식 유지',
  ])}),
  Object.freeze({version:'1.1.0',date:'2026-11-14',changes:Object.freeze([
    '목표 빈의 최종 반출·회수 로봇까지 실시간 강조',
    '현재 반출 작업을 정렬된 목록 형태로 표시',
    '디깅 후 현재 위치에서 다음 작업 배정 · 필요한 경우만 가까이 비켜서기',
    '3빈 포트 외장 축소와 실제 설비 영역·저장 셀 간섭 수정',
    '변경 없는 편집 종료와 Esc 종료 · 기존 운영 상태 유지',
    '로봇 최대 30대 설정과 실제 배치 가능 대수 안내',
  ])}),
  Object.freeze({version:'1.0.2',date:'2026-11-14',changes:Object.freeze([
    '빈 추적 화면의 전면 윤곽 강화와 가려진 선 정리',
    '디깅 빈과 담당 로봇을 관통하던 배경선 제거',
    '휠 버튼·Shift 드래그 패닝의 앞뒤 반전 수정',
  ])}),
  Object.freeze({version:'1.0.1',date:'2026-11-14',changes:Object.freeze([
    '와이어프레임 빈의 반투명 음영과 층 구분 개선',
  ])}),
  Object.freeze({version:'1.0.0',date:'2026-11-14',changes:Object.freeze([
    '디깅 상부 빈·잔여 개수 가시화',
    '담당 디깅 로봇 강조 및 작업 단계 표시',
    '아이보리·차콜 투톤 로봇과 배경별 로고 적용',
    '우측 하단 버전 정보 추가',
  ])}),
]);

const dateLabel=value=>{const [year,month,day]=value.split('-');return `${year}년 ${Number(month)}월 ${Number(day)}일`;};
function element(tag,className,text){
  const node=document.createElement(tag);if(className)node.className=className;
  if(text!==undefined)node.textContent=text;return node;
}

/** Mounts read-only release information; it does not access the simulator. */
export function mountReleaseInfo(){
  if(document.getElementById('release-info-button'))return;
  const latest=RELEASES[0];if(!latest)return;
  const trigger=element('button','release-info-pill',`v${latest.version}`);
  trigger.id='release-info-button';trigger.type='button';trigger.dataset.backgroundUi='';
  trigger.setAttribute('aria-label',`wedraw WMS v${latest.version} 버전 정보`);
  trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls','release-info-dialog');
  trigger.setAttribute('aria-expanded','false');trigger.title=`버전 정보 · ${dateLabel(latest.date)} 업데이트`;

  const dialog=element('dialog','release-info-dialog');dialog.id='release-info-dialog';
  dialog.setAttribute('aria-labelledby','release-info-title');dialog.setAttribute('aria-describedby','release-info-summary');
  const close=element('button','release-info-close','×');close.id='release-info-close';close.type='button';
  close.setAttribute('aria-label','버전 정보 닫기');close.title='닫기 · Esc';
  const heading=element('h2','release-info-title','wedraw WMS');heading.id='release-info-title';
  const summary=element('p','release-info-summary','업데이트 내용');summary.id='release-info-summary';
  dialog.append(close,element('span','release-info-eyebrow','VERSION HISTORY'),heading,summary);
  for(const [index,release] of RELEASES.entries()){
    const section=element('section','release-info-entry');
    const meta=element('div','release-info-meta');
    const version=element('strong','release-info-version',`v${release.version}`);
    const date=element('time','release-info-date',dateLabel(release.date));date.dateTime=release.date;
    if(index===0){version.id='release-info-version';date.id='release-info-date';}
    meta.append(version,date);section.append(meta);
    const list=element('ul','release-info-changes');
    for(const change of release.changes)list.append(element('li','',change));
    section.append(list);dialog.append(section);
  }
  const done=element('button','release-info-done','확인');done.type='button';dialog.append(done);
  let returnFocus=null;
  trigger.addEventListener('click',()=>{
    if(dialog.open)return;
    returnFocus=document.activeElement;dialog.showModal();trigger.setAttribute('aria-expanded','true');
    close.focus({preventScroll:true});
  });
  close.addEventListener('click',()=>dialog.close());done.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;
    const bounds=dialog.getBoundingClientRect();
    if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();
  });
  dialog.addEventListener('close',()=>{
    trigger.setAttribute('aria-expanded','false');
    if(returnFocus?.isConnected&&!returnFocus.inert)returnFocus.focus({preventScroll:true});
  });
  document.body.append(trigger,dialog);document.body.classList.add('release-info-ready');
}

if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountReleaseInfo,{once:true});
  else mountReleaseInfo();
}
