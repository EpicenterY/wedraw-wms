import test from 'node:test';
import assert from 'node:assert/strict';
import {lensMap} from '../dist/liquid-glass.js';
test('lens refracts opposite edges symmetrically and leaves central content undistorted after resize',()=>{
  for(const [w,h,r]of [[260,58,18],[360,740,26],[936,612,28]]){
    const map=lensMap(w,h,r),at=(x,y,k)=>map.pixels[(y*w+x)*4+k];
    assert.equal(map.pixels.length,w*h*4);assert.ok(map.pixels.every(Number.isFinite));
    assert.ok(Math.abs(at(w>>1,h>>1,0)-128)<=1&&Math.abs(at(w>>1,h>>1,1)-128)<=1);
    assert.ok(at(7,h>>1,0)>150&&at(w-8,h>>1,0)<105,'a clear background bend, not a uniform blur');
    assert.ok(Math.abs(at(7,h>>1,0)+at(w-8,h>>1,0)-255)<=1);
    assert.equal(at(w>>1,h>>1,3),255);
  }
});
