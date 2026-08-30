// Compares candidate orbit targets for a build. The viewer currently uses the
// bounding-box centre, which sits in mid-air for bottom-heavy builds (wide
// terrain + tall thin spire).
const fs = require("node:fs");
const b = JSON.parse(fs.readFileSync(process.argv[2] || ".probe-out/integration-build.json", "utf8"));
const bl = b.blocks;

let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9;
for (const p of bl){
  if(p.x<mnx)mnx=p.x; if(p.y<mny)mny=p.y; if(p.z<mnz)mnz=p.z;
  if(p.x>mxx)mxx=p.x; if(p.y>mxy)mxy=p.y; if(p.z>mxz)mxz=p.z;
}
const DX=mxx-mnx+1, DY=mny!==undefined?mxy-mny+1:0, DZ=mxz-mnz+1;
console.log(`bbox local dims: ${DX} x ${DY} x ${DZ}`);
console.log(`bbox centre    : [${(DX/2).toFixed(1)}, ${(DY/2).toFixed(1)}, ${(DZ/2).toFixed(1)}]  <-- current target`);

// centroid of ALL blocks
let sx=0,sy=0,sz=0;
for (const p of bl){ sx+=p.x-mnx; sy+=p.y-mny; sz+=p.z-mnz; }
const n=bl.length;
console.log(`centroid (all) : [${(sx/n).toFixed(1)}, ${(sy/n).toFixed(1)}, ${(sz/n).toFixed(1)}]`);

// centroid of SURFACE blocks (what is actually drawn)
const solid=new Set(bl.map(p=>`${p.x},${p.y},${p.z}`));
const surf=bl.filter(p=>
  !solid.has(`${p.x+1},${p.y},${p.z}`)||!solid.has(`${p.x-1},${p.y},${p.z}`)||
  !solid.has(`${p.x},${p.y+1},${p.z}`)||!solid.has(`${p.x},${p.y-1},${p.z}`)||
  !solid.has(`${p.x},${p.y},${p.z+1}`)||!solid.has(`${p.x},${p.y},${p.z-1}`));
let tx=0,ty=0,tz=0;
for (const p of surf){ tx+=p.x-mnx; ty+=p.y-mny; tz+=p.z-mnz; }
console.log(`centroid (surf): [${(tx/surf.length).toFixed(1)}, ${(ty/surf.length).toFixed(1)}, ${(tz/surf.length).toFixed(1)}]  (${surf.length} blocks)`);

// median per axis (robust to the spire)
const med=(arr)=>{const a=[...arr].sort((p,q)=>p-q);return a[Math.floor(a.length/2)];};
console.log(`median         : [${med(bl.map(p=>p.x-mnx))}, ${med(bl.map(p=>p.y-mny))}, ${med(bl.map(p=>p.z-mnz))}]`);

// y distribution to show how bottom-heavy it is
const layer=new Array(DY).fill(0);
for (const p of bl) layer[p.y-mny]++;
let cum=0; const q={};
for (let y=0;y<DY;y++){ cum+=layer[y];
  for (const t of [0.25,0.5,0.75,0.9]) if(q[t]===undefined && cum>=n*t) q[t]=y; }
console.log(`\ny quantiles: 25%=${q[0.25]}  50%=${q[0.5]}  75%=${q[0.75]}  90%=${q[0.9]}  max=${DY-1}`);
console.log(`=> ${((layer.slice(0,12).reduce((a,c)=>a+c,0)/n)*100).toFixed(1)}% of blocks are below y=12`);
