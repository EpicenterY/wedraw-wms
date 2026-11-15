// Small, explicit ABI for the Rust calculation core. No JS calculation fallback.
let core=null,initializing=null;
const counters={path:0,reachable:0};
const finalizers=typeof FinalizationRegistry==='function'?new FinalizationRegistry(id=>core.grid_destroy(id)):null;

export async function initializeRustCore(bytes){
  if(core)return;
  if(initializing)return initializing;
  initializing=(async()=>{
    let source=bytes;
    if(!source){
      const response=await fetch(new URL('./wasm/warehouse_core.wasm',import.meta.url));
      if(!response.ok)throw new Error(`Calculation core HTTP ${response.status}`);
      source=await response.arrayBuffer();
    }
    // arrayBuffer also works on static hosts without application/wasm MIME.
    const {instance}=await WebAssembly.instantiate(source,{});
    if(instance.exports.core_abi_version()!==1)throw new Error('Unsupported calculation core ABI');
    core=instance.exports;
  })();
  try{await initializing;}finally{initializing=null;}
}
function ready(){if(!core)throw new Error('Initialize the Rust core before creating a simulation');return core;}
export const coreDiagnostics=()=>({backend:core?'rust-wasm':'uninitialized',abi:core?.core_abi_version()??null,liveGrids:core?.grid_count()??0,...counters});
export const smoothMotion=t=>ready().smooth_motion(t);
export const smoothVelocity=t=>ready().smooth_velocity(t);
export const motionDuration=(distance,speed=1.15,acceleration=2)=>ready().motion_duration(distance,speed,acceleration);
export const storageCapacity=(cells,levels,reserve)=>ready().storage_capacity(cells,levels,reserve);

const warehouseFinalizers=typeof FinalizationRegistry==='function'?new FinalizationRegistry(id=>core.warehouse_destroy(id)):null;
const encoder=new TextEncoder(),decoder=new TextDecoder();
export class RustWarehouse {
  constructor(){this.handle=ready().warehouse_create();if(!this.handle)throw new Error('Unable to allocate Rust warehouse');warehouseFinalizers?.register(this,this.handle,this);}
  call(op,args={},time=0,context){
    if(!this.handle)throw new Error('Rust warehouse has been disposed');
    const bytes=encoder.encode(JSON.stringify({op,args,time,context}));
    const ptr=core.warehouse_input(this.handle,bytes.length);if(!ptr)throw new Error('Warehouse command is too large');
    new Uint8Array(core.memory.buffer,ptr,bytes.length).set(bytes);
    const length=core.warehouse_execute(this.handle),out=core.warehouse_output(this.handle);
    const response=JSON.parse(decoder.decode(new Uint8Array(core.memory.buffer,out,length)));
    if(!response.ok)throw new Error(response.error);return response;
  }
  dispose(){if(this.handle){warehouseFinalizers?.unregister(this);core.warehouse_destroy(this.handle);this.handle=0;}}
}

export class RustNavigator {
  constructor(width,depth,activeCells){
    ready();
    if(!Number.isSafeInteger(width)||!Number.isSafeInteger(depth)||width<1||depth<1||width*depth>=0x7fffffff)throw new RangeError('Invalid grid dimensions');
    this.width=width;this.size=width*depth;
    this.keys=Array.from({length:this.size},(_,id)=>`${id%width},${Math.floor(id/width)}`);
    this.ids=new Map(this.keys.map((key,id)=>[key,id]));
    this.handle=core.grid_create(width,depth);
    if(!this.handle)throw new Error('Unable to allocate Rust grid');
    this.activePtr=core.grid_active_ptr(this.handle);this.blockedPtr=core.grid_blocked_ptr(this.handle);this.resultPtr=core.grid_result_ptr(this.handle);
    this._views();
    for(const key of activeCells){const id=this.ids.get(key);if(id!==undefined)this.active[id]=1;}
    finalizers?.register(this,this.handle,this);
  }
  _views(){
    if(!this.handle)throw new Error('Rust grid has been disposed');
    if(this.buffer!==core.memory.buffer){
      this.buffer=core.memory.buffer;
      this.active=new Uint8Array(this.buffer,this.activePtr,this.size);
      this.blocked=new Uint8Array(this.buffer,this.blockedPtr,this.size);
      this.result=new Uint32Array(this.buffer,this.resultPtr,this.size);
    }
  }
  _block(blocked){
    this._views();this.blocked.fill(0);
    // Map values are lock owners: membership, including falsy values, is what matters.
    for(const key of blocked.keys()){const id=this.ids.get(key);if(id!==undefined)this.blocked[id]=1;}
  }
  path(from,to,blocked,sign){
    this._block(blocked);counters.path++;
    const count=core.grid_path(this.handle,this.ids.get(from)??0xffffffff,this.ids.get(to)??0xffffffff,sign);
    return count<0?null:Array.from(this.result.subarray(0,count),id=>this.keys[id]);
  }
  reachable(from,sign,blocked){
    this._block(blocked);counters.reachable++;
    const count=core.grid_reachable(this.handle,this.ids.get(from)??0xffffffff,sign);
    return new Set(Array.from(this.result.subarray(0,count),id=>this.keys[id]));
  }
  dispose(){
    if(!this.handle)return;
    finalizers?.unregister(this);core.grid_destroy(this.handle);this.handle=0;
    this.buffer=this.active=this.blocked=this.result=null;
  }
}
