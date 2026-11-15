// Reserve real canvas space for editor chrome; the scene's ResizeObserver updates
// projection and hit testing together without resetting orbit, pan or zoom.
export function mountEditorWorkspace(){
  const header=document.querySelector('.unified-topbar'),dock=document.querySelector('#edit-toolsbar');
  if(!header||!dock)return()=>{};
  let frame=0;
  const set=(name,value)=>{const root=document.documentElement;if(root.style.getPropertyValue(name)!==value)root.style.setProperty(name,value);};
  function measure(){
    frame=0;if(!document.body.classList.contains('editing'))return;
    const gap=8,margin=12;
    const top=Math.ceil(header.getBoundingClientRect().bottom+gap);
    const end=Math.floor(dock.getBoundingClientRect().top-gap),height=Math.max(1,end-top);
    const available=Math.max(1,innerWidth-margin*2),open=document.body.dataset.panel==='edit';
    const stacked=innerWidth<600||(innerWidth<760&&innerHeight>520);
    let x=margin,y=top,w=available,h=height;
    const panelWidth=stacked?available:Math.min(300,Math.max(260,innerWidth*.27));
    const panelHeight=stacked?Math.min(210,Math.floor(height*.38)):height;
    if(open){if(stacked){y+=panelHeight+gap;h=Math.max(1,height-panelHeight-gap);}else{x+=panelWidth+gap;w=Math.max(1,available-panelWidth-gap);}}
    for(const [key,value]of Object.entries({'panel-top':top,'panel-left':margin,'panel-width':panelWidth,'panel-height':panelHeight,'scene-left':x,'scene-top':y,'scene-width':w,'scene-height':h}))set('--editor-'+key,Math.round(value)+'px');
  }
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
  const resize=new ResizeObserver(schedule);resize.observe(header);resize.observe(dock);
  const state=new MutationObserver(schedule);state.observe(document.body,{attributes:true,attributeFilter:['class','data-panel']});
  addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);schedule();
  return()=>{cancelAnimationFrame(frame);resize.disconnect();state.disconnect();removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);};
}
