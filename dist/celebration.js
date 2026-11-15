/** A finite, silent, local canvas effect. Triggered only by confirmed picking. */
export function createCelebration(canvas) {
  const ctx=canvas?.getContext('2d');
  let animation=0;
  function stop(){cancelAnimationFrame(animation);animation=0;if(canvas){canvas.hidden=true;ctx?.clearRect(0,0,canvas.width,canvas.height);}}
  function play(){
    stop();
    if(!ctx||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    const width=window.innerWidth,height=window.innerHeight,dpr=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);canvas.hidden=false;
    const colors=['#215732','#65894c','#DDEBCB','#e4b75a','#ffffff'];
    const bursts=[{x:.24,y:.34,t:0},{x:.73,y:.27,t:340},{x:.48,y:.2,t:760},{x:.79,y:.51,t:1160}];
    const particles=bursts.flatMap(burst=>Array.from({length:64},(_,index)=>{
      const angle=index/64*Math.PI*2,speed=70+Math.random()*160;
      return{x:width*burst.x,y:height*burst.y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,
        start:burst.t,life:1100+Math.random()*750,color:colors[index%colors.length],size:1.4+Math.random()*2.4};
    }));
    const started=performance.now();
    function draw(now){
      const elapsed=now-started;ctx.clearRect(0,0,width,height);
      for(const p of particles){
        const age=elapsed-p.start;if(age<0||age>p.life)continue;
        const t=age/1000,drag=(1-Math.exp(-t*1.3))/1.3;
        const x=p.x+p.vx*drag,y=p.y+p.vy*drag+54*t*t;
        ctx.globalAlpha=Math.pow(1-age/p.life,.7);ctx.fillStyle=p.color;
        ctx.beginPath();ctx.arc(x,y,p.size,0,Math.PI*2);ctx.fill();
        ctx.globalAlpha*=.25;ctx.strokeStyle=p.color;ctx.lineWidth=p.size*.7;
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x-p.vx*.035*Math.exp(-t),y-(p.vy+100*t)*.035);ctx.stroke();
      }
      ctx.globalAlpha=1;
      if(elapsed<3200)animation=requestAnimationFrame(draw);else stop();
    }
    animation=requestAnimationFrame(draw);
  }
  return {play,stop};
}
