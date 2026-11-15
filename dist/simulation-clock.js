// Fixed small simulation slices yield the main thread between animation frames.
// Under CPU pressure requested playback speed is best-effort; no warehouse state is skipped.
export class SimulationClock {
  constructor({budgetMs=6,now=()=>performance.now()}={}){this.budgetMs=budgetMs;this.now=now;this.pending=0;this.rate=null;}
  reset(){this.pending=0;this.rate=null;}
  advance(sim,elapsed,rate=1){
    if(!sim.running){this.reset();return 0;}
    if(this.rate!==rate){this.pending=0;this.rate=rate;}
    this.pending=Math.min(Math.min(1,rate*.2),this.pending+Math.max(0,Math.min(.2,elapsed))*rate);
    const started=this.now();let advanced=0;
    while(this.pending>1e-8&&sim.running){const step=Math.min(.05,this.pending);sim.tick(step);this.pending-=step;advanced+=step;if(this.now()-started>=this.budgetMs)break;}
    if(!sim.running)this.reset();return advanced;
  }
}
