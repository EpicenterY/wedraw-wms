import {initializeRustCore} from './rust-core.js';

try {
  await initializeRustCore();
  document.documentElement.dataset.calculationCore='rust-wasm';
  await import('./app.js');
} catch(error) {
  console.error('Warehouse startup failed',error);
  const dialog=document.createElement('dialog');
  const title=document.createElement('h2');title.textContent='시뮬레이션을 불러오지 못했습니다';
  const message=document.createElement('p');message.textContent='연결을 확인하고 다시 시도해 주세요. 저장된 설계는 그대로 유지됩니다.';
  const retry=document.createElement('button');retry.className='primary-button';retry.textContent='다시 불러오기';retry.onclick=()=>location.reload();
  const close=document.createElement('button');close.className='quiet-button';close.textContent='닫기';close.onclick=()=>dialog.close();
  dialog.addEventListener('click',ev=>{const r=dialog.getBoundingClientRect();if(ev.target===dialog&&(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom))dialog.close();});
  dialog.append(title,message,retry,close);document.body.append(dialog);dialog.showModal();
}
