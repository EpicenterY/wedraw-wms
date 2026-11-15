import {REST_GRIPPER_Y,BELT_ANCHOR_Y} from './robot-motion.js';
/* Dependency-free perspective 3D scene. WebGL with a CPU renderer fallback. */
import {WEDRAW_SYMBOL,WEDRAW_LOGO} from './assets/wedraw-brand-mesh.js';
import {getBinColor} from './bin-colors.js';
import {getPortFootprint,PORT_WALL_M} from './port-footprint.js';
import {getPortSurface,portRoofTiles} from './port-surface.js';
const SX = 0.705, SZ = 0.480;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const V = {
  sub: (a,b) => a.map((v,i)=>v-b[i]),
  dot: (a,b) => a.reduce((s,v,i)=>s+v*b[i],0),
  cross: (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
  norm(a) { const n=Math.hypot(...a)||1; return a.map(v=>v/n); }
};
function multiply(a,b) {
  const r=new Float32Array(16);
  for(let c=0;c<4;c++) for(let y=0;y<4;y++) for(let k=0;k<4;k++) r[c*4+y]+=a[k*4+y]*b[c*4+k];
  return r;
}
function inverse(m) {
  const a=Array.from({length:4},(_,r)=>Array.from({length:8},(_,c)=>c<4?m[c*4+r]:Number(c-4===r)));
  for(let c=0;c<4;c++) {
    let p=c; for(let r=c+1;r<4;r++) if(Math.abs(a[r][c])>Math.abs(a[p][c])) p=r;
    if(Math.abs(a[p][c])<1e-10) return null;
    [a[p],a[c]]=[a[c],a[p]];
    const d=a[c][c]; for(let k=0;k<8;k++) a[c][k]/=d;
    for(let r=0;r<4;r++) if(r!==c) { const f=a[r][c]; for(let k=0;k<8;k++) a[r][k]-=f*a[c][k]; }
  }
  return new Float32Array(Array.from({length:16},(_,i)=>a[i%4][4+Math.floor(i/4)]));
}
function transform(m,p) { return [0,1,2,3].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]*(p[3]??1)); }
function perspective(fovy,aspect,near,far) {
  const f=1/Math.tan(fovy/2), n=1/(near-far);
  return new Float32Array([f/aspect,0,0,0,0,f,0,0,0,0,(far+near)*n,-1,0,0,2*far*near*n,0]);
}
// Fit occupied editor bounds to CSS pixels, independent of grid dimensions.
export function editorTopFit(bounds,width,height,padding=18){
  const w=Math.max(.01,bounds.x1-bounds.x0),d=Math.max(.01,bounds.z1-bounds.z0);
  const pixelsPerMeter=Math.min(Math.max(1,width-padding*2)/w,Math.max(1,height-padding*2)/d);
  return {half:height/(2*pixelsPerMeter),pixelsPerMeter};
}
function orthographic(left,right,bottom,top,near,far) {
  return new Float32Array([2/(right-left),0,0,0,0,2/(top-bottom),0,0,0,0,-2/(far-near),0,
    -(right+left)/(right-left),-(top+bottom)/(top-bottom),-(far+near)/(far-near),1]);
}
function lookAt(eye,target) {
  const z=V.norm(V.sub(eye,target)),x=V.norm(V.cross([0,1,0],z)),y=V.cross(z,x);
  return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-V.dot(x,eye),-V.dot(y,eye),-V.dot(z,eye),1]);
}
function rgb(v,fallback=[0.52,0.65,0.65]) {
  if(Array.isArray(v)) return v.slice(0,3).map(n=>n>1?n/255:n);
  if(typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)) return [1,3,5].map(i=>parseInt(v.slice(i,i+2),16)/255);
  if(typeof v==='string'&&/^#[0-9a-f]{3}$/i.test(v)) return [1,2,3].map(i=>parseInt(v[i]+v[i],16)/255);
  return fallback;
}
function vertex(a,p,n,c) { a.push(...p,...n,...c); }
function quad(a,p,n,c) { for(const i of [0,1,2,0,2,3]) vertex(a,p[i],n,c); }
function cube(a,x,y,z,w,h,d,color) {
  const c=rgb(color), x0=x-w/2,x1=x+w/2,y0=y-h/2,y1=y+h/2,z0=z-d/2,z1=z+d/2;
  quad(a,[[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]],[0,0,1],c);
  quad(a,[[x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0]],[0,0,-1],c);
  quad(a,[[x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1]],[1,0,0],c);
  quad(a,[[x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]],[-1,0,0],c);
  quad(a,[[x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0]],[0,1,0],c);
  quad(a,[[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]],[0,-1,0],c);
}
function cylinder(a,x,y,z,radius,length,axis,sideColor,capColor=sideColor,segments=8) {
  const normal=(theta)=>axis==='x'?[0,Math.cos(theta),Math.sin(theta)]:axis==='z'?[Math.cos(theta),Math.sin(theta),0]:[Math.cos(theta),0,Math.sin(theta)];
  const axisVector=axis==='x'?[1,0,0]:axis==='z'?[0,0,1]:[0,1,0];
  const point=(theta,sign)=>{const n=normal(theta);return [x+n[0]*radius+axisVector[0]*sign*length/2,y+n[1]*radius+axisVector[1]*sign*length/2,z+n[2]*radius+axisVector[2]*sign*length/2];};
  for(let i=0;i<segments;i++) {
    const t=i*Math.PI*2/segments,u=(i+1)*Math.PI*2/segments;
    let p=[point(t,-1),point(u,-1),point(u,1),point(t,1)],n=normal((t+u)/2);
    if(V.dot(V.cross(V.sub(p[1],p[0]),V.sub(p[2],p[0])),n)<0)p=p.reverse();
    quad(a,p,n,rgb(sideColor));
    for(const sign of[-1,1]) {
      const center=[x+axisVector[0]*sign*length/2,y+axisVector[1]*sign*length/2,z+axisVector[2]*sign*length/2];
      let q=[center,point(t,sign),point(u,sign),point(u,sign)],cn=axisVector.map(v=>v*sign);
      if(V.dot(V.cross(V.sub(q[1],q[0]),V.sub(q[2],q[0])),cn)<0)q=[center,q[2],q[1],q[1]];
      quad(a,q,cn,rgb(capColor));
    }
  }
}
const DIGIT_SEGMENTS=['abcdef','bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg'];
function surfaceRect(a,origin,right,up,x,y,w,h,color) {
  const point=(u,v)=>origin.map((n,i)=>n+right[i]*u+up[i]*v),normal=V.cross(right,up);
  quad(a,[point(x-w/2,y-h/2),point(x+w/2,y-h/2),point(x+w/2,y+h/2),point(x-w/2,y+h/2)],normal,rgb(color));
}
function robotNumber(a,id,origin,right,up,width=.33,height=.17,color='#f8f8f3') {
  const text=String(id??'1').replace(/\D/g,'').slice(-3).padStart(3,'0');
  const segments={a:[0,.037,.032,.005],b:[.018,.019,.005,.032],c:[.018,-.019,.005,.032],d:[0,-.037,.032,.005],e:[-.018,-.019,.005,.032],f:[-.018,.019,.005,.032],g:[0,0,.032,.005]};
  const sx=width/.145,sy=height/.079;
  for(let i=0;i<3;i++)for(const s of DIGIT_SEGMENTS[Number(text[i])]){const[dx,dy,w,h]=segments[s];surfaceRect(a,origin,right,up,((i-1)*.052+dx)*sx,dy*sy,w*sx,h*sy,color);}
}
function surfaceBrand(a,brand,origin,right,up,width,ink=null) {
  const height=width/brand.aspect,normal=V.cross(right,up);
  for(const part of brand.parts){const color=rgb(ink||part.color),points=part.quads;
    for(let i=0;i<points.length;i+=8){const p=[];for(let j=0;j<4;j++){const x=points[i+j*2]*width,y=points[i+j*2+1]*height;p.push(origin.map((n,k)=>n+right[k]*x+up[k]*y));}quad(a,p,normal,color);}
  }
}

/** Pure geometry contract: all lengths are metres; x/z identify the hoist cell. */
export function getRobotPose(robot,railY,binHeight=.33) {
  const x=Number(robot.x)*SX,z=Number(robot.z)*SZ,bodySign=robot.bodySign===-1?-1:1;
  const h=robot.hoist||{},rest=railY+REST_GRIPPER_Y;
  const gripperY=Number.isFinite(h.gripperY)?h.gripperY:rest;
  const loaded=!!h.loaded&&!!h.binId,binY=Number.isFinite(h.binY)?h.binY:gripperY-binHeight/2;
  const anchorY=railY+BELT_ANCHOR_Y;
  return {x,z,bodySign,bodyX:x,bodyZ:z+bodySign*SZ,bodyBaseY:railY+.072,bodyTopY:railY+.645,
    anchorY,gripperY,binY,loaded,binId:loaded?h.binId:null,
    belts:[[-.287,-.177],[.287,-.177],[.287,.177],[-.287,.177]].map(([dx,dz])=>({top:[x+dx,anchorY,z+dz],bottom:[x+dx,gripperY+.025,z+dz]}))};
}

/** R5-inspired two-cell chassis. Local y=0 is the rail; local x/z is the hoist cell. */
export function buildRobotGeometry(robot,{wheels=true}={}) {
  const a=[],sign=robot.bodySign===-1?-1:1,bz=sign*SZ,cz=sign*SZ/2;
  const ivory='#ede9df',charcoal='#252b2e',roof='#202628',white='#f8f8f3',green='#215732';
  // The open lower chassis surrounds the bin instead of covering its lift opening.
  for(const dx of[-.328,.328])cube(a,dx,.102,cz,.044,.064,.988,'#303638');
  for(const zz of[-sign*.2325,sign*.7125])cube(a,0,.102,zz,.70,.064,.043,'#303638');
  cube(a,0,.108,sign*.245,.65,.068,.038,'#343c3d');
  // Warm light panels sit between the dark structural frame and upper cover.
  // Brand green is confined to printed marks and the small status indicator.
  cube(a,0,.357,bz,.661,.474,.454,ivory);
  cube(a,0,.596,bz,.676,.048,.472,charcoal);
  cube(a,0,.631,bz,.63,.018,.422,roof);
  // Black top beams project over the neighbouring lift cell.
  for(const dx of[-.316,.316])cube(a,dx,.582,cz,.05,.06,.94,'#31393b');
  cube(a,0,.582,-sign*.202,.67,.06,.05,'#31393b');
  cube(a,0,.579,sign*.206,.66,.052,.048,'#30383a');
  // A pair of short supports joins the drive housing and cantilever.
  for(const dx of[-.31,.31])cube(a,dx,.349,sign*.222,.042,.47,.036,'#454e50');
  if(wheels)appendTranslated(a,buildRobotWheelGeometry(robot),0,0,0);
  cube(a,0,.365,bz+sign*.235,.44,.225,.008,charcoal);
  robotNumber(a,robot.id,[0,.365,bz+sign*.241],[sign,0,0],[0,1,0],.35,.18,white);
  // Large identifiers are decals on physical roof / side surfaces, not billboards.
  robotNumber(a,robot.id,[0,.6425,bz],[1,0,0],[0,0,-1],.42,.22,white);
  // Opposite sides have one identifier each: number on the left, symbol on the right.
  robotNumber(a,robot.id,[-.3325,.365,bz],[0,0,1],[0,1,0],.31,.17,charcoal);
  surfaceBrand(a,WEDRAW_SYMBOL,[.3327,.365,bz],[0,0,-1],[0,1,0],.22,green);
  // A small stop button and antenna, placed on the fixed drive housing.
  cylinder(a,.213,.614,bz+.125,.029,.015,'y','#ebc342','#f3d260',8);
  cylinder(a,.213,.632,bz+.125,.018,.018,'y','#ab1d20','#df3837',8);
  cube(a,-.337,.615,bz-.12,.012,.060,.012,'#252d30');
  cube(a,.18,.642,bz-.105,.044,.006,.039,'#9fd0bd');
  return new Float32Array(a);
}
export function buildRobotWheelGeometry(robot){
  const a=[],sign=robot.bodySign===-1?-1:1,w=robot.wheels||{};
  for(const xx of[-.329,.329])for(const zz of[-sign*.15,sign*.60])
    cylinder(a,xx,.116+(w.liftZ||0),zz,.072,.038,'x','#3c4244','#b9c5ca',10);
  for(const xx of[-.245,.245])for(const zz of[-sign*.221,sign*.701])
    cylinder(a,xx,.113+(w.liftX||0),zz,.069,.038,'z','#3c4244','#c3ccd0',10);
  return new Float32Array(a);
}
/** Solid hoist head, in local metres with its underside at the bin rim. */
export function buildGripperGeometry({loaded=false}={}) {
  const a=[];
  cube(a,0,.019,0,.614,.038,.399,'#788489');
  // Recessed seams and corner fasteners leave the centre a closed steel plate.
  for(const dz of[-.174,.174])cube(a,0,.039,dz,.55,.002,.004,'#536166');
  for(const dx of[-.283,.283])for(const dz of[-.176,.176]){
    cube(a,dx,.040,dz,.016,.004,.016,'#cbd3d5');
    cube(a,dx,-.008,dz,.024,.032,.022,loaded?'#cf9e47':'#7f8b8f');
  }
  surfaceBrand(a,WEDRAW_SYMBOL,[0,.0405,0],[1,0,0],[0,0,-1],.205,'#f8f8f3');
  return new Float32Array(a);
}
function appendTranslated(a,source,x,y,z) {
  for(let i=0;i<source.length;i+=9)a.push(source[i]+x,source[i+1]+y,source[i+2]+z,source[i+3],source[i+4],source[i+5],source[i+6],source[i+7],source[i+8]);
}
/** Nominal dimensions from AutoStore's published Bin technical sheet. */
export function getBinDimensions(height=.33) {
  const innerDepth=Math.abs(height-.22)<.002?.202:Math.abs(height-.425)<.002?.404:.312;
  return {length:.649,width:.449,height,insideLength:.603,insideWidth:.403,insideDepth:innerDepth};
}
function hardwareSample(a,x,y,z,w,d,category,index) {
  // Illustrative SKU silhouettes, not measurements of the dummy catalogue.
  const metal='#9b9fa1',dark='#686f72',size=Math.min(w,d),length=Math.min(w*.76,.15);
  if(/피스|연결|다보|받침/.test(category)) {
    const r=Math.min(.006,size*.065),len=Math.min(.043,w*.6);
    cylinder(a,x,y+r,z,r*.48,len,'x',metal,metal,6);
    cylinder(a,x-len/2,y+r,z,r,.004,'x',dark,metal,6);
  }else if(/경첩/.test(category)) {
    cube(a,x,y+.004,z,Math.min(.054,w*.7),.008,Math.min(.025,d*.6),metal);
    cylinder(a,x-Math.min(.015,w*.18),y+.009,z,Math.min(.013,size*.18),.010,'y',dark,metal,8);
    cube(a,x+Math.min(.018,w*.2),y+.014,z,Math.min(.028,w*.3),.008,Math.min(.017,d*.4),metal);
  }else if(/브래킷/.test(category)) {
    const ww=Math.min(.055,w*.72),dd=Math.min(.035,d*.7);
    cube(a,x,y+.003,z,ww,.006,dd,metal);cube(a,x-ww/2+.003,y+.018,z,.006,.034,dd,metal);
    cylinder(a,x+.011,y+.0065,z,.004,.001,'y','#51575b','#51575b',6);
  }else if(/손잡이/.test(category)) {
    for(const s of[-1,1])cube(a,x+s*length*.39,y+.012,z,.008,.024,.012,dark);
    cylinder(a,x,y+.025,z,.005,length,'x',dark,metal,6);
  }else if(/레일/.test(category)) {
    cube(a,x,y+.004,z,length,.008,Math.min(.025,d*.55),metal);
    cube(a,x,y+.009,z,length*.84,.004,Math.min(.013,d*.33),'#767f83');
  }else if(/다리|레벨러/.test(category)) {
    const r=Math.min(.014,size*.2);cylinder(a,x,y+.004,z,r,.008,'y',dark,dark,8);
    cylinder(a,x,y+.020,z,.004,.028,'y',metal,metal,6);
  }else {
    const ww=Math.min(.032,w*.55),dd=Math.min(.025,d*.55);
    cube(a,x,y+.009,z,ww,.018,dd,index%2?'#a4a7a4':'#626966');
  }
}
/** Empty-walled bin with a real floor and nominal outer/inner envelope. */
export function buildBinGeometry(bin={},height=.33,{detail='high',contents=true}={}) {
  const a=[],dim=getBinDimensions(height),bottom=-height/2,top=height/2;
  const plastic=rgb(bin.color||getBinColor(bin.id)),rim=plastic.map(c=>c*.48),inside=plastic.map(c=>c*.72+.28),floor=plastic.map(c=>c*.88+.12),rib=plastic.map(c=>c*.82);
  const floorY=top-dim.insideDepth,floorThickness=Math.max(.012,floorY-bottom);
  if(detail==='low') {
    cube(a,0,-.008,0,.633,height-.016,.433,plastic);
    const p=[[-.3245,top,.2245],[.3245,top,.2245],[.3245,top,-.2245],[-.3245,top,-.2245]],normals=[[0,0,1],[1,0,0],[0,0,-1],[-1,0,0]];
    quad(a,p,[0,1,0],rgb(rim));
    for(let i=0;i<4;i++){const j=(i+1)%4;quad(a,[[p[i][0],top-.016,p[i][2]],[p[j][0],top-.016,p[j][2]],p[j],p[i]],normals[i],rgb(rim));}
    return new Float32Array(a);
  }
  if(detail==='medium') {
    // Four outer faces, four inner faces, a real floor and a four-sided rim.
    // This hollow LOD avoids dozens of hidden cube faces per stored bin.
    const ring=(x,z,y)=>[[-x,y,z],[x,y,z],[x,y,-z],[-x,y,-z]];
    const ot=ring(.3245,.2245,top),lip=ring(.3245,.2245,top-.016),ob=ring(.3165,.2165,bottom),it=ring(.3015,.2015,top),ib=ring(.3015,.2015,floorY),normals=[[0,0,1],[1,0,0],[0,0,-1],[-1,0,0]];
    for(let i=0;i<4;i++){const j=(i+1)%4;quad(a,[ob[i],ob[j],lip[j],lip[i]],normals[i],plastic);quad(a,[lip[i],lip[j],ot[j],ot[i]],normals[i],rim);quad(a,[ib[j],ib[i],it[i],it[j]],normals[i].map(v=>-v),inside);quad(a,[ot[i],ot[j],it[j],it[i]],[0,1,0],rim);}
    quad(a,ib,[0,1,0],floor);quad(a,[ob[3],ob[2],ob[1],ob[0]],[0,-1,0],rib);
    return new Float32Array(a);
  }
  cube(a,0,bottom+floorThickness/2,0,.627,floorThickness,.427,floor);
  const wallBottom=bottom+.006,wallTop=top-.006,wallY=(wallBottom+wallTop)/2,wallH=wallTop-wallBottom;
  for(const x of[-.3075,.3075])cube(a,x,wallY,0,.012,wallH,.427,plastic);
  for(const z of[-.2075,.2075])cube(a,0,wallY,z,.603,wallH,.012,plastic);
  for(const z of[-.213,.213])cube(a,0,top-.007,z,.649,.014,.023,rim);
  for(const x of[-.313,.313])cube(a,x,top-.007,0,.023,.014,.403,rim);
  if(detail==='high') {
    // Darker ribs and stacking skirts separate bins without changing their envelope.
    for(const z of[-.219,.219])for(const x of[-.27,-.18,-.09,0,.09,.18,.27])
      cube(a,x,(bottom+top-.045)/2,z,.009,height-.045,.011,rib);
    for(const x of[-.319,.319])for(const z of[-.16,-.08,0,.08,.16])
      cube(a,x,(bottom+top-.045)/2,z,.011,height-.045,.009,rib);
    for(const z of[-.213,.213])cube(a,0,bottom+.014,z,.639,.018,.018,rim);
    for(const x of[-.308,.308])for(const z of[-.15,-.05,.05,.15])
      cube(a,x,top-.0008,z,.009,.0015,.023,'#606966');
    // Surface label / barcode; no through-wall carrying-handle holes are invented.
    cube(a,-.19,top-.056,.220,.103,.034,.0015,'#f0f1eb');
    const seed=String(bin.id||'B0000').split('').reduce((n,c)=>n*31+c.charCodeAt(0),7)>>>0;
    for(let i=0;i<20;i++)if((seed>>>(i%30)&1)||i%3===0)
      cube(a,-.236+i*.0045,top-.056,.221,.0018,.025,.001,'#4f5953');
  }
  const count=[1,4,8,16,32].includes(+bin.compartments)?+bin.compartments:4;
  const cols=count===1?1:count===4?2:count===8?4:count===16?4:8,rows=count/cols,cw=.603/cols,cd=.403/rows;
  if(contents&&detail==='high') {
    // SKU allocation positions remain logical; the physical bin has one open interior.
    const stored=Array.isArray(bin.contents)?bin.contents:bin.category?[{category:bin.category,qty:bin.qty??4,compartment:1}]:[];
    for(const item of stored){
      if(!(item.qty>0))continue;const cell=clamp((item.compartment||1)-1,0,count-1),cx=-.3015+(cell%cols+.5)*cw,cz=-.2015+(Math.floor(cell/cols)+.5)*cd;
      const n=Math.min(4,item.qty);
      for(let k=0;k<n;k++)hardwareSample(a,cx+(k%2-.5)*cw*.4,floorY+.003+Math.floor(k/2)*.005,cz+(Math.floor(k/2)-.5)*cd*.38,cw*.43,cd*.43,String(item.category||bin.category||''),k);
    }
  }
  return new Float32Array(a);
}
function line(a,p,q,color) { const c=rgb(color);vertex(a,p,[0,0,0],c);vertex(a,q,[0,0,0],c); }
function rect(a,x,z,y,w,d,color) {
  const p=[[x-w/2,y,z-d/2],[x+w/2,y,z-d/2],[x+w/2,y,z+d/2],[x-w/2,y,z+d/2]];
  for(let i=0;i<4;i++) line(a,p[i],p[(i+1)%4],color);
}
// Deliberate structural edges keep the inspection view clear. Converting every
// triangle to wireframe would expose diagonal tessellation and multiply work.
function wireBox(a,x,y,z,w,h,d,color) {
  rect(a,x,z,y-h/2,w,d,color);rect(a,x,z,y+h/2,w,d,color);
  for(const dx of[-1,1])for(const dz of[-1,1])line(a,[x+dx*w/2,y-h/2,z+dz*d/2],[x+dx*w/2,y+h/2,z+dz*d/2],color);
}
function wireCircle(a,x,y,z,r,axis,color,segments=10) {
  const point=t=>axis==='x'?[x,y+Math.cos(t)*r,z+Math.sin(t)*r]:axis==='z'?[x+Math.cos(t)*r,y+Math.sin(t)*r,z]:[x+Math.cos(t)*r,y,z+Math.sin(t)*r];
  for(let i=0;i<segments;i++)line(a,point(i*Math.PI*2/segments),point((i+1)*Math.PI*2/segments),color);
}
function segmentBox(a,p,q,width,height,color) {
  const dx=q[0]-p[0],dz=q[2]-p[2],len=Math.hypot(dx,dz); if(!len)return;
  const ux=-dz/len*width/2,uz=dx/len*width/2,y=p[1];
  quad(a,[[p[0]+ux,y,p[2]+uz],[q[0]+ux,y,q[2]+uz],[q[0]-ux,y,q[2]-uz],[p[0]-ux,y,p[2]-uz]],[0,1,0],rgb(color));
}
function beamBetween(a,p,q,width,height,color) {
  const dx=q[0]-p[0],dz=q[2]-p[2],length=Math.hypot(dx,dz);if(length<.0001)return;
  const u=[dx/length,0,dz/length],n=[-u[2],0,u[0]],y=(p[1]+q[1])/2;
  const v=[[p[0]+n[0]*width/2,p[2]+n[2]*width/2],[q[0]+n[0]*width/2,q[2]+n[2]*width/2],[q[0]-n[0]*width/2,q[2]-n[2]*width/2],[p[0]-n[0]*width/2,p[2]-n[2]*width/2]];
  const lower=v.map(([x,z])=>[x,y-height/2,z]),upper=v.map(([x,z])=>[x,y+height/2,z]),c=rgb(color);
  quad(a,upper,[0,1,0],c);quad(a,[lower[3],lower[2],lower[1],lower[0]],[0,-1,0],c);
  const normals=[n,u,n.map(v=>-v),u.map(v=>-v)];
  for(let i=0;i<4;i++){const j=(i+1)%4;quad(a,[lower[i],lower[j],upper[j],upper[i]],normals[i],c);}
}

/** Convert the port visual contract's grid x/z coordinates into world metres. */
export function getPortLayout(port,{width=12,depth=8,binHeight=.33,portBaseY=.96-binHeight}={}) {
  const l=port.layout||{},x=Number(port.x)||0,z=Number(port.z)||0;
  const edges=[[x*SX,-1,0],[(width-1-x)*SX,1,0],[z*SZ,0,-1],[(depth-1-z)*SZ,0,1]].sort((a,b)=>a[0]-b[0]);
  const outX=Number.isFinite(l.outX)?l.outX:edges[0][1],outZ=Number.isFinite(l.outZ)?l.outZ:edges[0][2];
  const intake=[(Number.isFinite(l.intakeX)?l.intakeX:x)*SX,(Number.isFinite(l.intakeZ)?l.intakeZ:z)*SZ];
  const type=port.type==='buffer3'?'buffer3':'single',radius=Number.isFinite(l.radiusM)?l.radiusM:.47;
  const hub=[Number.isFinite(l.hubX)?l.hubX*SX:intake[0]+outX*.95,Number.isFinite(l.hubZ)?l.hubZ*SZ:intake[1]+outZ*.95];
  const work=[Number.isFinite(l.workX)?l.workX*SX:hub[0]+outX*radius,Number.isFinite(l.workZ)?l.workZ*SZ:hub[1]+outZ*radius];
  const baseY=Number.isFinite(port.binBaseY)?port.binBaseY:portBaseY;
  const angle=Number.isFinite(l.angle)?l.angle:Number(port.angle)||0;
  const slots=Array.from({length:type==='buffer3'?3:1},(_,i)=>{
    const raw=(port.slots||[]).find(s=>(s.index??s.slotIndex)===i)||(port.slots||[])[i]||{},t=i*Math.PI*2/3+angle;
    const px=hub[0]+outX*Math.cos(t)*radius-outZ*Math.sin(t)*radius,pz=hub[1]+outZ*Math.cos(t)*radius+outX*Math.sin(t)*radius;
    return {...raw,index:i,x:Number.isFinite(raw.x)?raw.x*SX:type==='single'?intake[0]:px,z:Number.isFinite(raw.z)?raw.z*SZ:type==='single'?intake[1]:pz,binY:Number.isFinite(raw.binY)?raw.binY:baseY+binHeight/2};
  });
  const shafts=(l.shafts||port.shafts||[{x,z,index:0}]).map((s,i)=>{
    const v=typeof s==='string'?{x:+s.split(',')[0],z:+s.split(',')[1]}:s;
    return {...v,index:v.index??i,x:(Number.isFinite(v.x)?v.x:x)*SX,z:(Number.isFinite(v.z)?v.z:z)*SZ};
  });
  const origin=[Number.isFinite(l.originX)?l.originX*SX:shafts.reduce((n,s)=>n+s.x,0)/shafts.length,Number.isFinite(l.originZ)?l.originZ*SZ:shafts.reduce((n,s)=>n+s.z,0)/shafts.length];
  const station=l.station||port.station||{},ww=station.widthM??(type==='buffer3'?2.114:1.10),dd=station.depthM??(type==='buffer3'?1.137:.82);
  const workPoint=type==='single'?intake:work,workV=(workPoint[0]-origin[0])*outX+(workPoint[1]-origin[1])*outZ;
  const front=station.frontOffsetM??workV+(outX?.649:.449)/2+.18,rear=station.rearOffsetM??front-dd;
  const equipment=(l.equipmentCells||port.equipmentCells||[]).map(c=>typeof c==='string'?{x:+c.split(',')[0],z:+c.split(',')[1]}:c);
  return {id:port.id,type,outX,outZ,intake,hub:type==='single'?intake:hub,work:workPoint,baseY,angle,slots,shafts,origin,equipmentCells:equipment,radius,
    station:{...station,widthM:ww,depthM:dd,workHeightM:station.workHeightM??baseY+binHeight,frontOffsetM:front,rearOffsetM:rear}};
}
/** Fit from the operator side. Opposite sides fall back to the main port. */
export function getPortFacingYaw(data,{oblique=true}={}) {
  const all=(data.ports||[]),active=all.filter(p=>p.operational!==false),ports=(active.length?active:all).slice().sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  if(!ports.length)return .86;
  const directions=ports.map(p=>{const q=getPortLayout(p,data);return {x:q.outX,z:q.outZ,weight:p.type==='buffer3'?3:1};});
  let x=0,z=0;for(const d of directions){x+=d.x*d.weight;z+=d.z*d.weight;}
  if(Math.hypot(x,z)<.001){const main=directions.reduce((a,b)=>b.weight>a.weight?b:a);x=main.x;z=main.z;}
  return Math.atan2(z,x)+(oblique?.24:0);
}
/** A fixed imager looks into the pick volume, outside every bin/hoist sweep. */
export function getBarcodeReaderPose(port,options={}) {
  const q=getPortLayout(port,options),wh=q.station.workHeightM;
  const workU=(q.work[0]-q.origin[0])*(-q.outZ)+(q.work[1]-q.origin[1])*q.outX;
  const workV=(q.work[0]-q.origin[0])*q.outX+(q.work[1]-q.origin[1])*q.outZ;
  const w=q.outX?.455:.655,d=q.outX?.655:.455,single=q.type==='single';
  const u=workU-w/2-(single?.065:.16),v=workV+(single?d/2+.135:.34),p=stationPoint(q,u,v);
  const lens=[p[0],wh+.355,p[1]],target=[q.work[0]+q.outX*.10,wh+.24,q.work[1]+q.outZ*.10];
  const normal=V.norm(V.sub(target,lens)),right=V.norm(V.cross([0,1,0],normal)),up=V.cross(normal,right);
  return {u,v,lens,target,normal,right,up};
}
function orientedBox(a,center,right,up,normal,w,h,d,color) {
  const c=rgb(color);
  for(const [axis,u,v,extent,uw,vh]of [[normal,right,up,d,w,h],[right,up,normal,w,h,d],[up,normal,right,h,d,w]])
    for(const sign of[-1,1]){
      const at=center.map((n,i)=>n+axis[i]*extent*sign/2);
      const pts=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>at.map((n,i)=>n+u[i]*x*uw/2+v[i]*y*vh/2));
      if(sign<0)pts.reverse();quad(a,pts,axis.map(n=>n*sign),c);
    }
}
function barcodeReaderGeometry(a,port,options={}) {
  const q=getPortLayout(port,options),r=getBarcodeReaderPose(port,options),wh=q.station.workHeightM;
  stationCube(a,q,r.u,wh+.045,r.v,.084,.026,.084,'#46514e');
  stationCube(a,q,r.u,wh+.19,r.v,.026,.29,.026,'#899497');
  const centre=r.lens.map((n,i)=>n-r.normal[i]*.036);
  orientedBox(a,centre,r.right,r.up,r.normal,.096,.071,.072,'#303b40');
  surfaceRect(a,r.lens,r.right,r.up,0,0,.078,.051,'#0e2029');
  surfaceRect(a,r.lens.map((n,i)=>n+r.normal[i]*.001),r.right,r.up,0,0,.047,.018,'#6a2832');
  surfaceRect(a,r.lens.map((n,i)=>n+r.normal[i]*.002),r.right,r.up,.030,.018,.009,.005,'#87a49b');
}
/** Repeat the lift/scan/exit cycle once for each requested unit.
 * Unit phase derives from actual request progress, including pause/time changes. */
export function getPickingPoses(port,{width=12,depth=8,binHeight=.33,reducedMotion=false}={}) {
  if(port.operational===false||port.presentation?.pickAllowed!==true||port.aperture?.openness<.99||port.aperture?.state!=='open')return [];
  const b=(port.bins||[]).find(b=>(b.id||b.binId)===port.presentation.binId&&b.status==='picking');
  if(!b||!Number.isFinite(b.x)||!Number.isFinite(b.z)||!Number.isFinite(b.progress)||b.progress<0||b.progress>=1)return [];
  const quantity=Math.max(1,Math.floor(b.pickQuantity||1)),unitProgress=b.progress*quantity;
  const unitIndex=Math.min(quantity-1,Math.floor(unitProgress));
  const q=getPortLayout(port,{width,depth,binHeight}),u=reducedMotion?.58:unitProgress-unitIndex;
  const smooth=v=>{v=clamp(v,0,1);return v*v*v*(v*(v*6-15)+10);};
  const rim=(Number.isFinite(b.binY)?b.binY:q.baseY+binHeight/2)+binHeight/2;
  const lift=smooth(u/.32),present=smooth((u-.28)/.14),away=smooth((u-.72)/.28);
  const distance=.10*present+(q.station.frontOffsetM-((q.work[0]-q.origin[0])*q.outX+(q.work[1]-q.origin[1])*q.outZ)+.31)*away;
  const stage=u<.32?'lifting':u<.44?'presenting':u<.60?'scanning':u<.72?'confirmed':'leaving';
  return [{binId:b.id||b.binId,unitIndex,quantity,x:b.x*SX+q.outX*distance,y:rim-.11+.35*lift+.08*away,z:b.z*SZ+q.outZ*distance,size:1,stage,scan:clamp((u-.44)/.16,0,1)}];
}
export function buildPickingGeometry(port,options={}) {
  const a=[],q=getPortLayout(port,options),r=getBarcodeReaderPose(port,options);
  for(const p of getPickingPoses(port,options)){
    // The barcode face keeps a fixed orientation toward the reader.
    const normal=V.norm([r.lens[0]-r.target[0],0,r.lens[2]-r.target[2]]),up=[0,1,0],right=V.cross(up,normal);
    const center=[p.x,p.y,p.z],face=center.map((n,i)=>n+normal[i]*.046);
    orientedBox(a,center,right,up,normal,.130,.085,.090,'#d9c6a3');
    surfaceRect(a,[p.x,p.y+.043,p.z],right,normal.map(n=>-n),0,0,.026,.09,'#ac9878');
    surfaceRect(a,face,right,up,0,0,.094,.059,'#f7f6ee');
    const ink=face.map((n,i)=>n+normal[i]*.001);
    let offset=-.038;
    for(const units of[1,1,2,1,3,1,2,2,1,1,3,2,1]){const w=units*.0018;surfaceRect(a,ink,right,up,offset+w/2,.003,w,.037,'#283137');offset+=w+.0024;}
    surfaceRect(a,ink,right,up,0,-.023,.054,.003,'#66716e');
    if(p.stage==='scanning'||p.stage==='confirmed'){
      const color=p.stage==='confirmed'?'#58bd89':'#ed655d';
      surfaceRect(a,r.lens.map((n,i)=>n+r.normal[i]*.003),r.right,r.up,0,0,.047,.018,color);
      surfaceRect(a,r.lens.map((n,i)=>n+r.normal[i]*.004),r.right,r.up,.030,.018,.009,.005,color);
      if(p.stage==='scanning'){
        const y=.020-.040*p.scan;
        surfaceRect(a,ink.map((n,i)=>n+normal[i]*.001),right,up,0,y,.090,.0025,color);
        // Two thin rays end on the actual label; no sheet through the cabinet.
        for(const sign of[-1,1]){
          const target=ink.map((n,i)=>n+right[i]*sign*.044+up[i]*y),delta=V.sub(target,r.lens),length=Math.hypot(...delta),dir=V.norm(delta);
          const lateral=V.norm(V.cross(dir,[0,1,0])),vertical=V.cross(dir,lateral),mid=r.lens.map((n,i)=>(n+target[i])/2);
          orientedBox(a,mid,lateral,vertical,dir,.0015,.0015,length,'#d87870');
        }
      }else{
        // A compact confirmation mark, attached to the label.
        surfaceRect(a,ink.map((n,i)=>n+normal[i]*.002),right,up,.039,-.021,.009,.009,color);
      }
    }
  }
  return new Float32Array(a);
}
function stationPoint(q,u,v) {return [q.origin[0]-q.outZ*u+q.outX*v,q.origin[1]+q.outX*u+q.outZ*v];}
function stationCube(a,q,u,y,v,w,h,d,color) {
  const p=stationPoint(q,u,v);cube(a,p[0],y,p[1],q.outX?d:w,h,q.outX?w:d,color);
}
// Small radiused service panels: an inset face and a real bevel catch light
// without enlarging the installation envelope or touching the bin sweep.
function stationPanel(a,q,u,y,v,w,h,color,r=.018){
  const right=[q.outZ,0,-q.outX],up=[0,1,0],normal=[q.outX,0,q.outZ],center=stationPoint(q,u,v);
  const loop=(inset,depth)=>{
    const points=[],hw=w/2-inset,hh=h/2-inset,rad=Math.max(.002,r-inset);
    for(const [cx,cy,start] of [[hw-rad,hh-rad,0],[-hw+rad,hh-rad,90],[-hw+rad,-hh+rad,180],[hw-rad,-hh+rad,270]])
      for(let j=0;j<=3;j++){const t=(start+j*30)*Math.PI/180,x=cx+rad*Math.cos(t),z=cy+rad*Math.sin(t);points.push([center[0]+right[0]*x+normal[0]*depth,y+z,center[1]+right[2]*x+normal[2]*depth]);}
    return points;
  };
  const outer=loop(0,0),inner=loop(.004,.004),c=rgb(color);
  const origin=[center[0]+normal[0]*.004,y,center[1]+normal[2]*.004];
  for(let i=0;i<inner.length;i++){const j=(i+1)%inner.length;
    quad(a,[origin,inner[i],inner[j],inner[j]],normal,c);
    const face=[outer[i],outer[j],inner[j],inner[i]],n=V.norm(V.cross(V.sub(face[1],face[0]),V.sub(face[2],face[0])));
    quad(a,face,n,rgb('#d6d8db'));
  }
}
function stationBrand(a,q){
  const wh=q.station.workHeightM,right=[q.outZ,0,-q.outX],up=[0,1,0];
  const place=(u,width,brand)=>{const p=stationPoint(q,u,q.station.frontOffsetM+.012);surfaceBrand(a,brand,[p[0],wh*.53,p[1]],right,up,width,'#215732');};
  // The official horizontal lockup already contains both symbol and wordmark.
  place(0,q.type==='single'?.52:.64,WEDRAW_LOGO);
}
function stationFrontDetails(a,q){
  const s=q.station,wh=s.workHeightM;
    // Separate satin doors, narrow shadow gaps and recessed pulls.
    const doors=q.type==='buffer3'?3:2,panelW=(s.widthM-.04)/doors;
    for(let i=0;i<doors;i++) {
      const u=(i-(doors-1)/2)*panelW;
      stationPanel(a,q,u,(wh+.14)/2,s.frontOffsetM+.003,panelW-.012,wh-.21,'#f6f6f7');
      stationCube(a,q,u+panelW*.30,wh*.64,s.frontOffsetM+.009,.024,.106,.008,'#a5aab0');
      stationCube(a,q,u+panelW*.30,wh*.64,s.frontOffsetM+.014,.012,.078,.006,'#53565a');
      // Lower ventilation slots are on the exterior face, below the work path.
      if(i===doors-1)for(let k=0;k<5;k++)stationCube(a,q,u,wh*.28+k*.017,s.frontOffsetM+.009,panelW*.46,.004,.003,'#b7bcc2');
    }
}
function stationLimits(q) {
  return getPortFootprint(q).bounds;
}
export function getStationEnvelope(port,options={}) {
  const q=getPortLayout(port,options);
  return {layout:q,...getPortFootprint(q)};
}
/** Presentation is a visibility layer. All inventory remains owned by the engine. */
export function getVisiblePortBins(port,{stationInterior=false}={}) {
  const bins=port.bins||[];if(stationInterior)return bins;
  const aperture=port.aperture||{},presented=port.presentation?.binId??port.presentedBinId??null;
  if((aperture.openness??(port.activeRequestId?1:0))<=.001||!presented)return [];
  return bins.filter(b=>(b.id||b.binId)===presented).slice(0,1);
}
/** Public furniture dimensions + explicitly modelled rear integration enclosure.
 * The rear installation envelope is not claimed to be a published OEM CAD size. */
export const PORT_COVER_OPACITY=.95;
export function buildStationTopGeometry(port,{width=12,depth=8,binHeight=.33}={}){
  const a=[],q=getPortLayout(port,{width,depth,binHeight}),wh=q.station.workHeightM;
    const holes=[{minX:q.work[0]-.3275,maxX:q.work[0]+.3275,minZ:q.work[1]-.2275,maxZ:q.work[1]+.2275},...q.shafts.map(p=>({minX:p.x-.3275,maxX:p.x+.3275,minZ:p.z-.2275,maxZ:p.z+.2275}))];
    const surface=getPortSurface(q),top=wh+.032,bottom=wh+.004;
    for(const tile of portRoofTiles(surface.edges,holes)){
      const points=tile.map(p=>[p[0],top,p[1]]);
      quad(a,[points[3],points[2],points[1],points[0]],[0,1,0],rgb('#c7cbd0'));
      quad(a,tile.map(p=>[p[0],bottom,p[1]]),[0,-1,0],rgb('#a6adb5'));
    }

  return new Float32Array(a);
}
export function buildStationGeometry(port,{width=12,depth=8,binHeight=.33,railY=2.64,stationInterior=false,topCover=true}={}) {
  const a=[],q=getPortLayout(port,{width,depth,binHeight}),s=q.station,wh=s.workHeightM;
  const bodyV=(s.frontOffsetM+s.rearOffsetM)/2,bodyD=s.frontOffsetM-s.rearOffsetM;
  const workU=(q.work[0]-q.origin[0])*(-q.outZ)+(q.work[1]-q.origin[1])*q.outX,workV=(q.work[0]-q.origin[0])*q.outX+(q.work[1]-q.origin[1])*q.outZ;
  const holeW=q.outX?.455:.655,holeD=q.outX?.655:.455,shell='#e5e6e8',green='#215732';
  // Recessed plinth and adjustable feet are below the operator-facing cabinet.
  stationCube(a,q,0,.065,bodyV,s.widthM-.10,.13,bodyD-.08,'#3f4742');
  for(const u of[-1,1])for(const v of[-1,1])stationCube(a,q,u*(s.widthM/2-.08),.026,bodyV+v*(bodyD/2-.08),.09,.052,.09,'#333a35');
  if(!stationInterior) {
    stationCube(a,q,0,wh-.045,s.frontOffsetM+.001,s.widthM,.018,.012,'#aeb3b9');
    stationFrontDetails(a,q);
    stationBrand(a,q);
    const lip=q.type==='single'?.008:.026;
    for(const du of[-1,1])stationCube(a,q,workU+du*(holeW/2+lip/2),wh+.028,workV,lip,.026,holeD+lip*2,'#39453d');
    for(const dv of[-1,1])stationCube(a,q,workU,wh+.028,workV+dv*(holeD/2+lip/2),holeW,.026,lip,'#39453d');
  } else {
    // Inspection deliberately removes cladding, exposing the same mechanism.
    for(const u of[-1,1])for(const v of[-1,1])stationCube(a,q,u*(s.widthM/2-.04),wh/2,bodyV+v*(bodyD/2-.04),.045,wh,.045,'#606b63');
  }
  // Opaque rear integration joins the front as one unobstructed inner volume.
  const envelope=getStationEnvelope(port,{width,depth,binHeight});
  if(!stationInterior){
    const surface=getPortSurface(q),top=wh+.032;
    if(topCover)appendTranslated(a,buildStationTopGeometry(port,{width,depth,binHeight}),0,0,0);
    const normalAt=(p,n)=>{
      const neighbor=surface.edges.find(e=>e.normal!==n&&[e.a,e.b].some(v=>Math.hypot(v[0]-p[0],v[1]-p[1])<1e-7)&&e.normal[0]*n[0]+e.normal[1]*n[1]>.98);
      if(!neighbor)return n;const x=n[0]+neighbor.normal[0],z=n[1]+neighbor.normal[1],length=Math.hypot(x,z);return [x/length,z/length];
    };
    for(const edge of surface.edges){
      const {a:p,b:r,normal:n}=edge,np=normalAt(p,n),nr=normalAt(r,n);
      const outer=[[p[0],.12,p[1]],[r[0],.12,r[1]],[r[0],top,r[1]],[p[0],top,p[1]]];
      const normals=[[np[0],0,np[1]],[nr[0],0,nr[1]],[nr[0],0,nr[1]],[np[0],0,np[1]]];
      for(const j of[0,3,2,0,2,1])vertex(a,outer[j],normals[j],rgb(shell));
      // The single lift well has only the shaft envelope at its rear corners.
      // Its 10mm sheet liner clears the 649 × 449mm bin in that narrow neck.
      const thickness=q.type==='single'?.010:PORT_WALL_M;
      const inner=outer.map(v=>[v[0]-n[0]*thickness,v[1],v[2]-n[1]*thickness]);
      quad(a,[inner[0],inner[1],inner[2],inner[3]],[-n[0],0,-n[1]],rgb('#b6bdc5'));
    }
  }
  // Rear shafts stay open vertically and retain their real grid/robot alignment.
  for(const shaft of q.shafts){
    // The transfer frame starts above the bin rim. Posts must not extend down
    // through the lateral swept volume of the indexing carousel.
    const frameBase=wh+.065,frameHeight=railY-frameBase;
    if(stationInterior&&frameHeight>0)for(const dx of[-.338,.338])for(const dz of[-.231,.231])cube(a,shaft.x+dx,frameBase+frameHeight/2,shaft.z+dz,.016,frameHeight,.016,'#9ba79e');
    if(!stationInterior&&frameHeight>0){
      // Single ports expose a front access window. Only the upper fascia
      // continues across the front, leaving the vertical bin corridor open.
      const accessTop=Math.min(railY,wh+.60);
      for(const dx of[-.344,.344]){
        const front=q.type==='single'&&q.outX===Math.sign(dx),base=front?accessTop:frameBase;
        if(railY>base)cube(a,shaft.x+dx,(base+railY)/2,shaft.z,.012,railY-base,.454,'#e0e2e5');
      }
      for(const dz of[-.233,.233]){
        const front=q.type==='single'&&q.outZ===Math.sign(dz),base=front?accessTop:frameBase;
        if(railY>base)cube(a,shaft.x,(base+railY)/2,shaft.z+dz,.700,railY-base,.012,'#cbd0d6');
      }
      for(let y=Math.max(frameBase+.45,q.type==='single'?accessTop+.06:0);y<railY-.12;y+=.55){
        for(const dx of[-.350,.350])cube(a,shaft.x+dx,y,shaft.z,.003,.008,.463,'#a1a8b1');
        for(const dz of[-.239,.239])cube(a,shaft.x,y,shaft.z+dz,.680,.008,.002,'#a1a8b1');
      }
    }
    if(q.type==='single'){
      const front=holeD/2+.024;
      for(const side of[-1,1]){
        stationCube(a,q,side*(holeW/2+.014),wh+.324,front,.022,.552,.025,'#485752');
        stationCube(a,q,side*(holeW/2+.014),wh+.306,front+.014,.006,.480,.003,'#9aaf9c');
      }
      stationCube(a,q,0,wh+.601,front,holeW+.050,.045,.044,'#59655f');
      stationCube(a,q,0,wh+.576,front+.023,holeW-.025,.008,.005,'#dfebd9');
    }
    for(const dx of[-.344,.344])cube(a,shaft.x+dx,railY+.036,shaft.z,.016,.018,.480,green);
    for(const dz of[-.232,.232])cube(a,shaft.x,railY+.036,shaft.z+dz,.704,.018,.014,green);
  }
  // Bearing ring and roller supports are inspectable; not bare in operator view.
  if(stationInterior&&q.type==='buffer3'){
    const y=Math.max(.15,q.baseY-.12),r=Math.max(.21,q.radius*.7);
    cylinder(a,q.hub[0],y,q.hub[1],r,.050,'y','#606b64','#859087',96);
    cylinder(a,q.hub[0],y+.029,q.hub[1],r-.045,.012,'y','#303a33','#3d4940',96);
    for(let i=0;i<3;i++){const t=i*Math.PI*2/3,p=[q.hub[0]+Math.cos(t)*r,q.hub[1]+Math.sin(t)*r];cube(a,p[0],y-.07,p[1],.07,.14,.07,'#69746b');}
  }
  // A compact side console clears the single-port hoist, even at 90°.
  const single=q.type==='single',screenW=single?.158:.39;
  const side=single?holeW/2+.125:Math.min(s.widthM/2-.23,Math.max(holeW/2+.20,.47));
  const screenV=single?holeD/2+.072:Math.min(s.frontOffsetM-.13,workV+.09);
  stationCube(a,q,side,wh+.14,screenV,.026,.28,.026,'#455348');
  stationCube(a,q,side,wh+.39,screenV,screenW,single?.205:.25,.035,'#292c32');
  stationPanel(a,q,side,wh+.39,screenV+.020,screenW-.020,single?.181:.214,'#f5f6f8',.008);
  stationCube(a,q,side,wh+.447,screenV+.026,screenW-.040,.018,.003,green);
  for(let i=0;i<3;i++)stationCube(a,q,side+(i-1)*screenW*.26,wh+.369,screenV+.026,screenW*.20,.048,.003,i===0?'#b9cdb2':'#dde0e5');
  stationCube(a,q,side,wh+.408,screenV+.027,screenW*.66,.006,.003,'#7d8793');
  barcodeReaderGeometry(a,port,{width,depth,binHeight});
  const e=stationPoint(q,Math.min(.76,s.widthM*.36),s.frontOffsetM+.025),axis=q.outX?'x':'z';
  cylinder(a,e[0],wh-.13,e[1],.037,.018,axis,'#d8b84e','#e3c557',12);
  const ep=stationPoint(q,Math.min(.76,s.widthM*.36),s.frontOffsetM+.040);cylinder(a,ep[0],wh-.13,ep[1],.024,.025,axis,'#9b2a2a','#c84134',12);
  return new Float32Array(a);
}

/** Feature edges, not triangle cages: coplanar diagonals and tiny fasteners are
 * suppressed. The wire view shares the same cabinet/console/shaft geometry. */
export function buildStationWireGeometry(port,options={}){
  const q=getPortLayout(port,options),s=q.station,wh=s.workHeightM,triangles=[],edges=new Map(),a=[];
  appendTranslated(triangles,buildStationGeometry(port,{...options,stationInterior:true}),0,0,0);
  stationFrontDetails(triangles,q);
  const center=stationPoint(q,0,(s.frontOffsetM+s.rearOffsetM)/2),d=s.frontOffsetM-s.rearOffsetM;
  wireBox(a,center[0],(wh+.13)/2,center[1],q.outX?d:s.widthM,wh-.13,q.outX?s.widthM:d,'#a5b0bb');
  // The union outline has many analytic sweep segments. Draw its two rims,
  // not a vertical line at every segment (which would look like a wire fence).
  for(const edge of getPortSurface(q).edges)
    for(const y of [.12,wh+.032])line(a,[edge.a[0],y,edge.a[1]],[edge.b[0],y,edge.b[1]],'#a1aebb');
  const key=p=>p.map(n=>Math.round(n*100000)).join(',');
  for(let i=0;i<triangles.length;i+=27){
    const points=[0,9,18].map(j=>Array.from(triangles.slice(i+j,i+j+3)));
    const normal=V.norm(V.cross(V.sub(points[1],points[0]),V.sub(points[2],points[0])));
    if(Math.hypot(...normal)<.5)continue;
    for(let j=0;j<3;j++){const p=points[j],q=points[(j+1)%3];if(Math.hypot(...V.sub(p,q))<.025)continue;
      const id=[key(p),key(q)].sort().join('|'),old=edges.get(id);
      if(old){old.count++;if(Math.abs(V.dot(old.normal,normal))<.995)old.crease=true;}
      else edges.set(id,{p,q,normal,count:1,crease:false});
    }
  }
  for(const edge of edges.values())if(edge.count===1||edge.crease)line(a,edge.p,edge.q,'#8c98a4');
  return new Float32Array(a);
}
export function buildStationApertureGeometry(port,{width=12,depth=8,binHeight=.33,stationInterior=false}={}) {
  const a=[],q=getPortLayout(port,{width,depth,binHeight}),s=q.station,wh=s.workHeightM,openness=clamp(port.aperture?.openness??(port.activeRequestId?1:0),0,1);
  const u=(q.work[0]-q.origin[0])*(-q.outZ)+(q.work[1]-q.origin[1])*q.outX,v=(q.work[0]-q.origin[0])*q.outX+(q.work[1]-q.origin[1])*q.outZ;
  const w=q.outX?.455:.655,d=q.outX?.655:.455;
  if(!stationInterior&&q.type==='single'){
    // Front roll-up shutter never crosses the robot's vertical bin path.
    const height=.532*(1-openness),front=d/2+.027;
    if(height>.001){
      stationCube(a,q,u,wh+.574-height/2,front,w-.008,height,.014,'#68766e');
      for(let y=wh+.574-height+.022;y<wh+.574;y+=.036)stationCube(a,q,u,y,front+.008,w-.018,.003,.002,'#a7b1aa');
      stationCube(a,q,u,wh+.574-height,front+.009,w-.006,.014,.006,'#394b40');
    }
  }
  if(!stationInterior&&q.type==='buffer3')for(const side of[-1,1]){
    const center=u+side*(w/4+openness*w/2);
    stationCube(a,q,center,wh+.050,v,w/2+.003,.022,d+.006,'#616e64');
    for(let k=1;k<5;k++)stationCube(a,q,center,wh+.062,v-d/2+k*d/5,w/2-.012,.002,.0025,'#8d9a8f');
  }
  const lampU=-s.widthM/2+.13,lampV=s.frontOffsetM-.11;
  stationCube(a,q,lampU,wh+.12,lampV,.033,.24,.033,'#45544a');
  const p=stationPoint(q,lampU,lampV),invalid=port.operational===false||port.installation?.valid===false;
  cylinder(a,p[0],wh+.255,p[1],.031,.052,'y',invalid?'#c34a3d':port.presentation?.pickAllowed?'#8dba72':'#c8ab64',invalid?'#dd7464':port.presentation?.pickAllowed?'#ddebcb':'#e0cc8b',10);
  return new Float32Array(a);
}
/** Only stock still in the selected cell participates; moving bins keep ownership. */
export function getSelectedCellBins(data,selected,{excludeBinIds=[]}={}) {
  if(!selected)return [];
  const c=(data.cells||[]).find(c=>c.x===selected.x&&c.z===selected.z);
  if(!c||c.portId||c.isEquipment)return [];
  const excluded=new Set(excludeBinIds),bh=data.binHeight||.33,base=data.motionConfig?.stackBaseY??.015;
  return (c.bins||[]).flatMap((raw,i)=>{
    const bin=typeof raw==='string'?{id:raw}:raw;
    return excluded.has(bin.id)?[]:[{bin,binId:bin.id,x:c.x*SX,y:base+(i+.5)*bh,z:c.z*SZ,level:i+1}];
  });
}
/** Find the current physical owner of each selected inventory bin. */
export function getBinHighlightPoses(data,binIds=[]) {
  const requested=new Set(binIds),found=new Map(),bh=Number(data.binHeight)||.33,H=Math.max(1,Number(data.levels)||1)*bh,base=data.motionConfig?.stackBaseY??.015;
  if(!requested.size)return [];
  for(const c of data.cells||[])for(const [i,b]of(c.bins||[]).entries()){
    const id=typeof b==='string'?b:b.id;if(requested.has(id))found.set(id,{binId:id,x:c.x*SX,y:base+(i+.5)*bh,z:c.z*SZ,location:'grid',level:i+1,description:`${c.x+1},${c.z+1} · ${i+1}층`});
  }
  for(const p of data.ports||[])for(const b of p.bins||[]){const id=b.id||b.binId;if(requested.has(id))found.set(id,{binId:id,x:b.x*SX,y:Number.isFinite(b.binY)?b.binY:(p.binBaseY??.96-bh)+bh/2,z:b.z*SZ,location:'port',portId:p.id,description:`${p.id} · ${b.status==='picking'?'피킹':'포트'}`});}
  for(const r of data.robots||[]){if(!r.hoist?.loaded)continue;const p=getRobotPose(r,H,bh);if(requested.has(p.binId))found.set(p.binId,{binId:p.binId,x:p.x,y:p.binY,z:p.z,location:'robot',robotId:r.id,description:`${r.id} · 운반`});}
  return [...found.values()];
}
function rayBox(o,d,min,max) {
  let near=-Infinity,far=Infinity;
  for(let i=0;i<3;i++) {
    if(Math.abs(d[i])<1e-8) { if(o[i]<min[i]||o[i]>max[i])return Infinity;continue; }
    let a=(min[i]-o[i])/d[i],b=(max[i]-o[i])/d[i]; if(a>b)[a,b]=[b,a];
    near=Math.max(near,a);far=Math.min(far,b);if(far<near)return Infinity;
  }
  return far<0?Infinity:Math.max(0,near);
}

export function createScene(canvas,{onCell=()=>{},onHover=()=>{},onInspect=()=>{},onInspectRobot=()=>{},onClearSelection=()=>{},onEditGesture=null,onSelectPort=null,onExpand=()=>{},onExpandPreview=()=>{},onEditViewChange=()=>{}}={}) {
  const gl=canvas.getContext('webgl',{antialias:true,alpha:false,preserveDrawingBuffer:false,powerPreference:'high-performance'})||canvas.getContext('experimental-webgl');
  const cpu=gl?null:canvas.getContext('2d',{alpha:false});
  if(!gl&&!cpu) throw new Error('이 브라우저에서 3D 화면을 표시할 수 없습니다.');
  const vs=`attribute vec3 aPosition;attribute vec3 aNormal;attribute vec3 aColor;uniform mat4 uVP;varying vec3 vColor;varying float vShade;void main(){gl_Position=uVP*vec4(aPosition,1.0);vColor=aColor;float l=length(aNormal);vShade=l<0.1?1.0:(0.63+0.37*max(dot(normalize(aNormal),normalize(vec3(-0.45,0.9,0.5))),0.0));}`;
  const fs=`precision mediump float;varying vec3 vColor;varying float vShade;uniform float uAlpha;void main(){gl_FragColor=vec4(vColor*vShade,uAlpha);}`;
  function shader(type,source) { const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s; }
  let program,vshader,fshader,attrs,vpUniform,alphaUniform;
  if(gl){
    program=gl.createProgram();vshader=shader(gl.VERTEX_SHADER,vs);fshader=shader(gl.FRAGMENT_SHADER,fs);
    gl.attachShader(program,vshader);gl.attachShader(program,fshader);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    attrs=['aPosition','aNormal','aColor'].map(n=>gl.getAttribLocation(program,n));vpUniform=gl.getUniformLocation(program,'uVP');alphaUniform=gl.getUniformLocation(program,'uAlpha');
  }
  let hoverMesh=null,hoverLineMesh=null,coverMesh=null;
  const hoverFillAlpha=.22,hoverEdgeAlpha=.58;
  let staticMesh=null,lineMesh=null,dynamicMesh=null,overlayMesh=null,highlightMesh=null,highlightLineMesh=null,staticGhostMesh=null,dynamicGhostMesh=null,staticBinLineMesh=null,dynamicBinLineMesh=null,contextLineMesh=null,signature='',dead=false,renderSuspended=false,raf;
  const ghostAlpha=.24,ghostColor='#a7b5c0',binEdgeColor='#93a1a9';
  let data={width:12,depth:8,levels:8,binHeight:.33,cells:[],robots:[],activePaths:[]},tool='select',selected=null,hover=null;
  let opts={showBins:true,showPaths:false,showLabels:false,cutaway:false,stationInterior:false,editing:false,followRobotId:null,followPortId:null,selectedRobotId:null,highlightBinIds:[],traceBinId:null,traceBinIds:[],traceBlockerBinIds:[],traceDiggingTargets:[],traceDiggingRobots:[]};
  let tracedBinIds=[],tracedBinSet=new Set();
  let traceBlockerSet=new Set(),traceTargetCounts=new Map(),traceRobotDetails=new Map(),traceContextSignature='';
  let editOptions={brush:'brush',selectedPortId:null,movingPortId:null,topView:false},editPreview=null,editPreviewSignature='',editRevision=0;
  let editFillMesh=null,editOutlineMesh=null,editLineMesh=null;
  const gripperGeometry=[buildGripperGeometry(),buildGripperGeometry({loaded:true})];
  const reducedMotion=typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let yaw=.86,pitch=.64,zoom=1,panX=0,panZ=0;
  let operatorView=false,binCameraTarget=null;
  let vp,invVP,eye,cameraAim,canvasWidth=1,canvasHeight=1,pinch=null,drag=null,lastHoverKey='';
  let activeMap=new Map();
  let softwareCache=null,lastSoftwareFrame=-Infinity,lastRenderedSignature='';
  let softwareScale=1,cameraInputAt=-Infinity,lastFollowPosition='';
  const robotGeometryCache=new Map(),binGeometryCache=new Map(),wheelGeometryCache=new Map();
  function wheelGeometry(robot){
    const signature=[robot.bodySign,robot.wheels?.liftX||0,robot.wheels?.liftZ||0].join(':');
    let cached=wheelGeometryCache.get(robot.id);
    if(cached?.signature!==signature){cached={signature,vertices:buildRobotWheelGeometry(robot)};wheelGeometryCache.set(robot.id,cached);}
    return cached.vertices;
  }
  let softwareImage=null,softwarePixels=null,softwareDepth=null,softwareGhostPixels=null,softwareGhostDepth=null,softwareHoverPixels=null,softwareHoverDepth=null;
  const pointers=new Map(), listeners=[];
  canvas.style.touchAction='none';canvas.style.userSelect='none';canvas.style.cursor='grab';
  canvas.setAttribute('aria-label','wedraw WMS 3D 창고. 드래그하여 회전하고 클릭하여 확인합니다. 그리드 변경은 편집 메뉴를 켠 뒤 가능합니다.');
  if(!canvas.hasAttribute('tabindex'))canvas.tabIndex=0;
  const parent=canvas.parentElement;
  if(parent&&getComputedStyle(parent).position==='static')parent.style.position='relative';
  const labels=document.createElement('div');
  labels.setAttribute('aria-hidden','true');
  Object.assign(labels.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden',zIndex:'2'});
  parent?.appendChild(labels);
  const labelNodes=new Map();
  // Editing controls are separate from aria-hidden informational scene labels.
  const editHandles=document.createElement('div');
  editHandles.setAttribute('aria-label','그리드 외곽 확장');
  Object.assign(editHandles.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden',zIndex:'3',display:'none'});
  parent?.appendChild(editHandles);
  const expandHandles=new Map();
  for(const axis of ['width','depth']){
    const button=document.createElement('button');button.type='button';button.className='edit-expand-handle';
    button.setAttribute('data-expand-axis',axis);button.setAttribute('aria-label',axis==='width'?'가로 한 열 추가':'세로 한 행 추가');
    button.textContent=axis==='width'?'+ 열':'+ 행';
    Object.assign(button.style,{position:'absolute',pointerEvents:'auto',transform:'translate(-50%, -50%)',border:'1px solid #bccdbf',borderRadius:'12px',padding:'8px 12px',background:'#fffffff2',color:'#215732',fontFamily:'inherit',fontSize:'12px',fontWeight:'600',boxShadow:'0 4px 14px #163d2417',cursor:'pointer',whiteSpace:'nowrap'});
    button.onpointerdown=event=>event.stopPropagation();
    button.onclick=event=>{event.stopPropagation();if(opts.editing)onExpand(axis);};
    button.onpointerenter=button.onfocus=()=>{if(opts.editing)onExpandPreview(axis);};
    button.onpointerleave=button.onblur=()=>onExpandPreview(null);
    expandHandles.set(axis,button);editHandles.appendChild(button);
  }

  function mesh(array,existing) {
    const m=existing||{buffer:gl?gl.createBuffer():null,count:0,version:0};
    const grow=!m.storage||m.storage.length<array.length;
    if(grow)m.storage=new Float32Array(Math.max(64,2**Math.ceil(Math.log2(Math.max(1,array.length)))));
    m.storage.set(array);m.array=m.storage.subarray(0,array.length);m.count=array.length/9;m.version++;
    if(gl){gl.bindBuffer(gl.ARRAY_BUFFER,m.buffer);if(grow)gl.bufferData(gl.ARRAY_BUFFER,m.storage.byteLength,gl.DYNAMIC_DRAW);if(array.length)gl.bufferSubData(gl.ARRAY_BUFFER,0,m.array);}
    return m;
  }
  function draw(m,mode,alpha=1) {
    if(!m||!m.count)return;
    gl.uniform1f(alphaUniform,alpha);
    gl.bindBuffer(gl.ARRAY_BUFFER,m.buffer);
    attrs.forEach((a,i)=>{gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,3,gl.FLOAT,false,36,i*12);});
    gl.drawArrays(mode,0,m.count);
  }
  function drawGhosts(){
    if(!tracing()||!(staticGhostMesh?.count||dynamicGhostMesh?.count))return;
    // Resolve the nearest face once, then retain its depth for background edges.
    // Hidden bin edges must disappear instead of showing through every layer.
    gl.colorMask(false,false,false,false);gl.depthMask(true);
    draw(staticGhostMesh,gl.TRIANGLES);draw(dynamicGhostMesh,gl.TRIANGLES);
    gl.colorMask(true,true,true,true);gl.depthMask(false);gl.depthFunc(gl.EQUAL);
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    draw(staticGhostMesh,gl.TRIANGLES,ghostAlpha);draw(dynamicGhostMesh,gl.TRIANGLES,ghostAlpha);
    gl.disable(gl.BLEND);gl.depthMask(true);gl.depthFunc(gl.LEQUAL);
  }
  function top() {return data.levels*data.binHeight;}
  function normalizeBinIds(ids){return [...new Set((Array.isArray(ids)?ids:[]).filter(id=>typeof id==='string'&&id))].sort();}
  function tracing(){return !!(tracedBinIds.length||selected||opts.selectedRobotId)&&!opts.editing;}
  function trackedRobotDetail(robot){
    if(robot.id===opts.selectedRobotId)return {role:'selected',taskKind:robot.jobRole,phaseLabel:robot.status||'선택됨',number:robot.id};
    const detail=traceRobotDetails.get(robot.id);
    if(!detail||!detail.targetBinIds.some(id=>tracedBinSet.has(id)))return null;
    // Scene data can advance between UI context refreshes. Do not keep an old
    // assignment lit after its robot becomes idle or starts a different job.
    if(robot.jobRole&&robot.jobRole!==detail.taskKind)return null;
    if(detail.requestId&&robot.parentOrderId!==undefined&&robot.parentOrderId!==detail.requestId)return null;
    if(detail.role==='target'&&detail.taskKind==='optimize'&&robot.hoist&&!robot.hoist.loaded)return null;
    if(detail.role==='target'&&detail.phase==='returning'&&robot.hoist?.operation==='move'&&!robot.hoist.loaded)return null;
    return detail;
  }
  function traceBinDetails(p){
    if(p.location==='grid')return activeMap.get(`${Math.round(p.x/SX)},${Math.round(p.z/SZ)}`)?.bins[p.level-1];
    if(p.location==='robot')return (data.robots||[]).find(r=>r.id===p.robotId)?.bin;
    return ports().find(q=>q.id===p.portId)?.bins?.find(b=>(b.id||b.binId)===p.binId);
  }
  function binGeometry(a,x,y,z,bin={},detail='high') {
    const appearance=`${data.binHeight}:${detail}:${bin.color||getBinColor(bin.id)}`;
    const key=detail==='high'?`${appearance}:${bin.id||''}:${bin.compartments||4}:${bin.category||''}:${(bin.contents||[]).map(c=>`${c.compartment}:${c.category}:${c.qty}`).join(';')}`:appearance;
    if(!binGeometryCache.has(key)){if(binGeometryCache.size>768)binGeometryCache.clear();binGeometryCache.set(key,buildBinGeometry(bin,data.binHeight,{detail,contents:detail==='high'}));}
    const source=binGeometryCache.get(key);
    if(!tracing()&&opts.highlightBinIds.includes(bin.id)){
      for(let i=0;i<source.length;i+=9)a.push(source[i]+x,source[i+1]+y,source[i+2]+z,source[i+3],source[i+4],source[i+5],source[i+6]*.82+.56*.18,source[i+7]*.82+.76*.18,source[i+8]*.82+.42*.18);
    }else appendTranslated(a,source,x,y,z);
  }
  function portBase() {return Number.isFinite(data.motionConfig?.portBaseY)?data.motionConfig.portBaseY:.96-data.binHeight;}
  function ports() {
    if(Array.isArray(data.ports))return data.ports;
    return data.cells.filter(c=>c.portId).map(c=>({id:c.portId,type:'single',x:c.x,z:c.z,binBaseY:portBase(),slots:[],bins:c.portBinId?[{id:c.portBinId,x:c.x,z:c.z,binY:portBase()+data.binHeight/2,state:'picking'}]:[],status:c.portBusy?'busy':'idle'}));
  }
  function portLayout(p) {return getPortLayout(p,{width:data.width,depth:data.depth,binHeight:data.binHeight,portBaseY:portBase()});}
  function followedPort() {const p=ports().find(p=>p.id===opts.followPortId);return p?{port:p,layout:portLayout(p)}:null;}
  function worldBounds() {
    let x0=-SX/2,x1=(data.floorWidthM??data.width*SX)-SX/2,z0=-SZ/2,z1=(data.floorDepthM??data.depth*SZ)-SZ/2;
    for(const p of ports()){const b=stationLimits(portLayout(p));x0=Math.min(x0,b.minX);x1=Math.max(x1,b.maxX);z0=Math.min(z0,b.minZ);z1=Math.max(z1,b.maxZ);}
    return {x0,x1,z0,z1};
  }
  function followedRobot() {
    if(!opts.followRobotId)return null;
    if(opts.followRobotId==='auto')return (data.robots||[]).find(r=>r.available!==false&&r.onGrid!==false&&r.hoist?.phase!=='idle')||(data.robots||[]).find(r=>r.available!==false&&r.onGrid!==false);
    return (data.robots||[]).find(r=>r.id===opts.followRobotId&&r.available!==false&&r.onGrid!==false)||null;
  }
  function cutawayColumns() {
    const keys=new Set();if(!opts.cutaway)return keys;
    const fp=followedPort();if(fp){keys.add(`${fp.port.x},${fp.port.z}`);return keys;}
    const focus=followedRobot(),robots=focus?[focus]:(data.robots||[]).filter(r=>r.hoist?.phase&&r.hoist.phase!=='idle');
    for(const r of robots){keys.add(`${Math.round(r.x)},${Math.round(r.z)}`);if(r.hoist?.sourceKey)keys.add(r.hoist.sourceKey);if(r.hoist?.targetKey)keys.add(r.hoist.targetKey);}
    if(selected)keys.add(`${selected.x},${selected.z}`);
    return keys;
  }
  function floorBrand(a){
    if(opts.editing)return;
    const b=worldBounds(),q=ports().length?portLayout(ports()[0]):{outX:0,outZ:1},nx=q.outX,nz=q.outZ;
    const x=nx?nx>0?b.x1+.32:b.x0-.32:(b.x0+b.x1)/2,z=nz?nz>0?b.z1+.32:b.z0-.32:(b.z0+b.z1)/2;
    const right=[nz,0,-nx],up=[-nx,0,-nz],span=nx?b.z1-b.z0:b.x1-b.x0,scale=Math.min(1,span/2);
    surfaceBrand(a,WEDRAW_LOGO,[x,-.028,z],right,up,1.65*scale,'#557661');
  }
  function rebuildTrace(){
    const l=[],ghosts=[],binLines=[],H=top(),bounds=worldBounds(),rails=new Set(),posts=new Map(),base=data.motionConfig?.stackBaseY??.015;
    rect(l,(bounds.x0+bounds.x1)/2,(bounds.z0+bounds.z1)/2,-.025,bounds.x1-bounds.x0+.24,bounds.z1-bounds.z0+.24,'#d7ded8');
    for(const c of data.cells){
      const corners=[[c.x-.5,c.z-.5],[c.x+.5,c.z-.5],[c.x+.5,c.z+.5],[c.x-.5,c.z+.5]],neighbours=[[c.x-1,c.z],[c.x+1,c.z],[c.x,c.z-1],[c.x,c.z+1]];
      for(let i=0;i<4;i++){
        const p=corners[i],q=corners[(i+1)%4],key=[p.join(','),q.join(',')].sort().join('|');
        if(!rails.has(key)){rails.add(key);line(l,[p[0]*SX,H+.024,p[1]*SZ],[q[0]*SX,H+.024,q[1]*SZ],'#c3cdc7');}
      }
      if(neighbours.some(([x,z])=>!activeMap.has(`${x},${z}`)))for(const p of corners)posts.set(p.join(','),p);
      const isTraceColumn=(c.bins||[]).some(b=>tracedBinSet.has(b.id||b));
      for(const [i,raw]of(c.bins||[]).entries()){
        const id=raw.id||raw;if(tracedBinSet.has(id)||traceBlockerSet.has(id))continue;
        // Keep perimeter/top bins and the selected column legible at large
        // capacities; hidden interior cages add density without location cues.
        const concealed=i<c.bins.length-1&&neighbours.every(([x,z])=>(activeMap.get(`${x},${z}`)?.bins?.length||0)>i);
        if(concealed&&!isTraceColumn)continue;
        const y=base+(i+.5)*data.binHeight;
        cube(ghosts,c.x*SX,y,c.z*SZ,.649,data.binHeight-.012,.449,ghostColor);
        wireBox(binLines,c.x*SX,y,c.z*SZ,.649,data.binHeight-.012,.449,binEdgeColor);
      }
    }
    for(const [x,z]of posts.values())line(l,[x*SX,0,z*SZ],[x*SX,H+.024,z*SZ],'#d1d9d3');
    for(const p of ports()){
      const options={width:data.width,depth:data.depth,binHeight:data.binHeight,railY:H};
      // Frosted structural solids plus the cabinet's actual feature edges.
      // Open frames preserve the visibility of real internal buffer bins.
      appendTranslated(ghosts,buildStationGeometry(p,{...options,stationInterior:true}),0,0,0);
      appendTranslated(binLines,buildStationWireGeometry(p,options),0,0,0);
    }
    const floor=[];floorBrand(floor);for(const p of ports())stationBrand(floor,portLayout(p));
    staticMesh=mesh(floor,staticMesh);lineMesh=mesh(l,lineMesh);staticGhostMesh=mesh(ghosts,staticGhostMesh);staticBinLineMesh=mesh(binLines,staticBinLineMesh);
  }
  function rebuild() {
    if(tracing()){rebuildTrace();return;}
    if(staticGhostMesh?.count)staticGhostMesh=mesh([],staticGhostMesh);
    if(staticBinLineMesh?.count)staticBinLineMesh=mesh([],staticBinLineMesh);
    const a=[],l=[],H=top(),w=data.width,d=data.depth,cx=(w-1)*SX/2,cz=(d-1)*SZ/2;
    const visibleColumns=cutawayColumns();
    const bounds=worldBounds();
    cube(a,(bounds.x0+bounds.x1)/2,-.10,(bounds.z0+bounds.z1)/2,bounds.x1-bounds.x0+(opts.editing?.12:1.2),.14,bounds.z1-bounds.z0+(opts.editing?.12:1.2),'#e6e7e5');
    floorBrand(a);
    cube(a,cx,-.023,cz,w*SX+.14,.025,d*SZ+.14,'#d6d8dc');
    // A floor lattice costs O(width + depth), independent of its area.
    const fw=data.floorWidthM??w*SX,fd=data.floorDepthM??d*SZ;
    cube(a,(fw-SX)/2,-.006,(fd-SZ)/2,fw,.012,fd,'#eeeef0');
    if(opts.editing){
      for(let x=0;x<=w;x++)line(l,[(x-.5)*SX,.008,-SZ/2],[(x-.5)*SX,.008,(d-.5)*SZ],'#b8c6bb');
      for(let z=0;z<=d;z++)line(l,[-SX/2,.008,(z-.5)*SZ],[(w-.5)*SX,.008,(z-.5)*SZ],'#b8c6bb');
      rect(l,(fw-SX)/2,(fd-SZ)/2,.009,fw,fd,'#688c75');
    }
    const railEdges=new Set(),posts=new Map();
    for(const c of data.cells) {
      const x=c.x*SX,z=c.z*SZ,blocked=c.reachable===false;
      const corners=[[c.x-.5,c.z-.5],[c.x+.5,c.z-.5],[c.x+.5,c.z+.5],[c.x-.5,c.z+.5]];
      for(let i=0;i<4;i++) {
        const p=corners[i],q=corners[(i+1)%4],k=[`${p[0]},${p[1]}`,`${q[0]},${q[1]}`].sort().join('|');
        if(!railEdges.has(k)) {railEdges.add(k);cube(a,(p[0]+q[0])*SX/2,H+.024,(p[1]+q[1])*SZ/2,Math.abs(q[0]-p[0])*SX+.024,.039,Math.abs(q[1]-p[1])*SZ+.024,'#87978e');}
      }
      // Boundary supports keep the vertical storage envelope legible without hiding the bins.
      const neighbours=[[c.x-1,c.z],[c.x+1,c.z],[c.x,c.z-1],[c.x,c.z+1]];
      if(!c.isEquipment&&neighbours.some(([nx,nz])=>!activeMap.has(`${nx},${nz}`)))for(const p of corners)posts.set(p.join(','),p);
      if(opts.editing&&editOptions.topView&&!c.isEquipment){
        const count=(c.bins||[]).length;
        // A quiet top face keeps the footprint legible while the full 3D view
        // retains the detailed, individually coloured stored bins.
        cube(a,x,H-.015,z,SX-.055,.025,SZ-.055,count?'#dde5dc':'#edf1e9');
      }else if(!c.portId&&!c.isEquipment&&opts.showBins&&(!opts.cutaway||visibleColumns.has(`${c.x},${c.z}`))) {
        (c.bins||[]).forEach((b,i)=>{
          const y=i*data.binHeight+data.binHeight/2+(data.motionConfig?.stackBaseY??.015),isTop=i===(c.bins.length-1);
          const concealed=!isTop&&!opts.cutaway&&neighbours.every(([nx,nz])=>(activeMap.get(`${nx},${nz}`)?.bins?.length||0)>i);
          if(concealed&&!opts.highlightBinIds.includes(b.id||b))return;
          const closeUp=selected&&selected.x===c.x&&selected.z===c.z||opts.cutaway&&visibleColumns.has(`${c.x},${c.z}`);
          binGeometry(a,x,y,z,typeof b==='object'?b:{id:b},closeUp?'high':isTop?'medium':'low');
        });
      }
      if(blocked&&opts.editing)rect(l,x,z,H+.055,SX-.04,SZ-.04,'#c8774f');
    }
    for(const p of ports())appendTranslated(a,buildStationGeometry(p,{width:w,depth:d,binHeight:data.binHeight,railY:H,stationInterior:opts.stationInterior,topCover:false}),0,0,0);
    for(const [gx,gz] of posts.values()){
      const besideFacility=[[-.5,-.5],[-.5,.5],[.5,-.5],[.5,.5]].some(([dx,dz])=>activeMap.get(`${gx+dx},${gz+dz}`)?.isEquipment);
      if(!besideFacility)cube(a,gx*SX,H/2,gz*SZ,.024,H+.05,.024,'#a6b6ac');
    }
    // Meter markers along the outer floor edge.
    for(let x=0;x<=w;x++)line(l,[(x-.5)*SX,.012,-SZ*.72],[(x-.5)*SX,.012,-SZ*.9],'#7f9b8b');
    staticMesh=mesh(a,staticMesh);lineMesh=mesh(l,lineMesh);
  }
  function updateCamera() {
    const H=top(),bounds=worldBounds(),w=bounds.x1-bounds.x0,d=bounds.z1-bounds.z0,aspect=canvasWidth/canvasHeight;
    const follow=followedRobot(),fp=followedPort();
    const bt=binCameraTarget;
    const target=fp?[fp.layout.work[0]+panX,fp.layout.station.workHeightM+(operatorView?.06:-.08),fp.layout.work[1]+panZ]:follow?[follow.x*SX+panX,H*.58+.35,follow.z*SZ+(follow.bodySign===-1?-1:1)*SZ*.3+panZ]:bt?[bt.x+panX,bt.y,bt.z+panZ]:[(bounds.x0+bounds.x1)/2+panX,H*.43+.12,(bounds.z0+bounds.z1)/2+panZ];
    cameraAim=target;
    const fitRadius=bt?.boundsRadius?Math.max(bt.radius,bt.boundsRadius/Math.sin(Math.min(.38,Math.atan(Math.tan(.38)*aspect)))*1.12):null;
    let radius=(fitRadius??(fp?4.1:follow?Math.max(4.4,H*1.15+2.1):bt?bt.radius:Math.max(3,Math.hypot(w,d,H+.75)*1.26))*(aspect<1?Math.min(1.7,1/aspect):1))*zoom;
    if(opts.editing&&!editOptions.topView&&!follow&&!fp&&!bt){
      // Fit the projected 3D bounds rather than a loose diagonal sphere.
      const direction=[Math.cos(pitch)*Math.cos(yaw),Math.sin(pitch),Math.cos(pitch)*Math.sin(yaw)];
      const right=[Math.sin(yaw),0,-Math.cos(yaw)],up=V.cross(direction,right);
      const tanY=Math.tan(.38)*Math.max(.1,1-36/canvasHeight),tanX=Math.tan(.38)*aspect*Math.max(.1,1-36/canvasWidth);
      let distance=1;
      for(const x of[bounds.x0,bounds.x1])for(const y of[0,H+.75])for(const z of[bounds.z0,bounds.z1]){
        const offset=[x-(bounds.x0+bounds.x1)/2,y-(H*.43+.12),z-(bounds.z0+bounds.z1)/2];
        const depth=V.dot(offset,direction);
        distance=Math.max(distance,depth+Math.abs(V.dot(offset,right))/tanX,depth+Math.abs(V.dot(offset,up))/tanY);
      }
      radius=distance*zoom;
    }
    if(opts.editing&&editOptions.topView){
      const aim=[(bounds.x0+bounds.x1)/2+panX,H,(bounds.z0+bounds.z1)/2+panZ],half=editorTopFit(bounds,canvasWidth,canvasHeight).half*zoom;
      eye=[aim[0],H+40,aim[2]+.0001];
      vp=multiply(orthographic(-half*aspect,half*aspect,-half,half,.04,150),lookAt(eye,aim));
    }else{
      eye=fp&&operatorView?[target[0]+fp.layout.outX*1.05*zoom,fp.layout.station.workHeightM+.78*zoom,target[2]+fp.layout.outZ*1.05*zoom]:[target[0]+radius*Math.cos(pitch)*Math.cos(yaw),target[1]+radius*Math.sin(pitch),target[2]+radius*Math.cos(pitch)*Math.sin(yaw)];
      vp=multiply(perspective(.76,aspect,.04,Math.max(150,radius*4)),lookAt(eye,target));
    }
    invVP=inverse(vp);
  }
  function project(p) {const v=transform(vp,[...p,1]);return v[3]<=0?null:{x:(v[0]/v[3]*.5+.5)*canvasWidth,y:(-.5*v[1]/v[3]+.5)*canvasHeight,z:v[2]/v[3]};}
  function label(key,text,p,kind,force=false) {
    if(!opts.showLabels&&!force){const n=labelNodes.get(key);if(n)n.style.display='none';return;}
    const point=project(p); let n=labelNodes.get(key);
    if(!n){n=document.createElement('span');labelNodes.set(key,n);labels.appendChild(n);Object.assign(n.style,{position:'absolute',fontFamily:'inherit',fontSize:'10px',fontWeight:'700',lineHeight:'18px',padding:'1px 6px',borderRadius:'5px',whiteSpace:'nowrap',boxShadow:'0 1px 4px #162c2117',transform:'translate(-50%, -100%)'});}
    n.textContent=text;
    n.style.background=kind==='trace'?'#fff6f4f5':kind==='digging'?'#096a5df5':kind==='port'?'#fffffff0':kind==='robot'?'#34383ef0':'#ffffffdf';
    n.style.color=kind==='trace'?'#b5292e':['digging','robot'].includes(kind)?'#fff':kind==='port'?'#215732':'#666a72';
    n.style.border=kind==='trace'?'1px solid #dfaaa4':kind==='digging'?'1px solid #72d4ba':'none';
    n.style.fontSize=kind==='trace'||kind==='digging'?'12px':'10px';
    n.style.padding=kind==='trace'||kind==='digging'?'5px 9px':'1px 6px';
    if(!point||point.z>1||point.x<0||point.y<0||point.x>canvasWidth||point.y>canvasHeight){n.style.display='none';return;}
    // Digging identifiers stay below the fixed header/status surface even when
    // fitting a tall stack; this does not move the robot or recenter the camera.
    const labelY=kind==='digging'?Math.min(canvasHeight-10,Math.max(point.y,Math.min(canvasHeight*.32,canvasWidth<850?220:180)+28)):point.y;
    n.style.display='block';n.style.left=`${point.x}px`;n.style.top=`${labelY}px`;
  }
  function editBox(outline,lines,x,y,z,w,h,d,color,stroke=.018){
    for(const dx of[-1,1])for(const dz of[-1,1])cube(outline,x+dx*w/2,y,z+dz*d/2,stroke,h,stroke,color);
    for(const dy of[-1,1]){
      rect(lines,x,z,y+dy*h/2,w,d,color);
      for(const dz of[-1,1])cube(outline,x,y+dy*h/2,z+dz*d/2,w,stroke,stroke,color);
      for(const dx of[-1,1])cube(outline,x+dx*w/2,y+dy*h/2,z,stroke,stroke,d,color);
    }
  }
  function rebuildEditPreview(){
    const fill=[],outline=[],lines=[],H=top(),preview=editPreview;
    if(opts.editing){
      const color=preview?.status==='invalid'?'#c85c52':preview?.status==='warning'?'#c59329':preview?.mode==='erase'?'#c85c52':'#32925a';
      for(const raw of preview?.cells||[]){
        const c=typeof raw==='string'?{x:+raw.split(',')[0],z:+raw.split(',')[1]}:raw;
        if(!Number.isFinite(c?.x)||!Number.isFinite(c?.z))continue;
        const x=c.x*SX,z=c.z*SZ;
        cube(fill,x,H/2,z,SX-.034,Math.max(.03,H),SZ-.034,color);
        editBox(outline,lines,x,H/2+.035,z,SX-.03,Math.max(.04,H+.05),SZ-.03,color,.015);
      }
      for(const raw of preview?.affectedKeys||[]){
        const[x,z]=typeof raw==='string'?raw.split(',').map(Number):[raw.x,raw.z];
        if(!Number.isFinite(x)||!Number.isFinite(z))continue;
        cube(fill,x*SX,H+.072,z*SZ,SX-.045,.018,SZ-.045,'#dc9d40');
        rect(lines,x*SX,z*SZ,H+.086,SX-.035,SZ-.035,'#b87921');
      }
      const highlightedPorts=ports().filter(p=>p.id===editOptions.selectedPortId||(preview?.affectedPortIds||[]).includes(p.id));
      for(const p of highlightedPorts){
        const q=portLayout(p),b=stationLimits(q),affected=(preview?.affectedPortIds||[]).includes(p.id),c=affected?'#d08b32':'#426fbe';
        editBox(outline,lines,(b.minX+b.maxX)/2,q.station.workHeightM/2,(b.minZ+b.maxZ)/2,b.maxX-b.minX,q.station.workHeightM,b.maxZ-b.minZ,c,.016);
        for(const shaft of q.shafts)editBox(outline,lines,shaft.x,H/2,shaft.z,SX-.035,H+.08,SZ-.035,c,.014);
      }
      if(preview?.port){
        const p=preview.port,q=portLayout(p),s=q.station;
        const source=buildStationGeometry(p,{width:data.width,depth:data.depth,binHeight:data.binHeight,railY:H});
        const tint=rgb(color);
        for(let i=0;i<source.length;i+=9)fill.push(source[i],source[i+1],source[i+2],source[i+3],source[i+4],source[i+5],...tint);
        const surface=getPortSurface(q);
        for(const edge of surface.edges){
          const {a,b}=edge;
          for(const y of[.04,s.workHeightM+.045])beamBetween(outline,[a[0],y,a[1]],[b[0],y,b[1]],.023,.023,color);
          const previous=surface.edges.find(v=>Math.hypot(v.b[0]-a[0],v.b[1]-a[1])<1e-7);
          if(previous&&previous.normal[0]*edge.normal[0]+previous.normal[1]*edge.normal[1]<.95)
            cube(outline,a[0],s.workHeightM/2,a[1],.017,s.workHeightM,.017,color);
        }
        for(const shaft of q.shafts)editBox(outline,lines,shaft.x,H/2,shaft.z,SX-.025,H+.085,SZ-.025,color,.022);
        for(const cell of q.equipmentCells)rect(lines,cell.x*SX,cell.z*SZ,H+.1,SX-.04,SZ-.04,color);
        // The arrow is on the actual operator-facing side from the engine's layout.
        const tail=[q.work[0],s.workHeightM+.08,q.work[1]],head=[tail[0]+q.outX*.62,tail[1],tail[2]+q.outZ*.62];
        beamBetween(outline,tail,head,.055,.025,color);
        for(const side of[-1,1])beamBetween(outline,head,[head[0]-q.outX*.19-q.outZ*.14*side,head[1],head[2]-q.outZ*.19+q.outX*.14*side],.055,.025,color);
      }
    }
    editFillMesh=mesh(fill,editFillMesh);editOutlineMesh=mesh(outline,editOutlineMesh);editLineMesh=mesh(lines,editLineMesh);editRevision++;
  }
  function hoveredStack(){
    const a=[],l=[],same=hover&&selected&&hover.x===selected.x&&hover.z===selected.z;
    const c=hover&&activeMap.get(hover.x+','+hover.z);
    // Hover is a preview only. A selected cell wins; edit brushes keep their
    // add/erase feedback, and navigation gestures never leave a stale column.
    if(hover&&c&&!same&&!drag&&opts.showBins&&(!opts.editing||tool==='select')){
      const view={...data,cells:[c]};
      for(const p of getSelectedCellBins(view,hover,{excludeBinIds:tracedBinIds})){
        binGeometry(a,p.x,p.y,p.z,{...p.bin,color:'#b8d7cc'},'medium');
        const bh=data.binHeight;
        for(const y of[p.y-bh/2+.005,p.y+bh/2+.001])rect(l,p.x,p.z,y,.654,.454,'#7da696');
        for(const dx of[-1,1])for(const dz of[-1,1])line(l,[p.x+dx*.3165,p.y-bh/2,p.z+dz*.2165],[p.x+dx*.326,p.y+bh/2,p.z+dz*.226],'#7da696');
      }
    }
    if(a.length||hoverMesh?.count)hoverMesh=mesh(a,hoverMesh);
    if(l.length||hoverLineMesh?.count)hoverLineMesh=mesh(l,hoverLineMesh);
  }
  function drawHoveredStack(){
    if(!hoverMesh?.count)return;
    // Resolve the nearest surface before blending once. Buried bins remain
    // visible without opaque blocks or darker overlapping backs/fronts.
    gl.clear(gl.DEPTH_BUFFER_BIT);gl.colorMask(false,false,false,false);
    gl.depthMask(true);draw(hoverMesh,gl.TRIANGLES);
    gl.colorMask(true,true,true,true);gl.depthMask(false);gl.depthFunc(gl.EQUAL);
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    draw(hoverMesh,gl.TRIANGLES,hoverFillAlpha);
    gl.depthFunc(gl.LEQUAL);gl.depthRange(0,.999997);draw(hoverLineMesh,gl.LINES,hoverEdgeAlpha);gl.depthRange(0,1);
    gl.disable(gl.BLEND);gl.depthMask(true);
  }
  function selectedStack(a,l,excluded=[]){
    if(!opts.showBins)return;
    for(const p of getSelectedCellBins(data,selected,{excludeBinIds:excluded})){
      binGeometry(a,p.x,p.y,p.z,{...p.bin,color:'#a0cbb4'},'medium');
      const bh=data.binHeight;
      for(const y of[p.y-bh/2+.005,p.y+bh/2-.016,p.y+bh/2+.001])rect(l,p.x,p.z,y,.654,.454,'#24684c');
      for(const dx of[-1,1])for(const dz of[-1,1])line(l,[p.x+dx*.3165,p.y-bh/2,p.z+dz*.2165],[p.x+dx*.326,p.y+bh/2,p.z+dz*.226],'#3d8566');
    }
  }
  function dynamicTrace(){
    const l=[],context=[],contextLines=[],solid=[],picking=[],lifting=[],leaders=[],ghosts=[],binLines=[],H=top(),bh=data.binHeight,usedLabels=new Set(),renderedBins=new Set(),outlinedColumns=new Set();
    for(const r of data.robots||[]){
      if(!Number.isFinite(r.x)||!Number.isFinite(r.z)||r.onGrid===false||r.available===false)continue;
      const p=getRobotPose(r,H,bh),digging=trackedRobotDetail(r),isSelected=r.id===opts.selectedRobotId,robotSolids=isSelected?solid:context,isDigging=!!digging,color=isDigging?'#148976':'#bdcac2',outline=isSelected?leaders:isDigging?contextLines:l;
      if(isDigging){
        const cacheKey=`${r.id}:${p.bodySign}`;
        if(!robotGeometryCache.has(cacheKey))robotGeometryCache.set(cacheKey,buildRobotGeometry(r,{wheels:false}));
        // Highlighting preserves the product's ivory/charcoal finish. Only the
        // outline, small status light and label carry the live task accent.
        appendTranslated(robotSolids,robotGeometryCache.get(cacheKey),p.x,H,p.z);
        appendTranslated(robotSolids,wheelGeometry(r),p.x,H,p.z);
        // A mint two-cell outline is a selection cue, not a new robot footprint.
        const centerZ=p.z+p.bodySign*SZ/2;
        for(const dz of[-1,1])cube(robotSolids,p.x,H+.061,centerZ+dz*(SZ+.025),SX+.05,.010,.018,'#58c8a9');
        for(const dx of[-1,1])cube(robotSolids,p.x+dx*(SX/2+.025),H+.061,centerZ,.018,.010,2*SZ+.05,'#58c8a9');
        for(const belt of p.belts){const length=Math.max(.003,belt.top[1]-belt.bottom[1]);cube(lifting,belt.top[0],(belt.top[1]+belt.bottom[1])/2,belt.top[2],.018,length,.005,'#a2afb6');}
        appendTranslated(lifting,gripperGeometry[p.loaded?1:0],p.x,p.gripperY,p.z);
        // Traced carrier stays highlighted without a task label.
      }
      wireBox(outline,p.bodyX,H+.357,p.bodyZ,.661,.474,.454,color);
      wireBox(outline,p.x,H+.102,p.z+p.bodySign*SZ/2,.70,.064,.988,color);
      rect(outline,p.x,p.z+p.bodySign*SZ/2,H+.61,.68,.94,color);
      for(const dx of[-.31,.31])line(outline,[p.x+dx,H+.12,p.z+p.bodySign*.222],[p.x+dx,H+.61,p.z+p.bodySign*.222],color);
      for(const xx of[-.329,.329])for(const zz of[-p.bodySign*.15,p.bodySign*.60])wireCircle(outline,p.x+xx,H+.116+(r.wheels?.liftZ||0),p.z+zz,.072,'x',color,8);
      for(const xx of[-.245,.245])for(const zz of[-p.bodySign*.221,p.bodySign*.701])wireCircle(outline,p.x+xx,H+.113+(r.wheels?.liftX||0),p.z+zz,.069,'z',color,8);
      for(const belt of p.belts)line(isDigging?leaders:outline,belt.top,belt.bottom,isDigging?'#829e8d':'#c7d2cb');
      wireBox(isDigging?leaders:outline,p.x,p.gripperY+.019,p.z,.614,.038,.399,color);
      if(p.loaded){
        renderedBins.add(p.binId);
        if(!tracedBinSet.has(p.binId)&&!traceBlockerSet.has(p.binId)){
          cube(ghosts,p.x,p.binY,p.z,.649,bh,.449,ghostColor);
          wireBox(binLines,p.x,p.binY,p.z,.649,bh,.449,binEdgeColor);
        }
      }
    }
    for(const p of ports()){
      const q=portLayout(p);
      if(q.type==='buffer3'){
        // Bearing outlines come from the shared static mesh.
        for(const slot of q.slots){const atWork=Math.hypot(slot.x-q.work[0],slot.z-q.work[1])<.035,color=atWork?'#5a8b74':'#a1aebb';line(l,[q.hub[0],q.baseY-.024,q.hub[1]],[slot.x,q.baseY-.024,slot.z],color);rect(l,slot.x,slot.z,q.baseY-.012,.68,.48,color);}
      }
      const wh=q.station.workHeightM,w=q.outX?.455:.655,d=q.outX?.655:.455;
      const u=(q.work[0]-q.origin[0])*(-q.outZ)+(q.work[1]-q.origin[1])*q.outX,v=(q.work[0]-q.origin[0])*q.outX+(q.work[1]-q.origin[1])*q.outZ;
      const opening=clamp(p.aperture?.openness??0,0,1);
      if(q.type==='single'){
        appendTranslated(context,buildStationApertureGeometry(p,{width:data.width,depth:data.depth,binHeight:bh}),0,0,0);
      }else for(const side of [-1,1]){const center=stationPoint(q,u+side*(w/4+opening*w/2),v);wireBox(l,center[0],wh+.050,center[1],q.outX?d+.006:w/2+.003,.022,q.outX?w/2+.003:d+.006,'#8795a2');}
      appendTranslated(picking,buildPickingGeometry(p,{width:data.width,depth:data.depth,binHeight:bh,reducedMotion}),0,0,0);
      const portLabel='trace-port-'+p.id;usedLabels.add(portLabel);
      label(portLabel,p.id+' · '+(q.type==='buffer3'?'3빈 버퍼':'일반 포트'),[q.work[0],wh+.64,q.work[1]],'port');
      // Inspection shows real hidden buffer bins as shaded cages; no stock is created
      // for reserved slots and a handed-over bin is rendered under one owner.
      for(const b of p.bins||[]){
        const id=b.id||b.binId;if(!id||renderedBins.has(id)||!Number.isFinite(b.x)||!Number.isFinite(b.z))continue;
        renderedBins.add(id);if(tracedBinSet.has(id)||traceBlockerSet.has(id))continue;
        const y=Number.isFinite(b.binY)?b.binY:q.baseY+bh/2;
        cube(ghosts,b.x*SX,y,b.z*SZ,.649,bh,.449,ghostColor);
        wireBox(binLines,b.x*SX,y,b.z*SZ,.649,bh,.449,binEdgeColor);
      }
    }
    // Blockers remain real, separately rimmed gray bins. The later red x-ray
    // layer always wins when a selected upper target is also a lower one's blocker.
    for(const p of getBinHighlightPoses(data,opts.traceBlockerBinIds)){
      if(tracedBinSet.has(p.binId))continue;
      const details=traceBinDetails(p);
      binGeometry(context,p.x,p.y,p.z,{...(typeof details==='object'?details:{}),id:p.binId,color:'#9da6aa'},'medium');
      // Follow the real tapered envelope and the existing 16 mm stacking lip.
      // Separate horizontal rims expose each layer without moving any bin.
      rect(contextLines,p.x,p.z,p.y+bh/2,.649,.449,'#58676f');
      rect(contextLines,p.x,p.z,p.y+bh/2-.016,.649,.449,'#58676f');
      rect(contextLines,p.x,p.z,p.y-bh/2,.633,.433,'#7c888e');
      for(const dx of[-1,1])for(const dz of[-1,1])line(contextLines,[p.x+dx*.3165,p.y-bh/2,p.z+dz*.2165],[p.x+dx*.3245,p.y+bh/2,p.z+dz*.2245],'#626e73');
    }
    selectedStack(solid,leaders,tracedBinIds);
    const selectedRobot=(data.robots||[]).find(r=>r.id===opts.selectedRobotId);
    const route=selectedRobot?.route||[],routeY=H+.075;
    for(let i=1;i<route.length;i++){
      const a=[route[i-1].x*SX,routeY,route[i-1].z*SZ],b=[route[i].x*SX,routeY,route[i].z*SZ];
      segmentBox(solid,a,b,.055,.01,'#148976');
      const delta=V.sub(b,a),length=Math.hypot(delta[0],delta[2]);if(length<.12)continue;
      const dx=delta[0]/length,dz=delta[2]/length,t=Math.min(.16,length*.35),tip=[b[0]-dx*.04,routeY+.002,b[2]-dz*.04];
      const left=[tip[0]-dx*t-dz*.065,tip[1],tip[2]-dz*t+dx*.065],right=[tip[0]-dx*t+dz*.065,tip[1],tip[2]-dz*t-dx*.065];
      quad(solid,[tip,right,left,left],[0,1,0],rgb('#148976'));
    }
    if(route.length>1){const end=route.at(-1);rect(leaders,end.x*SX,end.z*SZ,routeY+.003,.19,.15,'#148976');}
    const nextBinId=selectedRobot?.hoist?.binId||selectedRobot?.jobTargetBinId;
    if(nextBinId&&!tracedBinSet.has(nextBinId))for(const p of getBinHighlightPoses(data,[nextBinId])){
      const details=traceBinDetails(p);
      binGeometry(solid,p.x,p.y,p.z,{...details,id:p.binId,color:'#ddaf5d'},'high');
      wireBox(leaders,p.x,p.y,p.z,.655,bh+.004,.455,'#986723');
      const k='robot-target-'+p.binId;usedLabels.add(k);
      label(k,p.binId+' · '+(selectedRobot.hoist?.binId?'운반 중':'다음 작업 빈'),[p.x,p.y+bh/2+.18,p.z],'digging',true);
    }
    for(const p of getBinHighlightPoses(data,tracedBinIds)){
      const details=traceBinDetails(p);
      binGeometry(solid,p.x,p.y,p.z,{...(typeof details==='object'?details:{}),id:p.binId,color:'#ef3037'},'high');
      wireBox(leaders,p.x,p.y,p.z,.655,bh+.004,.455,'#aa242d');
      const gx=Math.round(p.x/SX),gz=Math.round(p.z/SZ),columnKey=`${gx},${gz}`,cell=p.location==='grid'&&activeMap.get(columnKey);
      if(cell&&!outlinedColumns.has(columnKey)){
        outlinedColumns.add(columnKey);
        wireBox(l,gx*SX,H/2+.028,gz*SZ,SX-.015,H+.055,SZ-.015,'#db9690');
        rect(l,gx*SX,gz*SZ,.016,SX-.035,SZ-.035,'#c7625e');
      }else if(!cell)rect(l,p.x,p.z,.016,.705,.480,'#c7625e');
      // Trace highlighting is sufficient; no forced floating bin label.

    }
    for(const[k,n]of labelNodes)if(!usedLabels.has(k)){n.remove();labelNodes.delete(k);}
    editHandles.style.display='none';
    // Picking and tracked bins share one depth buffer: the x-ray bin cannot
    // paint over a parcel that has already cleared its rim.
    appendTranslated(solid,picking,0,0,0);
    // Hoist plates and belts belong in the same physical depth layer as the
    // highlighted bins they grip, preserving the closed plate above the rim.
    appendTranslated(solid,lifting,0,0,0);
    dynamicMesh=mesh(context,dynamicMesh);overlayMesh=mesh(l,overlayMesh);highlightMesh=mesh(solid,highlightMesh);highlightLineMesh=mesh(leaders,highlightLineMesh);dynamicGhostMesh=mesh(ghosts,dynamicGhostMesh);dynamicBinLineMesh=mesh(binLines,dynamicBinLineMesh);contextLineMesh=mesh(contextLines,contextLineMesh);
  }
  function dynamic() {
    hoveredStack();
    if(tracing()){dynamicTrace();return;}
    if(dynamicGhostMesh?.count)dynamicGhostMesh=mesh([],dynamicGhostMesh);
    if(dynamicBinLineMesh?.count)dynamicBinLineMesh=mesh([],dynamicBinLineMesh);
    if(contextLineMesh?.count)contextLineMesh=mesh([],contextLineMesh);
    const a=[],covers=[],l=[],highlights=[],highlightLines=[],H=top(),usedLabels=new Set();
    selectedStack(highlights,highlightLines);
    if(opts.showPaths)for(const p of (data.activePaths||[]))for(let i=1;i<(p.cells||[]).length;i++) {
      const s=p.cells[i-1],t=p.cells[i];segmentBox(a,[s.x*SX,H+.059,s.z*SZ],[t.x*SX,H+.059,t.z*SZ],.045,.02,p.color||'#68bfa5');
    }
    for(const r of opts.editing&&editOptions.topView?[]:data.robots||[]) {
      if(!Number.isFinite(r.x)||!Number.isFinite(r.z)||r.onGrid===false||r.available===false)continue;
      const p=getRobotPose(r,H,data.binHeight),tracked=opts.followRobotId===r.id||opts.followRobotId==='auto'&&followedRobot()?.id===r.id;
      const key=`${r.id}:${p.bodySign}`;
      if(!robotGeometryCache.has(key))robotGeometryCache.set(key,buildRobotGeometry(r,{wheels:false}));
      appendTranslated(a,robotGeometryCache.get(key),p.x,H,p.z);
      appendTranslated(a,wheelGeometry(r),p.x,H,p.z);
      // Four flat steel belts stay vertically aligned with the suspended frame.
      for(const belt of p.belts){
        const length=Math.max(.003,belt.top[1]-belt.bottom[1]);
        cube(a,belt.top[0],(belt.top[1]+belt.bottom[1])/2,belt.top[2],.018,length,.005,'#a2afb6');
        line(l,belt.top,belt.bottom,'#7e929e');
      }
      appendTranslated(a,gripperGeometry[p.loaded?1:0],p.x,p.gripperY,p.z);
      if(p.loaded)binGeometry(a,p.x,p.binY,p.z,r.bin||{id:p.binId},opts.followRobotId===r.id||opts.cutaway?'high':'medium');
      const phases={'idle':'대기','lower-empty':'그리퍼 하강','grip':'체결','raise-loaded':'빈 인양','move':p.loaded?'빈 운반':'이동','lower-loaded':'빈 하강','release':'분리','raise-empty':'그리퍼 복귀','pick':'피킹'};
      const phase=phases[r.hoist?.phase]||r.status||'';
      const role=/optimize/i.test(r.jobRole||'')?'유휴 재배치':/dig|relocat|helper|협업|디깅/i.test(r.jobRole||'')?'협업 디깅':/return|회수/i.test(r.jobRole||'')?'반환 회수':/fetch|deliver|outbound|반출/i.test(r.jobRole||'')?'주문 반출':'';
      const k=`robot-${r.id}`,number=String(r.id||'1').replace(/\D/g,'').slice(-3).padStart(3,'0');usedLabels.add(k);label(k,`로봇 ${number}${role?' · '+role:''} · ${phase}`,[p.bodyX,H+.82,p.bodyZ],'robot');
    }
    const renderedBins=new Set((data.robots||[]).filter(r=>r.hoist?.loaded).map(r=>r.hoist.binId));
    for(const pv of ports()) {
      const q=portLayout(pv),buffer=q.type==='buffer3',detailed=opts.followPortId===pv.id||selected&&selected.x===pv.x&&selected.z===pv.z;
      if(buffer&&opts.stationInterior) {
        // Trays and arms follow the engine's current carousel angle/slot positions.
        // A single port queue counts reservations, shuttling, picking and return
        // stock against the same three-bin capacity; the renderer creates none.
        for(const slot of q.slots) {
          const armY=Math.max(-.014,q.baseY-.038),work=Math.hypot(slot.x-q.work[0],slot.z-q.work[1])<.035;
          beamBetween(a,[q.hub[0],armY,q.hub[1]],[slot.x,armY,slot.z],.11,.035,'#65818a');
          cube(a,slot.x,q.baseY-.012,slot.z,.68,.024,.48,work?'#517451':'#78897d');
          for(const dz of[-.2335,.2335])cube(a,slot.x,q.baseY+.008,slot.z+dz,.68,.016,.012,'#9ca99f');
          if(detailed) {
            const key=`slot-${pv.id}-${slot.index}`;usedLabels.add(key);
            label(key,pv.status==='rotating'?'회전 중':work?'피킹 위치':`대기 ${slot.index}`,[slot.x,q.baseY+.025,slot.z],'axis');
          }
        }
      }
      let visibleCount=0;
      for(const b of getVisiblePortBins(pv,{stationInterior:true})) {
        const id=b.id||b.binId;if(!id||renderedBins.has(id)||!Number.isFinite(b.x)||!Number.isFinite(b.z))continue;
        renderedBins.add(id);visibleCount++;
        const bx=b.x*SX,bz=b.z*SZ,by=Number.isFinite(b.binY)?b.binY:q.baseY+data.binHeight/2;
        const state=String(b.status||b.state||b.role||''),picking=/pick|work|피킹/i.test(state),returning=/return|collect|ready|transfer-out|outbound|회수/i.test(state);
        binGeometry(a,bx,by,bz,b,'high');
        if(detailed) {
          const k=`portbin-${pv.id}-${id}`;usedLabels.add(k);
          const role=picking?'피킹':returning?'회수':/shuttle|transfer|present|moving/i.test(state)?'이송':'대기';
          label(k,`${id} · ${role}`,[bx,by+data.binHeight/2+.075,bz],'port');
        }
      }
      appendTranslated(a,buildPickingGeometry(pv,{width:data.width,depth:data.depth,binHeight:data.binHeight,reducedMotion}),0,0,0);
      if(!opts.stationInterior)appendTranslated(covers,buildStationTopGeometry(pv,{width:data.width,depth:data.depth,binHeight:data.binHeight}),0,0,0);
      appendTranslated(buffer?covers:a,buildStationApertureGeometry(pv,{width:data.width,depth:data.depth,binHeight:data.binHeight,stationInterior:opts.stationInterior}),0,0,0);
      const k=`port-${pv.id}`;usedLabels.add(k);
      const busy=visibleCount>0||pv.activeRequestId||pv.status&&pv.status!=='idle';
      label(k,`${pv.id}${buffer?` · 3빈 버퍼 ${(pv.bins||[]).length}/3`:busy?' · 작업 중':''}${pv.operational===false?' · 설치 조건 확인':''}`,[q.work[0],q.station.workHeightM+.24,q.work[1]],'port');
    }
    const corners=[['axis-x',`${data.width}칸 · ${(data.width*SX).toFixed(2)}m`,[(data.width-1)*SX/2,.01,-SZ*1.02]],['axis-z',`${data.depth}칸 · ${(data.depth*SZ).toFixed(2)}m`,[-SX*.83,.01,(data.depth-1)*SZ/2]]];
    for(const [k,t,p]of corners){usedLabels.add(k);label(k,t,p,'axis');}
    for(const [i,p]of getBinHighlightPoses(data,opts.highlightBinIds).entries()){
      const w=.663,d=.463,h=data.binHeight+.014,color='#207c3e',stroke=.026,beacon=p.location==='port'?Math.max(p.y+h/2+.38,H+.55):H+.82+i*.018;
      for(const dx of[-1,1])for(const dz of[-1,1])cube(highlights,p.x+dx*w/2,p.y,p.z+dz*d/2,stroke,h,stroke,color);
      for(const dy of[-1,1]){
        for(const dz of[-1,1])cube(highlights,p.x,p.y+dy*h/2,p.z+dz*d/2,w,stroke,stroke,color);
        for(const dx of[-1,1])cube(highlights,p.x+dx*w/2,p.y+dy*h/2,p.z,stroke,stroke,d,color);
      }
      line(highlightLines,[p.x,p.y+h/2,p.z],[p.x,beacon,p.z],color);
      cube(highlights,p.x,beacon,p.z,.11,.045,.11,'#b9d995');
      rect(highlightLines,p.x,p.z,beacon+.024,.135,.135,color);
      // Keep highlight geometry without a floating bin label.
    }
    if(opts.editing){
      const ghost=editPreview?.port;
      if(ghost){const q=portLayout(ghost),k='edit-port-preview',state={valid:'배치 가능',warning:'설치 조건 확인',invalid:'배치 불가'}[editPreview.status]||'배치 미리보기';
        const delta=Number(editPreview.capacityDelta)||0;
        usedLabels.add(k);label(k,`${ghost.type==='buffer3'?'3빈 버퍼':'일반 포트'} · ${state}${delta?` · ${delta>0?'+':''}${delta.toLocaleString('ko-KR')} SKU`:''}`,[q.work[0],q.station.workHeightM+.42,q.work[1]],'axis',true);
        const side='edit-operator-direction';usedLabels.add(side);label(side,'작업자 방향',[q.work[0]+q.outX*.70,q.station.workHeightM+.12,q.work[1]+q.outZ*.70],'axis',true);
      }
      const port=ports().find(p=>p.id===editOptions.selectedPortId);
      if(port&&!ghost){const q=portLayout(port),k='edit-port-selected';usedLabels.add(k);label(k,`${port.id} · 드래그로 이동`,[q.work[0],q.station.workHeightM+.4,q.work[1]],'port',true);}
    }
    for(const[k,n]of labelNodes)if(!usedLabels.has(k)){n.remove();labelNodes.delete(k);}
    editHandles.style.display=opts.editing?'block':'none';
    if(opts.editing)for(const [axis,button]of expandHandles){
      const point=project(axis==='width'?[(data.width-.5)*SX+.36,H+.12,(data.depth-1)*SZ/2]:[(data.width-1)*SX/2,H+.12,(data.depth-.5)*SZ+.36]);
      button.disabled=false;button.style.opacity=button.disabled?'.4':'1';
      button.style.display=!point||point.z>1||point.x<0||point.x>canvasWidth||point.y<0||point.y>canvasHeight?'none':'block';
      if(point){button.style.left=`${clamp(point.x,32,Math.max(32,canvasWidth-32))}px`;button.style.top=`${clamp(point.y,26,Math.max(26,canvasHeight-26))}px`;}
    }
    for(const [cell,isSelected] of [[selected,true],[hover,false]]) {
      if(!cell||cell.x<0||cell.z<0||cell.x>=data.width||cell.z>=data.depth)continue;
      if(!isSelected&&selected&&cell.x===selected.x&&cell.z===selected.z)continue;
      const x=cell.x*SX,z=cell.z*SZ,c=activeMap.get(`${cell.x},${cell.z}`),color=isSelected?'#24684c':tool==='erase'&&opts.editing?'#d36c63':'#7da696';
      const y=c?H+.09:.03;
      rect(l,x,z,y,SX-.018,SZ-.018,color);
      // Wide, flat borders are consistent across browsers with 1px-only WebGL lines.
      for(const dz of [-1,1])cube(a,x,y,z+dz*(SZ/2-.011),SX-.008,.012,.018,color);
      for(const dx of [-1,1])cube(a,x+dx*(SX/2-.011),y,z,.018,.012,SZ-.008,color);
      if(!c&&tool==='add') {
        for(const dx of [-1,1])for(const dz of [-1,1])line(l,[x+dx*SX/2,.02,z+dz*SZ/2],[x+dx*SX/2,H,z+dz*SZ/2],color);
        rect(l,x,z,H,SX,SZ,color);
      }
      if(isSelected&&c)for(const dx of [-1,1])for(const dz of [-1,1])line(l,[x+dx*SX/2,.02,z+dz*SZ/2],[x+dx*SX/2,H+.09,z+dz*SZ/2],color);
    }
    coverMesh=mesh(covers,coverMesh);
    dynamicMesh=mesh(a,dynamicMesh);overlayMesh=mesh(l,overlayMesh);highlightMesh=mesh(highlights,highlightMesh);highlightLineMesh=mesh(highlightLines,highlightLineMesh);
  }
  function resize() {
    // Keep the captured canvas intact while a modal is open, including rotation/resize.
    if(renderSuspended)return;
    const r=canvas.getBoundingClientRect();canvasWidth=Math.max(1,r.width);canvasHeight=Math.max(1,r.height);
    const dpr=cpu?softwareScale:Math.min(window.devicePixelRatio||1,2),w=Math.round(canvasWidth*dpr),h=Math.round(canvasHeight*dpr);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    if(gl)gl.viewport(0,0,w,h);else softwareCache=null;
    updateCamera();
  }
  // CPU 3D uses the same camera and geometry, with a cached static color/depth
  // buffer. Moving belts, grippers and bins are depth-tested against the cached
  // warehouse instead of repainting thousands of unchanged polygons each frame.
  function cpuPoint(a,i) {
    const x=a[i],y=a[i+1],z=a[i+2];
    const w=vp[3]*x+vp[7]*y+vp[11]*z+vp[15];
    if(w<=.025)return null;
    return [((vp[0]*x+vp[4]*y+vp[8]*z+vp[12])/w*.5+.5)*canvas.width,
      (.5-(vp[1]*x+vp[5]*y+vp[9]*z+vp[13])/w*.5)*canvas.height,w,
      (vp[2]*x+vp[6]*y+vp[10]*z+vp[14])/w*.5+.5];
  }
  function cpuColor(a,i,shade=1) {
    const r=Math.round(clamp(a[i+6]*shade,0,1)*255),g=Math.round(clamp(a[i+7]*shade,0,1)*255),b=Math.round(clamp(a[i+8]*shade,0,1)*255);
    return (255<<24)|(b<<16)|(g<<8)|r;
  }
  const cpuLight=V.norm([-.45,.9,.5]);
  function blendPixel(color,background,alpha){
    const r=Math.round((color&255)*alpha+(background&255)*(1-alpha)),g=Math.round(((color>>>8)&255)*alpha+((background>>>8)&255)*(1-alpha)),b=Math.round(((color>>>16)&255)*alpha+((background>>>16)&255)*(1-alpha));
    return (255<<24)|(b<<16)|(g<<8)|r;
  }
  function cpuTriangle(p0,p1,p2,color,pixels,depth,alpha=1) {
    const w=canvas.width,h=canvas.height;
    const area=(p1[1]-p2[1])*(p0[0]-p2[0])+(p2[0]-p1[0])*(p0[1]-p2[1]);
    if(Math.abs(area)<1e-7)return;
    const x0=Math.max(0,Math.floor(Math.min(p0[0],p1[0],p2[0]))),x1=Math.min(w-1,Math.ceil(Math.max(p0[0],p1[0],p2[0])));
    const y0=Math.max(0,Math.floor(Math.min(p0[1],p1[1],p2[1]))),y1=Math.min(h-1,Math.ceil(Math.max(p0[1],p1[1],p2[1])));
    if(x1<x0||y1<y0)return;
    const inv=1/area,aX=(p1[1]-p2[1])*inv,aY=(p2[0]-p1[0])*inv,bX=(p2[1]-p0[1])*inv,bY=(p0[0]-p2[0])*inv;
    let rowA=aX*(x0+.5-p2[0])+aY*(y0+.5-p2[1]),rowB=bX*(x0+.5-p2[0])+bY*(y0+.5-p2[1]);
    const zA=p0[3]-p2[3],zB=p1[3]-p2[3],zBase=p2[3];
    const zX=aX*zA+bX*zB;
    for(let y=y0;y<=y1;y++,rowA+=aY,rowB+=bY){
      let aa=rowA,bb=rowB,z=zBase+rowA*zA+rowB*zB,index=y*w+x0;
      for(let x=x0;x<=x1;x++,index++,aa+=aX,bb+=bX,z+=zX){
        if(aa>=-.00001&&bb>=-.00001&&aa+bb<=1.00001&&z>=0&&z<=1&&z<=depth[index]){depth[index]=z;pixels[index]=alpha<1?blendPixel(color,pixels[index],alpha):color;}
      }
    }
  }
  function cpuLine(p,q,color,pixels,depth) {
    const w=canvas.width,h=canvas.height,dx=q[0]-p[0],dy=q[1]-p[1],steps=Math.min(4096,Math.ceil(Math.max(Math.abs(dx),Math.abs(dy))));
    if(!steps)return;
    for(let i=0;i<=steps;i++) {
      const t=i/steps,x=Math.round(p[0]+dx*t),y=Math.round(p[1]+dy*t),z=p[3]+(q[3]-p[3])*t-.000003;
      if(x>=0&&y>=0&&x<w&&y<h){const k=y*w+x;if(z<=depth[k]){pixels[k]=color;depth[k]=z;}}
    }
  }
  function cpuRaster(m,isLine,pixels,depth,alpha=1) {
    if(!m?.array)return;
    const a=m.array,step=isLine?18:54;
    for(let i=0;i<a.length;i+=step) {
      if(!isLine) {
        const facing=a[i+3]*(eye[0]-a[i])+a[i+4]*(eye[1]-a[i+1])+a[i+5]*(eye[2]-a[i+2]);
        if(facing<=0)continue;
      }
      const p0=cpuPoint(a,i),p1=cpuPoint(a,i+9);if(!p0||!p1)continue;
      const color=cpuColor(a,i,isLine?1:.63+.37*Math.max(0,a[i+3]*cpuLight[0]+a[i+4]*cpuLight[1]+a[i+5]*cpuLight[2]));
      if(isLine){cpuLine(p0,p1,color,pixels,depth);continue;}
      const p2=cpuPoint(a,i+18),p3=cpuPoint(a,i+45);if(!p2||!p3)continue;
      cpuTriangle(p0,p1,p2,color,pixels,depth,alpha);cpuTriangle(p0,p2,p3,color,pixels,depth,alpha);
    }
  }
  function renderSoftware() {
    const isTrace=tracing(),hasGhosts=isTrace&&(staticGhostMesh?.count||dynamicGhostMesh?.count);
    const key=[...vp,canvas.width,canvas.height,staticMesh?.version,lineMesh?.version,staticGhostMesh?.version,staticBinLineMesh?.version,isTrace,!!hasGhosts].join('|'),size=canvas.width*canvas.height;
    if(!softwareImage||softwareImage.width!==canvas.width||softwareImage.height!==canvas.height){
      softwareImage=cpu.createImageData(canvas.width,canvas.height);softwarePixels=new Uint32Array(softwareImage.data.buffer);softwareDepth=new Float32Array(size);softwareCache=null;
    }
    if(softwareCache?.key!==key){
      const pixels=new Uint32Array(size),depth=new Float32Array(size);pixels.fill(0xfff7f5f5);depth.fill(Infinity);
      cpuRaster(staticMesh,false,pixels,depth);if(!isTrace)cpuRaster(lineMesh,true,pixels,depth);
      let ghostPixels=null,ghostDepth=null;
      if(hasGhosts){
        ghostPixels=new Uint32Array(size);ghostDepth=new Float32Array(size);ghostDepth.fill(Infinity);
        cpuRaster(staticGhostMesh,false,ghostPixels,ghostDepth);
      }
      softwareCache={key,pixels,depth,ghostPixels,ghostDepth};
    }
    softwarePixels.set(softwareCache.pixels);softwareDepth.set(softwareCache.depth);
    if(hasGhosts){
      if(softwareGhostPixels?.length!==size){softwareGhostPixels=new Uint32Array(size);softwareGhostDepth=new Float32Array(size);}
      softwareGhostPixels.set(softwareCache.ghostPixels);softwareGhostDepth.set(softwareCache.ghostDepth);
      cpuRaster(dynamicGhostMesh,false,softwareGhostPixels,softwareGhostDepth);
      // One shaded face per pixel; retain its depth only for background lines.
      // This avoids opacity accumulation and hides rear edges inside each bin.
      for(let i=0;i<size;i++)if(softwareGhostDepth[i]!==Infinity)
        softwarePixels[i]=blendPixel(softwareGhostPixels[i],softwarePixels[i],ghostAlpha);
      softwareDepth.set(softwareGhostDepth);
    }else{softwareGhostPixels=softwareGhostDepth=null;}
    if(isTrace){
      cpuRaster(lineMesh,true,softwarePixels,softwareDepth);cpuRaster(overlayMesh,true,softwarePixels,softwareDepth);
      cpuRaster(staticBinLineMesh,true,softwarePixels,softwareDepth);cpuRaster(dynamicBinLineMesh,true,softwarePixels,softwareDepth);
      // Selected digging context is a separate x-ray layer. No unrelated bin,
      // rail or robot line may pierce its solid faces or obscure its own rims.
      softwareDepth.fill(Infinity);cpuRaster(dynamicMesh,false,softwarePixels,softwareDepth);cpuRaster(contextLineMesh,true,softwarePixels,softwareDepth);
    }else{cpuRaster(dynamicMesh,false,softwarePixels,softwareDepth);cpuRaster(overlayMesh,true,softwarePixels,softwareDepth);cpuRaster(coverMesh,false,softwarePixels,softwareDepth,PORT_COVER_OPACITY);}
    if(hoverMesh?.count){
      if(softwareHoverPixels?.length!==size){softwareHoverPixels=new Uint32Array(size);softwareHoverDepth=new Float32Array(size);}
      softwareHoverPixels.fill(0);softwareHoverDepth.fill(Infinity);
      cpuRaster(hoverMesh,false,softwareHoverPixels,softwareHoverDepth);
      for(let i=0;i<size;i++)if(softwareHoverDepth[i]!==Infinity)softwarePixels[i]=blendPixel(softwareHoverPixels[i],softwarePixels[i],hoverFillAlpha);
      softwareHoverPixels.fill(0);cpuRaster(hoverLineMesh,true,softwareHoverPixels,softwareHoverDepth);
      for(let i=0;i<size;i++)if(softwareHoverPixels[i])softwarePixels[i]=blendPixel(softwareHoverPixels[i],softwarePixels[i],hoverEdgeAlpha);
    }
    if(highlightMesh?.count){softwareDepth.fill(Infinity);cpuRaster(highlightMesh,false,softwarePixels,softwareDepth);cpuRaster(highlightLineMesh,true,softwarePixels,softwareDepth);}
    if(opts.editing&&(editFillMesh?.count||editOutlineMesh?.count||editLineMesh?.count)){
      softwareDepth.fill(Infinity);cpuRaster(editFillMesh,false,softwarePixels,softwareDepth,.15);
      softwareDepth.fill(Infinity);cpuRaster(editOutlineMesh,false,softwarePixels,softwareDepth);cpuRaster(editLineMesh,true,softwarePixels,softwareDepth);
    }
    cpu.putImageData(softwareImage,0,0);
  }
  function render(now=performance.now()) {
    if(dead||renderSuspended)return;
    if(document.hidden||canvas.offsetParent===null||canvasWidth<2||canvasHeight<2){raf=requestAnimationFrame(render);return;}
    if(cpu&&now-lastSoftwareFrame<30){raf=requestAnimationFrame(render);return;}
    if(cpu){
      const r=followedRobot(),position=r?`${r.id}:${r.x.toFixed(4)},${r.z.toFixed(4)}`:'';
      if(position&&lastFollowPosition&&position!==lastFollowPosition)cameraInputAt=now;
      lastFollowPosition=position;
      // During camera motion, reduce only the raster resolution. Full detail is
      // restored as soon as the camera settles; UI and labels stay full-sized.
      const scale=now-cameraInputAt<150?Math.min(1,Math.sqrt(300000/(canvasWidth*canvasHeight))):1;
      if(Math.abs(scale-softwareScale)>.001){softwareScale=scale;resize();}
    }
    // An idle scene must be genuinely idle: unchanged frames do no projection,
    // DOM label writes, buffer rebuilds, polygon sorting, or canvas painting.
    const frameSignature=[yaw,pitch,zoom,panX,panZ,canvasWidth,canvasHeight,canvas.width,canvas.height,
      staticMesh?.version,lineMesh?.version,staticGhostMesh?.version,staticBinLineMesh?.version,tool,selected?.x,selected?.z,opts.selectedRobotId,hover?.x,hover?.z,editRevision,editOptions.topView,
      opts.showBins,opts.showPaths,opts.showLabels,opts.cutaway,opts.stationInterior,opts.editing,opts.followRobotId,opts.followPortId,opts.highlightBinIds.join(','),tracedBinIds.join(','),traceContextSignature,binCameraTarget?.x,binCameraTarget?.y,binCameraTarget?.z,binCameraTarget?.radius,binCameraTarget?.boundsRadius,operatorView,
      (data.robots||[]).map(r=>`${r.id}:${r.x},${r.z}:${r.bodySign}:${r.available}:${r.onGrid}:${r.status||''}:${r.jobRole||''}:${r.parentOrderId||''}:${r.jobTargetBinId}:${(r.route||[]).map(p=>p.x+','+p.z).join(';')}:${r.wheels?.liftX}:${r.wheels?.liftZ}:${r.hoist?.phase}:${r.hoist?.operation||''}:${r.hoist?.gripperY}:${r.hoist?.binY}:${r.hoist?.binId}:${r.hoist?.loaded}:${r.bin?.color||''}`).join('|'),
      data.cells.filter(c=>c.portId).map(c=>`${c.portId}:${c.x},${c.z}:${c.portBinId||''}:${c.portBusy?1:0}`).join('|'),
      ports().map(p=>`${p.id}:${p.activeRequestId||''}:${p.status||''}:${p.aperture?.openness}:${p.presentation?.binId}:${p.presentation?.pickAllowed}:${p.layout?.angle||0}:${(p.slots||[]).map(s=>`${s.index}:${s.x},${s.z}:${s.role}:${s.status}:${s.binId||''}`).join(';')}:${(p.bins||[]).map(b=>`${b.id||b.binId}:${b.x},${b.z},${b.binY}:${b.role}:${b.status||b.state}:${reducedMotion?0:b.progress}:${b.color||''}`).join(';')}`).join('|'),
      (data.activePaths||[]).map(p=>`${p.color||''}:${(p.cells||[]).map(c=>`${c.x},${c.z}`).join(';')}`).join('|')
    ].join('/');
    if(frameSignature===lastRenderedSignature){raf=requestAnimationFrame(render);return;}
    lastSoftwareFrame=now;updateCamera();
    if(gl){
      gl.clearColor(.961,.961,.969,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);
      gl.useProgram(program);gl.uniformMatrix4fv(vpUniform,false,vp);
      dynamic();
      if(tracing()){
        draw(staticMesh,gl.TRIANGLES);drawGhosts();draw(lineMesh,gl.LINES);draw(overlayMesh,gl.LINES);
        // Match the software edge bias without changing any physical envelope.
        gl.depthRange(0,.999997);draw(staticBinLineMesh,gl.LINES);draw(dynamicBinLineMesh,gl.LINES);gl.depthRange(0,1);
        // Focused solids cover background wires even when those wires would be
        // nearer in the warehouse; their own depth ordering remains physical.
        gl.clear(gl.DEPTH_BUFFER_BIT);draw(dynamicMesh,gl.TRIANGLES);
        gl.depthRange(0,.999997);draw(contextLineMesh,gl.LINES);gl.depthRange(0,1);
      }else{draw(staticMesh,gl.TRIANGLES);draw(lineMesh,gl.LINES);draw(dynamicMesh,gl.TRIANGLES);draw(overlayMesh,gl.LINES);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);draw(coverMesh,gl.TRIANGLES,PORT_COVER_OPACITY);gl.disable(gl.BLEND);}
      drawHoveredStack();
      if(highlightMesh?.count){
        // X-ray past the warehouse while retaining the red bin's own correct
        // wall/floor/rib depth ordering, matching the software renderer.
        gl.clear(gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);
        draw(highlightMesh,gl.TRIANGLES);draw(highlightLineMesh,gl.LINES);gl.enable(gl.DEPTH_TEST);
      }
      if(opts.editing&&(editFillMesh?.count||editOutlineMesh?.count||editLineMesh?.count)){
        gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);
        draw(editFillMesh,gl.TRIANGLES,.15);draw(editOutlineMesh,gl.TRIANGLES);draw(editLineMesh,gl.LINES);
        gl.depthMask(true);gl.disable(gl.BLEND);gl.enable(gl.DEPTH_TEST);
      }
    }else{dynamic();renderSoftware();}
    lastRenderedSignature=frameSignature;
    raf=requestAnimationFrame(render);
  }
  function pointerRay(clientX,clientY){
    if(!invVP)return null;
    const r=canvas.getBoundingClientRect(),nx=(clientX-r.left)/r.width*2-1,ny=1-(clientY-r.top)/r.height*2;
    const p0=transform(invVP,[nx,ny,-1,1]),p1=transform(invVP,[nx,ny,1,1]);
    const o=p0.slice(0,3).map(v=>v/p0[3]),far=p1.slice(0,3).map(v=>v/p1[3]);
    return {o,d:V.norm(V.sub(far,o))};
  }
  function planePoint(ray,height=top()){
    if(!ray||Math.abs(ray.d[1])<1e-8)return null;
    const {o,d}=ray,t=(height-o[1])/d[1];if(t<0)return null;
    return {x:o[0]+d[0]*t,z:o[2]+d[2]*t};
  }
  function planeCell(ray,height=top()){
    const point=planePoint(ray,height);if(!point)return null;
    const x=Math.floor(point.x/SX+.5),z=Math.floor(point.z/SZ+.5);
    return x>=0&&z>=0&&x<data.width&&z<data.depth?{x,z}:null;
  }
  function portDragCell(gesture,ray){
    if(!gesture.portOffset)return planeCell(ray);
    const point=planePoint(ray);if(!point)return null;
    const x=Math.round((point.x+gesture.portOffset.x)/SX),z=Math.round((point.z+gesture.portOffset.z)/SZ);
    return x>=0&&z>=0&&x<data.width&&z<data.depth?{x,z}:null;
  }
  function pickPort(clientX,clientY){
    const ray=pointerRay(clientX,clientY);if(!ray)return null;
    let hit=null,nearest=Infinity;
    for(const p of ports()){
      const q=portLayout(p),envelope=getStationEnvelope(p,{width:data.width,depth:data.depth,binHeight:data.binHeight});
      const boxes=envelope.rectangles.map(b=>({min:[b.minX,0,b.minZ],max:[b.maxX,q.station.workHeightM+.12,b.maxZ]}));
      for(const shaft of q.shafts)boxes.push({min:[shaft.x-SX/2,0,shaft.z-SZ/2],max:[shaft.x+SX/2,top()+.08,shaft.z+SZ/2]});
      for(const box of boxes){const t=rayBox(ray.o,ray.d,box.min,box.max);if(t<nearest){nearest=t;hit=p;}}
    }
    return hit;
  }
  function pickRobot(clientX,clientY){
    const ray=pointerRay(clientX,clientY);if(!ray)return null;
    let nearest=Infinity,hit=null;
    // Test actual drive housing and lift plate, not the empty hoist shaft.
    for(const r of data.robots||[]){
      if(r.available===false||r.onGrid===false)continue;
      const p=getRobotPose(r,top(),data.binHeight);
      const boxes=[[[p.bodyX-.34,p.bodyBaseY,p.bodyZ-.24],[p.bodyX+.34,p.bodyTopY,p.bodyZ+.24]],[[p.x-.307,p.gripperY,p.z-.20],[p.x+.307,p.gripperY+.043,p.z+.20]]];
      for(const [min,max]of boxes){const t=rayBox(ray.o,ray.d,min,max);if(t<nearest){nearest=t;hit=r;}}
    }
    // A buried plate cannot intercept a click through opaque grid bins.
    if(!tracing())for(const c of data.cells){const count=c.bins?.length||0;if(!count)continue;
      if(rayBox(ray.o,ray.d,[c.x*SX-.325,0,c.z*SZ-.225],[c.x*SX+.325,count*data.binHeight+.015,c.z*SZ+.225])<nearest)return null;
    }
    return hit;
  }
  function pick(clientX,clientY) {
    const ray=pointerRay(clientX,clientY);if(!ray)return null;
    const {o,d}=ray;
    // Editing addresses a single grid plane. Deleted cells and tall columns
    // therefore have the same target even when a front stack would occlude them.
    if(opts.editing&&(editOptions.topView||['add','erase','port'].includes(tool)||editOptions.movingPortId))return planeCell(ray,['add','erase'].includes(tool)?0:top());
    let hit=null,nearest=Infinity,H=top();
    for(const c of data.cells) {
      const t=rayBox(o,d,[c.x*SX-SX/2,0,c.z*SZ-SZ/2],[c.x*SX+SX/2,H+.05,c.z*SZ+SZ/2]);
      if(t<nearest){nearest=t;const facility=!opts.editing&&c.isEquipment?ports().find(p=>(c.facilityPortIds||[]).includes(p.id)||p.layout?.equipmentCells?.some(e=>e.x===c.x&&e.z===c.z)):null;hit=facility?{x:facility.x,z:facility.z}:{x:c.x,z:c.z};}
    }
    for(const p of ports()){
      const q=portLayout(p),b=stationLimits(q),t=rayBox(o,d,[b.minX,0,b.minZ],[b.maxX,q.station.workHeightM+.55,b.maxZ]);
      if(t<nearest){nearest=t;hit={x:p.x,z:p.z};}
    }
    // Bare floor is a placement target only while editing. It is not a cell.
    if(opts.editing&&Math.abs(d[1])>1e-8) {
      const t=-o[1]/d[1];
      if(t>=0&&t<nearest)hit=planeCell(ray,0)||hit;
    }
    return hit;
  }
  function setHover(c) {hover=c;const k=c?`${c.x},${c.z}`:'';if(k!==lastHoverKey){lastHoverKey=k;onHover(c?.x??-1,c?.z??-1);}}
  function publishGesture(gesture,phase,c=gesture?.lastCell){
    const kind=gesture?.gestureTool||(['add','erase','port'].includes(tool)?tool:'port');
    const cells=gesture?.cells?.size?[...gesture.cells.values()].map(v=>({...v})):c?[{...c}]:[];
    const value={phase,tool:kind,cells,x:c?.x??-1,z:c?.z??-1,...(gesture?.portId?{portId:gesture.portId}:{})};
    if(onEditGesture)onEditGesture(value);
    // The legacy callback is only a compatibility path, never a draft mutation
    // when the application supplies the transaction-aware gesture contract.
    else if(phase==='commit')for(const cell of cells)onCell(cell.x,cell.z,'start');
  }
  function collectCells(gesture,c){
    if(!c)return;
    if(!gesture.anchor)gesture.anchor={...c};
    if(editOptions.brush==='rectangle'){
      gesture.cells.clear();const a=gesture.anchor;
      for(let z=Math.min(a.z,c.z);z<=Math.max(a.z,c.z);z++)for(let x=Math.min(a.x,c.x);x<=Math.max(a.x,c.x);x++)gesture.cells.set(`${x},${z}`,{x,z});
    }else{
      const a=gesture.lastCell||c,steps=Math.max(Math.abs(c.x-a.x),Math.abs(c.z-a.z),1);
      for(let i=0;i<=steps;i++){const x=Math.round(a.x+(c.x-a.x)*i/steps),z=Math.round(a.z+(c.z-a.z)*i/steps);gesture.cells.set(`${x},${z}`,{x,z});}
    }
    gesture.lastCell={...c};
    const sig=[...gesture.cells.keys()].join('|');
    if(sig!==gesture.signature){gesture.signature=sig;publishGesture(gesture,'preview',c);}
  }
  function selectPort(p){if(onSelectPort)onSelectPort(p.id);else onInspect(p.x,p.z);}
  function cancelEditGesture(){
    const current=drag,had=!!(current?.paint||current?.portId||current?.selectPort||editPreview);
    if(current?.paint||current?.portId||current?.selectPort){drag=null;pointers.clear();pinch=null;}
    editPreview=null;editPreviewSignature='';rebuildEditPreview();lastHoverKey='';
    if(had)publishGesture(current,'cancel');
    canvas.style.cursor=opts.editing&&['add','erase','port'].includes(tool)?'crosshair':'grab';
    return had;
  }
  function leaveTopView(){
    if(opts.editing&&editOptions.topView){editOptions.topView=false;yaw=.86;pitch=.64;signature='';setData(data);onEditViewChange('iso');}
  }
  function listen(type,fn,options) {canvas.addEventListener(type,fn,options);listeners.push([type,fn,options]);}
  function touchPair(){
    const [a,b]=[...pointers.values()];
    return {distance:Math.hypot(b.x-a.x,b.y-a.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};
  }
  function limitZoom(value){
    const min=opts.editing&&editOptions.topView?Math.min(.28,editorTopFit(worldBounds(),canvasWidth,canvasHeight).pixelsPerMeter*SZ/88):.28;
    return clamp(value,min,3.3);
  }
  function panCamera(dx,dy){
    if(opts.editing&&editOptions.topView){const factor=2*editorTopFit(worldBounds(),canvasWidth,canvasHeight).half*zoom/canvasHeight;panX-=dx*factor;panZ-=dy*factor;return;}
    const factor=Math.max(data.width*SX,data.depth*SZ)*zoom/canvasHeight;
    panX+=(-dx*Math.sin(yaw)-dy*Math.cos(yaw))*factor;
    panZ+=(dx*Math.cos(yaw)-dy*Math.sin(yaw))*factor;
  }
  listen('contextmenu',e=>e.preventDefault());
  listen('pointerdown',e=>{
    if(e.button>2)return;setHover(null);e.preventDefault();canvas.focus({preventScroll:true});canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size>=2){
      if(drag?.paint||drag?.portId)publishGesture(drag,'cancel');
      pinch=touchPair();drag=null;setHover(null);return;
    }
    const left=e.button===0&&!e.shiftKey,pan=e.button===1||e.shiftKey||(opts.editing&&editOptions.topView&&tool==='orbit'&&e.button===0),cell=pick(e.clientX,e.clientY);
    const port=opts.editing&&left&&['select','port'].includes(tool)?pickPort(e.clientX,e.clientY):null;
    const movingId=opts.editing&&left?(editOptions.movingPortId||(tool==='select'&&port?.id===editOptions.selectedPortId?port.id:null)):null;
    // A cabinet face is lower than the rail and may sit outside the grid. Keep
    // the grabbed point's offset so direct dragging starts at the port anchor,
    // instead of jumping to the cursor's unrelated roof-plane intersection.
    const grabbed=movingId&&port&&tool==='select'&&!editOptions.movingPortId?planePoint(pointerRay(e.clientX,e.clientY)):null;
    const choosingPort=opts.editing&&left&&tool==='port'&&!movingId&&port;
    const paint=opts.editing&&left&&!choosingPort&&(['add','erase','port'].includes(tool)||!!movingId);
    drag={id:e.pointerId,x:e.clientX,y:e.clientY,startX:e.clientX,startY:e.clientY,orbit:e.button===2||!paint,pan,paint,button:e.button,
      gestureTool:movingId?'move-port':tool,portId:movingId,selectPort:choosingPort||null,sourcePort:port,
      portOffset:grabbed?{x:port.x*SX-grabbed.x,z:port.z*SZ-grabbed.z}:null,
      anchor:cell?{...cell}:null,lastCell:cell?{...cell}:null,cells:new Map(),signature:'',touch:e.pointerType==='touch',moved:false};
    if(paint&&['add','erase'].includes(tool)&&!movingId)collectCells(drag,cell);
    else if(paint&&movingId&&editOptions.movingPortId&&cell)publishGesture(drag,'preview',cell);
    canvas.style.cursor=pan||drag.orbit?'grabbing':movingId?'move':'crosshair';
  });
  listen('pointermove',e=>{
    if(pointers.has(e.pointerId))pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size>=2&&pinch){
      cameraInputAt=performance.now();const next=touchPair();
      panCamera(next.x-pinch.x,next.y-pinch.y);
      if(next.distance>5&&pinch.distance>5)zoom=limitZoom(zoom*pinch.distance/next.distance);
      pinch=next;return;
    }
    if(!drag||drag.id!==e.pointerId){setHover(e.pointerType==='touch'?null:pick(e.clientX,e.clientY));return;}
    const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;
    const distance=Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY);if(distance>=6)drag.moved=true;
    if(drag.pan){cameraInputAt=performance.now();panCamera(dx,dy);}
    else if(drag.portId){
      if(drag.moved||editOptions.movingPortId){const c=portDragCell(drag,pointerRay(e.clientX,e.clientY));setHover(c);if(c&&(c.x!==drag.lastCell?.x||c.z!==drag.lastCell?.z||!drag.signature)){drag.lastCell=c;drag.signature=`${c.x},${c.z}`;publishGesture(drag,'preview',c);}}
    }else if(drag.paint&&['add','erase'].includes(drag.gestureTool)){
      const c=pick(e.clientX,e.clientY);setHover(c);collectCells(drag,c);
    }else if(drag.orbit||drag.moved){
      cameraInputAt=performance.now();leaveTopView();operatorView=false;yaw+=dx*.007;pitch=clamp(pitch+dy*.006,.12,Math.PI/2-.012);
      if(drag.paint){drag.paint=false;drag.orbit=true;publishGesture(drag,'cancel');}
    }else setHover(pick(e.clientX,e.clientY));
  });
  function pointerEnd(e) {
    const wasPinch=!!pinch;pointers.delete(e.pointerId);pinch=pointers.size>=2?touchPair():null;
    const current=drag;
    if(current&&current.id===e.pointerId){
      const distance=Math.hypot(e.clientX-current.startX,e.clientY-current.startY),c=pick(e.clientX,e.clientY);drag=null;
      if(!wasPinch&&!current.pan&&current.button===0){
        if(current.portId){
          const target=portDragCell(current,pointerRay(e.clientX,e.clientY));
          if(target&&(current.moved||editOptions.movingPortId)){current.lastCell=target;publishGesture(current,'commit',target);}
          else if(current.sourcePort)selectPort(current.sourcePort);
          else publishGesture(current,'cancel');
        }else if(current.paint&&['add','erase'].includes(current.gestureTool)){
          collectCells(current,c);if(current.cells.size)publishGesture(current,'commit',current.lastCell);else publishGesture(current,'cancel');
        }else if(distance<6){
          if(current.selectPort)selectPort(current.selectPort);
          else if(current.paint&&current.gestureTool==='port'&&c)publishGesture(current,'commit',c);
          else{const p=opts.editing?pickPort(e.clientX,e.clientY):null,r=!opts.editing&&pickRobot(e.clientX,e.clientY);if(p)selectPort(p);else if(r)onInspectRobot(r.id);else if(c)onInspect(c.x,c.z);else if(!opts.editing)onClearSelection();}
        }
      }
    }
    if(!pointers.size)drag=null;
    if(e.pointerType==='touch'||current?.touch)setHover(null);
    canvas.style.cursor=opts.editing&&['add','erase','port'].includes(tool)?'crosshair':'grab';
  }
  listen('pointerup',pointerEnd);
  listen('pointercancel',()=>{setHover(null);cancelEditGesture();pointers.clear();drag=null;pinch=null;});
  listen('pointerleave',()=>{if(!drag)setHover(null);});
  listen('wheel',e=>{setHover(null);e.preventDefault();cameraInputAt=performance.now();zoom=limitZoom(zoom*Math.exp(e.deltaY*.001));},{passive:false});
  listen('keydown',e=>{
    cameraInputAt=performance.now();
    if(e.key==='ArrowLeft'){yaw-=.12;e.preventDefault();}if(e.key==='ArrowRight'){yaw+=.12;e.preventDefault();}
    if(e.key==='ArrowUp'){pitch=clamp(pitch+.08,.12,1.558);e.preventDefault();}if(e.key==='ArrowDown'){pitch=clamp(pitch-.08,.12,1.558);e.preventDefault();}
    if(e.key==='+'||e.key==='=')zoom=limitZoom(zoom*.9);if(e.key==='-')zoom=limitZoom(zoom*1.1);
  });
  const observer=new ResizeObserver(resize);observer.observe(canvas);
  function setData(next) {
    data={...data,...next};data.binHeight=Number(data.binHeight)||.33;data.levels=Math.max(1,Number(data.levels)||1);
    activeMap=new Map(data.cells.map(c=>[`${c.x},${c.z}`,c]));
    const portStructure=ports().map(p=>{const {angle,...layout}=p.layout||{};return `${p.id}:${p.type}:${p.x},${p.z}:${p.binBaseY}:${p.operational}:${JSON.stringify(layout)}:${JSON.stringify(p.installationBounds||[])}`;}).join(';');
    const s=[data.width,data.depth,data.floorWidthM,data.floorDepthM,data.levels,data.binHeight,opts.showBins,portBase(),opts.cutaway,opts.stationInterior,opts.editing,editOptions.topView,opts.highlightBinIds.join(','),tracedBinIds.join(','),opts.traceBlockerBinIds.join(','),selected?.x,selected?.z,opts.selectedRobotId,tracing(),[...cutawayColumns()].sort().join(';'),portStructure,data.cells.map(c=>`${c.x},${c.z}:${c.portId||''}:${c.isEquipment?1:0}:${c.reachable===false?0:1}:${(c.bins||[]).map(b=>`${b.id||b}:${b.color||getBinColor(b.id||b)}:${b.compartments||4}:${opts.cutaway||selected?.x===c.x&&selected?.z===c.z?(b.contents||[]).map(v=>`${v.category}:${v.qty}`).join('/') :''}`).join(',')}`).join(';')].join('|');
    if(s!==signature){signature=s;rebuild();rebuildEditPreview();}
  }
  function focusBins(ids){
    const poses=getBinHighlightPoses(data,normalizeBinIds(ids));if(!poses.length)return false;
    opts.followRobotId=opts.followPortId=null;operatorView=false;zoom=1;panX=panZ=0;
    if(poses.length===1){
      const p=poses[0],bounds=worldBounds();
      binCameraTarget={x:p.x,y:Math.max(p.y,top()*.4+.12),z:p.z,radius:Math.max(4.6,top()*1.3+2.4,Math.hypot(bounds.x1-bounds.x0,bounds.z1-bounds.z0)*.78)};
    }else{
      // Fit a sphere around every real target, including their roof-level
      // beacons. Its angular size stays valid when the viewport is resized or
      // the user orbits; moving inventory never forcibly recentres the camera.
      let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity,z0=Infinity,z1=-Infinity;
      const columnCounts=new Map();
      for(const p of poses){
        const key=`${Math.round(p.x/SX)},${Math.round(p.z/SZ)}`,index=columnCounts.get(key)||0;columnCounts.set(key,index+1);
        x0=Math.min(x0,p.x-.36);x1=Math.max(x1,p.x+.36);z0=Math.min(z0,p.z-.26);z1=Math.max(z1,p.z+.26);
        y0=Math.min(y0,p.y-data.binHeight/2);y1=Math.max(y1,Math.max(p.y+data.binHeight/2+.25,top()+.4)+index*.38+.16);
      }
      binCameraTarget={x:(x0+x1)/2,y:(y0+y1)/2,z:(z0+z1)/2,radius:4.6,boundsRadius:Math.hypot(x1-x0,y1-y0,z1-z0)/2};
    }
    yaw=getPortFacingYaw(data);pitch=.58;updateCamera();return true;
  }
  function stopFollowing(){
    if(!opts.followRobotId&&!opts.followPortId)return;
    updateCamera();
    // Freeze the current world-space aim and distance before releasing a
    // moving robot/port. Rendering a trace must not reframe the camera.
    const offset=eye.map((v,i)=>v-cameraAim[i]),distance=Math.hypot(...offset);
    const aspect=canvasWidth/canvasHeight,aspectScale=aspect<1?Math.min(1.7,1/aspect):1;
    binCameraTarget={x:cameraAim[0]-panX,y:cameraAim[1],z:cameraAim[2]-panZ,radius:distance/(aspectScale*zoom)};
    if(operatorView){yaw=Math.atan2(offset[2],offset[0]);pitch=Math.atan2(offset[1],Math.hypot(offset[0],offset[2]));}
    opts.followRobotId=opts.followPortId=null;operatorView=false;
    updateCamera();
  }
  function focusDigging(){
    if(!tracing())return false;
    const targets=getBinHighlightPoses(data,tracedBinIds);if(!targets.length)return false;
    const poses=getBinHighlightPoses(data,normalizeBinIds([...tracedBinIds,...opts.traceBlockerBinIds]));
    let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity,z0=Infinity,z1=-Infinity;
    const include=(x,y,z,rx,ry,rz)=>{x0=Math.min(x0,x-rx);x1=Math.max(x1,x+rx);y0=Math.min(y0,y-ry);y1=Math.max(y1,y+ry);z0=Math.min(z0,z-rz);z1=Math.max(z1,z+rz);};
    const columnCounts=new Map();
    for(const p of poses){
      include(p.x,p.y,p.z,.36,data.binHeight/2,.26);
      if(tracedBinSet.has(p.binId)){
        const key=`${Math.round(p.x/SX)},${Math.round(p.z/SZ)}`,index=columnCounts.get(key)||0;columnCounts.set(key,index+1);
        include(p.x,Math.max(p.y+data.binHeight/2+.25,top()+.4)+index*.38+.16,p.z,.25,.08,.25);
      }
    }
    for(const r of data.robots||[]){
      const detail=trackedRobotDetail(r);
      if(!detail||r.available===false||r.onGrid===false||!Number.isFinite(r.x)||!Number.isFinite(r.z))continue;
      const p=getRobotPose(r,top(),data.binHeight);
      include(p.x,top()+.36,p.z+p.bodySign*SZ/2,.39,.37,SZ+.05);
      include(p.bodyX,top()+1.08,p.bodyZ,.30,.08,.28);
      include(p.x,p.gripperY,p.z,.34,.04,.23);
    }
    opts.followRobotId=opts.followPortId=null;operatorView=false;zoom=1;panX=panZ=0;
    binCameraTarget={x:(x0+x1)/2,y:(y0+y1)/2,z:(z0+z1)/2,radius:4.6,boundsRadius:Math.hypot(x1-x0,y1-y0,z1-z0)*.54};
    yaw=getPortFacingYaw(data);pitch=.58;updateCamera();return true;
  }
  setData(data);resize();render();
  return {
    renderer:gl?'webgl':'software3d',
    getCameraState(){updateCamera();return {yaw,pitch,zoom,panX,panZ,target:binCameraTarget?{...binCameraTarget}:null,eye:[...eye],projection:[...vp]};},
    getViewMode(){return tracing()?'wireframe':'normal';},
    setData,
    setTool(value){if(value!==tool&&drag?.paint)cancelEditGesture();tool=value;lastHoverKey='';canvas.style.cursor=opts.editing&&['add','erase','port'].includes(tool)?'crosshair':'grab';},
    setEditOptions(value={}){
      const wasTop=editOptions.topView,previousSelected=editOptions.selectedPortId,previousMoving=editOptions.movingPortId,previousBrush=editOptions.brush;
      editOptions={...editOptions,...value,brush:value.brush?(value.brush==='rectangle'?'rectangle':'brush'):editOptions.brush};
      if(wasTop!==editOptions.topView){
        if(editOptions.topView){yaw=Math.PI/2;pitch=Math.PI/2-.012;operatorView=false;opts.followRobotId=opts.followPortId=null;}
        else{yaw=.86;pitch=.64;}
        signature='';setData(data);updateCamera();
      }else if(previousSelected!==editOptions.selectedPortId)rebuildEditPreview();
      if(previousSelected!==editOptions.selectedPortId||previousMoving!==editOptions.movingPortId||previousBrush!==editOptions.brush||wasTop!==editOptions.topView)lastHoverKey='';
    },
    setEditPreview(value){
      const next=value?JSON.stringify(value):'';if(next===editPreviewSignature)return;
      editPreviewSignature=next;editPreview=value;rebuildEditPreview();
    },
    cancelEditGesture,
    zoomToCells(){
      if(!opts.editing)return false;
      cancelEditGesture();if(!editOptions.topView)this.setEditOptions({topView:true});
      onEditViewChange('top');
      const bounds=worldBounds(),fit=editorTopFit(bounds,canvasWidth,canvasHeight);
      // A 44 CSS-pixel short side gives each cell a usable touch target.
      zoom=Math.min(1,fit.pixelsPerMeter*SZ/44);
      const focus=selected||{x:(data.width-1)/2,z:(data.depth-1)/2};
      panX=focus.x*SX-(bounds.x0+bounds.x1)/2;panZ=focus.z*SZ-(bounds.z0+bounds.z1)/2;
      cameraInputAt=performance.now();updateCamera();return true;
    },
    setView(value){
      operatorView=false;binCameraTarget=null;
      if(opts.editing){const next=value==='top';if(editOptions.topView!==next){editOptions.topView=next;signature='';setData(data);onEditViewChange(next?'top':'iso');}}
      if(value==='iso'){yaw=getPortFacingYaw(data);pitch=.64;}
      if(value==='top'){yaw=Math.PI/2;pitch=Math.PI/2-.012;}
      if(value==='front'){yaw=getPortFacingYaw(data,{oblique:false});pitch=.25;}
      if(value==='fit'){yaw=getPortFacingYaw(data);pitch=.64;zoom=1;panX=panZ=0;opts.followRobotId=null;opts.followPortId=null;}
      updateCamera();
    },
    setRenderSuspended(value){
      if(dead||renderSuspended===!!value)return;
      renderSuspended=!!value;
      if(renderSuspended){cancelAnimationFrame(raf);raf=null;}
      else{resize();lastRenderedSignature='';raf=requestAnimationFrame(render);}
    },
    setSelected(value){opts.selectedRobotId=null;selected=typeof value==='string'?{x:Number(value.split(',')[0]),z:Number(value.split(',')[1])}:value;setData(data);},
    setSelectedRobot(id){selected=null;opts.selectedRobotId=id||null;setData(data);},
    focusRobot(id){opts.followRobotId=id||null;opts.followPortId=null;operatorView=false;binCameraTarget=null;zoom=1;panX=panZ=0;setData(data);},
    focusPort(id,{operator=false}={}){opts.followPortId=id||null;opts.followRobotId=null;operatorView=operator;binCameraTarget=null;zoom=1;panX=panZ=0;const fp=followedPort();if(fp){yaw=Math.atan2(fp.layout.outZ,fp.layout.outX)+(operator?0:.30);pitch=operator?.24:.48;}setData(data);},
    focusBin(id){return focusBins([id]);},
    stopFollowing,
    focusBins,
    focusDigging,
    setOptions(value){
      const before=opts.showBins,cutaway=opts.cutaway,follow=opts.followRobotId,port=opts.followPortId,interior=opts.stationInterior,editing=opts.editing,highlightIds=opts.highlightBinIds.join(','),traceIds=tracedBinIds.join(','),blockerIds=opts.traceBlockerBinIds.join(',');opts={...opts,...value};
      if(editing&&!opts.editing){cancelEditGesture();editHandles.style.display='none';if(editOptions.topView){editOptions.topView=false;yaw=.86;pitch=.64;}}
      if('highlightBinIds'in value)opts.highlightBinIds=[...new Set(Array.isArray(value.highlightBinIds)?value.highlightBinIds:[])];
      if('traceBinId'in value)opts.traceBinId=typeof value.traceBinId==='string'&&value.traceBinId?value.traceBinId:null;
      if('traceBinIds'in value)opts.traceBinIds=normalizeBinIds(value.traceBinIds);
      if('traceBinId'in value||'traceBinIds'in value){tracedBinIds=normalizeBinIds([opts.traceBinId,...opts.traceBinIds]);tracedBinSet=new Set(tracedBinIds);}
      if('traceBlockerBinIds'in value){opts.traceBlockerBinIds=normalizeBinIds(value.traceBlockerBinIds);traceBlockerSet=new Set(opts.traceBlockerBinIds);}
      if('traceDiggingTargets'in value){
        opts.traceDiggingTargets=[...new Map((Array.isArray(value.traceDiggingTargets)?value.traceDiggingTargets:[]).filter(item=>typeof item?.binId==='string'&&item.binId&&Number.isFinite(item.remainingCount)).map(item=>[item.binId,{binId:item.binId,remainingCount:Math.max(0,Math.floor(item.remainingCount))}])).values()].sort((a,b)=>a.binId.localeCompare(b.binId));
        traceTargetCounts=new Map(opts.traceDiggingTargets.map(item=>[item.binId,item.remainingCount]));
      }
      if('traceDiggingRobots'in value){
        opts.traceDiggingRobots=[...new Map((Array.isArray(value.traceDiggingRobots)?value.traceDiggingRobots:[]).filter(item=>typeof item?.robotId==='string'&&item.robotId&&typeof item.targetBinId==='string').map(item=>[item.robotId,{
          robotId:item.robotId,role:item.role==='target'?'target':'blocker',taskKind:String(item.taskKind||(item.role==='target'?'deliver':'dig')),
          targetBinId:item.targetBinId,targetBinIds:normalizeBinIds([item.targetBinId,...(Array.isArray(item.targetBinIds)?item.targetBinIds:[])]),
          relatedBinId:item.relatedBinId||item.blockerBinId||item.targetBinId,blockerBinId:item.blockerBinId||null,requestId:item.requestId||null,
          phase:String(item.phase||''),phaseLabel:String(item.phaseLabel||''),number:String(item.number||'')
        }])).values()].sort((a,b)=>a.robotId.localeCompare(b.robotId));
        traceRobotDetails=new Map(opts.traceDiggingRobots.map(item=>[item.robotId,item]));
      }
      traceContextSignature=JSON.stringify([opts.traceBlockerBinIds,opts.traceDiggingTargets,opts.traceDiggingRobots]);
      if(opts.editing||value.followRobotId||value.followPortId)binCameraTarget=null;
      canvas.style.cursor=opts.editing&&['add','erase','port'].includes(tool)?'crosshair':'grab';
      if(value.followPortId)opts.followRobotId=null;else if(value.followRobotId)opts.followPortId=null;
      if(follow!==opts.followRobotId||port!==opts.followPortId){operatorView=false;zoom=1;panX=panZ=0;const fp=followedPort();if(fp){yaw=Math.atan2(fp.layout.outZ,fp.layout.outX)+.30;pitch=.48;}}
      if(before!==opts.showBins||cutaway!==opts.cutaway||follow!==opts.followRobotId||port!==opts.followPortId||interior!==opts.stationInterior||editing!==opts.editing||highlightIds!==opts.highlightBinIds.join(',')||traceIds!==tracedBinIds.join(',')||blockerIds!==opts.traceBlockerBinIds.join(',')){signature='';setData(data);}
    },
    resize,
    destroy(){softwareHoverPixels=softwareHoverDepth=null;dead=true;cancelAnimationFrame(raf);observer.disconnect();listeners.forEach(([t,f,o])=>canvas.removeEventListener(t,f,o));labels.remove();editHandles.remove();if(gl){for(const m of[coverMesh,hoverMesh,hoverLineMesh,staticMesh,lineMesh,dynamicMesh,overlayMesh,highlightMesh,highlightLineMesh,staticGhostMesh,dynamicGhostMesh,staticBinLineMesh,dynamicBinLineMesh,contextLineMesh,editFillMesh,editOutlineMesh,editLineMesh])if(m)gl.deleteBuffer(m.buffer);gl.deleteProgram(program);gl.deleteShader(vshader);gl.deleteShader(fshader);}}
  };
}
