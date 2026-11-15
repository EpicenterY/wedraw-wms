// Lens displacement only affects the backdrop. Text, logos and hit targets are
// untouched. Maps are rebuilt on resize, never on simulation animation frames.
export function lensMap(width,height,radius){
  const w=Math.max(2,Math.round(width)),h=Math.max(2,Math.round(height)),r=Math.max(1,Math.min(radius,w/2,h/2));
  const pixels=new Uint8ClampedArray(w*h*4),band=Math.min(18,r),scale=28;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const px=x+.5-w/2,py=y+.5-h/2,qx=Math.abs(px)-(w/2-r),qy=Math.abs(py)-(h/2-r);
    const ox=Math.max(qx,0),oy=Math.max(qy,0),length=Math.hypot(ox,oy),distance=length+Math.min(Math.max(qx,qy),0)-r;
    let nx=0,ny=0;
    if(length>0){nx=Math.sign(px)*ox/length;ny=Math.sign(py)*oy/length;}
    else if(qx>qy)nx=Math.sign(px);else ny=Math.sign(py);
    const t=Math.max(0,Math.min(1,-distance/band)),bend=distance<=0&&t<1?Math.sin(Math.PI*t)*10:0,i=(y*w+x)*4;
    pixels[i]=Math.round(255*(.5-nx*bend/scale));pixels[i+1]=Math.round(255*(.5-ny*bend/scale));pixels[i+2]=128;pixels[i+3]=255;
  }
  return {width:w,height:h,pixels,scale};
}
// Bound per-surface raster allocation; large content panels use the CSS glass.
export const MAX_LENS_PIXELS=160000;
export function canRefractSurface(width,height){return width>=2&&height>=2&&width*height<=MAX_LENS_PIXELS;}
export function mountLiquidGlass(){
  const reduced=matchMedia('(prefers-reduced-transparency: reduce)'),ns='http://www.w3.org/2000/svg';
  const root=document.createElementNS(ns,'svg');root.setAttribute('aria-hidden','true');root.setAttribute('width','0');root.setAttribute('height','0');root.style.cssText='position:fixed;pointer-events:none';
  const defs=document.createElementNS(ns,'defs');root.append(defs);document.body.append(root);
  const selector='.glass:not(.floating-panel):not(dialog),.system-status:not(.topbar-status),.release-info-pill',records=new Map();let serial=0;
  // SVG backdrop filters are currently implemented by Chromium. Other engines
  // retain the same clear tint, blur and specular CSS edges without distortion.
  const refract=/Chrome|Chromium|Edg\//.test(navigator.userAgent)&&!/(Firefox|OPR)\//.test(navigator.userAgent);
  const make=(name,attrs)=>{const e=document.createElementNS(ns,name);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,v);return e;};
  function update(element){
    const record=records.get(element),w=element.offsetWidth,h=element.offsetHeight;
    if(!record)return;
    if(reduced.matches||!refract||!canRefractSurface(w,h)){
      record.key=null;element.style.removeProperty('--lens-filter');delete element.dataset.lens;
      record.image.removeAttribute('href');return;
    }
    const radius=parseFloat(getComputedStyle(element).borderTopLeftRadius)||22,key=[w,h,radius].join(':');if(record.key===key)return;record.key=key;
    if(!refract)return;
    const map=lensMap(w,h,radius),canvas=document.createElement('canvas');canvas.width=map.width;canvas.height=map.height;
    canvas.getContext('2d').putImageData(new ImageData(map.pixels,map.width,map.height),0,0);
    record.image.setAttribute('href',canvas.toDataURL());record.image.setAttribute('width',w);record.image.setAttribute('height',h);
    record.filter.setAttribute('width',w);record.filter.setAttribute('height',h);
    element.style.setProperty('--lens-filter',`url(#${record.id})`);element.dataset.lens='ready';
  }
  const resize=new ResizeObserver(entries=>{for(const {target}of entries)update(target);});
  function scan(){
    for(const element of document.querySelectorAll(selector)){
      if(records.has(element))continue;
      const id=`liquid-lens-${++serial}`,filter=make('filter',{id,filterUnits:'userSpaceOnUse',x:0,y:0,'color-interpolation-filters':'sRGB'});
      const image=make('feImage',{x:0,y:0,preserveAspectRatio:'none',result:'lens'});
      filter.append(image,make('feDisplacementMap',{in:'SourceGraphic',in2:'lens',scale:28,xChannelSelector:'R',yChannelSelector:'G'}));defs.append(filter);
      const record={id,filter,image,key:null,shineFrame:0};records.set(element,record);element.classList.add('liquid-surface');resize.observe(element);update(element);
      element.addEventListener('pointermove',e=>{
        if(reduced.matches||e.pointerType==='touch'||!record.key)return;
        record.pointer={x:e.clientX,y:e.clientY};if(record.shineFrame)return;
        record.shineFrame=requestAnimationFrame(()=>{
          record.shineFrame=0;const b=element.getBoundingClientRect();if(!b.width||!b.height)return;
          const x=Math.round((record.pointer.x-b.left)/b.width*100),y=Math.round((record.pointer.y-b.top)/b.height*100);
          if(record.shineX!==x){element.style.setProperty('--shine-x',x+'%');record.shineX=x;}
          if(record.shineY!==y){element.style.setProperty('--shine-y',y+'%');record.shineY=y;}
        });
      },{passive:true});
      element.addEventListener('pointerleave',()=>{cancelAnimationFrame(record.shineFrame);record.shineFrame=0;record.shineX=record.shineY=null;element.style.removeProperty('--shine-x');element.style.removeProperty('--shine-y');},{passive:true});
    }
    for(const [element,r]of records)if(!element.isConnected){cancelAnimationFrame(r.shineFrame);resize.unobserve(element);r.filter.remove();records.delete(element);}
  }
  scan();const observer=new MutationObserver(scan);observer.observe(document.body,{childList:true});
  reduced.addEventListener('change',()=>{for(const [element,record]of records){record.key=null;update(element);}});
  return ()=>{observer.disconnect();resize.disconnect();for(const r of records.values())cancelAnimationFrame(r.shineFrame);root.remove();};
}
if(typeof document!=='undefined'){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountLiquidGlass,{once:true});else mountLiquidGlass();
}
