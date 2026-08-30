// Trivially-correct structural analysis: no projection math, just counting.
const fs = require("node:fs");
const b = JSON.parse(fs.readFileSync(process.argv[2] || ".probe-out/integration-build.json", "utf8"));
const bl = b.blocks;
console.log(`blocks: ${bl.length}`);
console.log(`boxes: ${(b.boxes || []).length}  lines: ${(b.lines || []).length}`);

const solid = new Set(bl.map((x) => `${x.x},${x.y},${x.z}`));

// Column occupancy (top-down footprint density)
const col = new Map();
for (const x of bl) {
  const k = `${x.x},${x.z}`;
  col.set(k, (col.get(k) || 0) + 1);
}
console.log(`occupied (x,z) columns: ${col.size} / 4096`);

// Per-layer counts, to see if it's a coherent vertical structure
const layer = new Array(64).fill(0);
for (const x of bl) layer[x.y]++;
console.log("\nlayer counts y=0..63:");
for (let y = 0; y < 64; y += 4) {
  const row = layer.slice(y, y + 4).map((n) => String(n).padStart(6)).join("");
  console.log(`  y${String(y).padStart(2)}:${row}`);
}

// 6-neighbour connectivity: fraction of blocks touching another block.
let touching = 0;
for (const x of bl) {
  if (
    solid.has(`${x.x + 1},${x.y},${x.z}`) || solid.has(`${x.x - 1},${x.y},${x.z}`) ||
    solid.has(`${x.x},${x.y + 1},${x.z}`) || solid.has(`${x.x},${x.y - 1},${x.z}`) ||
    solid.has(`${x.x},${x.y},${x.z + 1}`) || solid.has(`${x.x},${x.y},${x.z - 1}`)
  ) touching++;
}
console.log(`\nblocks with >=1 neighbour: ${touching} (${((touching / bl.length) * 100).toFixed(1)}%)`);

// Largest connected component via BFS (flood fill over 6-neighbourhood).
const seen = new Set();
let best = 0, comps = 0;
for (const start of solid) {
  if (seen.has(start)) continue;
  comps++;
  let size = 0;
  const stack = [start];
  seen.add(start);
  while (stack.length) {
    const cur = stack.pop();
    size++;
    const [cx, cy, cz] = cur.split(",").map(Number);
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const k = `${cx+dx},${cy+dy},${cz+dz}`;
      if (solid.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
    }
  }
  if (size > best) best = size;
}
console.log(`connected components: ${comps}`);
console.log(`largest component: ${best} (${((best / bl.length) * 100).toFixed(1)}% of build)`);

// Type histogram
const hist = new Map();
for (const x of bl) hist.set(x.type, (hist.get(x.type) || 0) + 1);
console.log(`\ntop types:`);
for (const [t, n] of [...hist.entries()].sort((a, c) => c[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(n).padStart(6)}  ${t}`);
}
