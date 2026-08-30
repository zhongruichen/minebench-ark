// Prints ASCII cross-sections. No projection math, so it cannot lie the way
// the isometric rasteriser can.
const fs = require("node:fs");
const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const bl = b.blocks;

let mnx=1e9,mny=1e9,mnz=1e9,mxx=-1e9,mxy=-1e9,mxz=-1e9;
for (const p of bl){
  if(p.x<mnx)mnx=p.x; if(p.y<mny)mny=p.y; if(p.z<mnz)mnz=p.z;
  if(p.x>mxx)mxx=p.x; if(p.y>mxy)mxy=p.y; if(p.z>mxz)mxz=p.z;
}

const at = new Map();
for (const p of bl) at.set(`${p.x},${p.y},${p.z}`, p.type);

const CH = {
  stone:"#", cobblestone:"%", stone_bricks:"H", gray_wool:"=",
  dirt:".", grass_block:'"', sand:":",
  oak_log:"|", oak_planks:"P", brown_wool:"b", oak_leaves:"*",
  white_wool:"W", black_wool:"K", glass:"o", glowstone:"@",
  water:"~", gold_block:"G", red_wool:"r", yellow_wool:"y",
};
const ch = (t) => CH[t] ?? "?";

// Horizontal slices at interesting heights
const ys = (process.argv[3] || "2,6,10,13,16,20").split(",").map(Number);
for (const y of ys){
  let n=0;
  const rows=[];
  for (let z=mnz; z<=mxz; z++){
    let line="";
    for (let x=mnx; x<=mxx; x++){
      const t=at.get(`${x},${y},${z}`);
      line += t ? (n++, ch(t)) : " ";
    }
    rows.push(line);
  }
  // trim fully blank rows for compactness
  while(rows.length && !rows[0].trim()) rows.shift();
  while(rows.length && !rows[rows.length-1].trim()) rows.pop();
  console.log(`\n===== y=${y}  (${n} blocks) =====`);
  console.log(rows.join("\n"));
}

// Vertical slice through the middle to reveal walls/roof
const zMid = Math.round((mnz+mxz)/2);
console.log(`\n\n===== vertical slice z=${zMid} (x horizontal, y up) =====`);
const vrows=[];
for (let y=mxy; y>=mny; y--){
  let line="";
  for (let x=mnx; x<=mxx; x++){
    const t=at.get(`${x},${y},${zMid}`);
    line += t ? ch(t) : " ";
  }
  vrows.push(String(y).padStart(2)+" "+line);
}
console.log(vrows.filter(r=>r.slice(3).trim()).join("\n"));
