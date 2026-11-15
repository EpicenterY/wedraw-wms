// Metres are canonical. Unit changes never round or resize a saved floor.
export const CELL_WIDTH_M=.705,CELL_DEPTH_M=.480,SQUARE_METRES_PER_PYEONG=400/121;
export const areaInUnit=(squareMetres,unit)=>unit==='pyeong'?squareMetres/SQUARE_METRES_PER_PYEONG:squareMetres;
export const areaInMetres=(value,unit)=>unit==='pyeong'?value*SQUARE_METRES_PER_PYEONG:value;
export function positiveDimension(value,fallback){const n=Math.floor(Number(value));return Number.isSafeInteger(n)&&n>0?n:fallback;}
export function floorDimensions(config){return {widthM:config.floorWidthM??config.width*CELL_WIDTH_M,depthM:config.floorDepthM??config.depth*CELL_DEPTH_M};}
export function floorFromArea(area,unit,widthM,depthM){
  const sqm=areaInMetres(Number(area),unit),ratio=widthM/depthM;
  if(!Number.isFinite(sqm)||sqm<=0||!Number.isFinite(ratio)||ratio<=0)throw new Error('바닥 면적을 양수로 입력해 주세요.');
  return {widthM:Math.sqrt(sqm*ratio),depthM:Math.sqrt(sqm/ratio)};
}
export function configureFloor(config,widthM,depthM){
  widthM=Number(widthM);depthM=Number(depthM);
  if(!Number.isFinite(widthM)||!Number.isFinite(depthM)||widthM<CELL_WIDTH_M||depthM<CELL_DEPTH_M)throw new Error('바닥은 최소 한 셀(0.705 × 0.480m)을 포함해야 합니다.');
  const width=Math.floor((widthM+1e-9)/CELL_WIDTH_M),depth=Math.floor((depthM+1e-9)/CELL_DEPTH_M);
  if(!Number.isSafeInteger(width*depth))throw new Error('이 기기에서 정확하게 표현할 수 있는 바닥 크기를 초과했습니다.');
  return {...config,width,depth,floorWidthM:widthM,floorDepthM:depthM,
    activeCells:config.activeCells.filter(k=>{const [x,z]=k.split(',').map(Number);return x<width&&z<depth;}),
    ports:config.ports.filter(p=>p.x<width&&p.z<depth)};
}
