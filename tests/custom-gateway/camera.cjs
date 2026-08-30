// Headless test of the viewer's camera logic: extracts the inline JS, stubs the
// DOM/WebGL, and asserts the orbit<->free handoff is continuous and that
// free-flight actually translates the eye.
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(
  path.join(__dirname, "../../scripts/viewer-template.html"), "utf8");
const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
if (!m) { console.error("no script block"); process.exit(1); }

let js = m[1]
  .replace('"__BLOCK_DATA__"', '"' + (function(){
    // A realistic 64-wide spread so span-scaled speeds are meaningful.
    const N = 64, b = Buffer.alloc(N * 4);
    for (let i = 0; i < N; i++) {
      b[i*4] = i; b[i*4+1] = i % 40; b[i*4+2] = (i * 3) % N; b[i*4+3] = 0;
    }
    return b.toString("base64");
  })() + '"')
  .replace("__PALETTE__", '[["stone",124,124,124,124,124,124]]')
  .replace("__META__", '{"wide":false,"typeCount":1,"prompt":"t","generated":"g","blockCount":100}');

// Stub just enough DOM/WebGL for the module to initialise.
const noopEl = () => ({
  textContent: "", innerHTML: "", className: "", style: {},
  addEventListener(){}, remove(){}, getAttribute(){ return "fwd"; },
  getBoundingClientRect(){ return {top:0,left:0,right:0,bottom:0,width:0,height:0}; },
  clientWidth: 1200, clientHeight: 800, width: 1200, height: 800,
  getContext(){ return glStub; },
  toDataURL(){ return "data:,"; },
});
const glStub = new Proxy({}, {
  get(_, k){
    if (k === "getShaderParameter" || k === "getProgramParameter") return () => true;
    if (k === "getAttribLocation") return () => 0;
    if (k === "getUniformLocation") return () => ({});
    if (k === "getError") return () => 0;
    if (k === "getParameter") return () => 0;
    if (typeof k === "string" && /^[A-Z_0-9]+$/.test(k)) return 1;
    return () => {};
  },
});
global.document = {
  getElementById: noopEl,
  querySelectorAll: () => [],
  createElement: noopEl,
  body: { appendChild(){} },
};
global.window = { addEventListener(){}, devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800 };
global.atob = (b) => Buffer.from(b, "base64").toString("binary");
global.requestAnimationFrame = () => 0;
global.setTimeout = (f) => 0;

// Expose internals for assertions.
js += `
;globalThis.__T = {
  get mode(){ return camMode; }, setMode, camera, fit, panBy, moveFree,
  get eye(){ return eye; }, set eye(v){ eye = v; },
  get tgt(){ return tgt; }, get dist(){ return dist; },
  get keys(){ return keys; }, set keys(v){ keys = v; },
  get rotX(){ return rotX; }, get rotY(){ return rotY; },
  DX: DX, DY: DY, DZ: DZ,
  orbitTarget,
  get cenW(){ return cenW; },
  get cenY(){ return cenY; },
};`;

try { new Function(js)(); } catch (e) {
  console.error("init failed:", e.message);
  console.error(e.stack.split("\n").slice(0,5).join("\n"));
  process.exit(1);
}

const T = globalThis.__T;
let fail = 0;
const near = (a, b, tol, label) => {
  const ok = Math.abs(a - b) <= tol;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (${a.toFixed(3)} vs ${b.toFixed(3)})`);
  if (!ok) fail++;
};
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fail++;
};
const dist3 = (a, b) => Math.sqrt(
  Math.pow(a[0]-b[0],2) + Math.pow(a[1]-b[1],2) + Math.pow(a[2]-b[2],2));

console.log("=== bootstrap: no var-hoisting clobber ===\n");
// Regression: init() used to run before the camera `var` initialisers, so
// fit()'s values were silently overwritten (bit us twice: dist, then tgt).
// After bootstrap every camera field must already be live -- WITHOUT calling
// fit() again first.
ok(Array.isArray(T.tgt), "tgt initialised by bootstrap");
ok(T.tgt && T.tgt.some(function(v){ return v !== 0; }),
   `tgt is not [0,0,0] (got [${T.tgt}])`);
ok(typeof T.dist === "number" && T.dist > 0, `dist initialised (${T.dist})`);
ok(Array.isArray(T.eye) && T.eye.some(function(v){ return v !== 0; }),
   "eye initialised by bootstrap");

console.log("\n=== orbit target tracks visible geometry ===\n");
// The bounding-box centre sits in mid-air for bottom-heavy builds. The target
// must instead follow the visible-surface centroid on Y.
const boxCentreY = T.DY / 2;
const target = T.orbitTarget();
ok(target[1] < boxCentreY,
   `target Y (${target[1].toFixed(1)}) below box centre (${boxCentreY.toFixed(1)})`);
ok(target[1] >= T.DY * 0.06 && target[1] <= T.DY * 0.62,
   `target Y within clamp bounds (${target[1].toFixed(1)})`);
// X/Z should stay near the middle so the build remains framed.
near(target[0], T.DX / 2, T.DX * 0.2, "target X near centre");
near(target[2], T.DZ / 2, T.DZ * 0.2, "target Z near centre");
ok(T.cenW > 0, `surface centroid accumulated (${T.cenW} faces)`);

console.log("\n=== camera mode handoff ===\n");
T.fit();
ok(T.mode === "orbit", "starts in orbit mode");

const beforeEye = T.camera().eye.slice();
const beforeFwd = T.camera().fwd.slice();

T.setMode("free");
ok(T.mode === "free", "switches to free");
const afterEye = T.camera().eye.slice();
const afterFwd = T.camera().fwd.slice();
near(dist3(beforeEye, afterEye), 0, 0.02, "eye position preserved orbit->free");
near(dist3(beforeFwd, afterFwd), 0, 0.02, "view direction preserved orbit->free");

// Fly forward and confirm the eye actually translates toward the model.
const flyStart = T.camera().eye.slice();
T.keys = { fwd: true };
for (let i = 0; i < 10; i++) T.moveFree(0.016);
const flyEnd = T.camera().eye.slice();
ok(dist3(flyStart, flyEnd) > 1, `free flight moves the eye (${dist3(flyStart, flyEnd).toFixed(2)} units)`);
const centre = [T.DX/2, T.DY/2, T.DZ/2];
ok(dist3(flyEnd, centre) < dist3(flyStart, centre), "forward flight approaches the model");

// Vertical movement is independent of look direction.
T.keys = { up: true };
const upStart = T.camera().eye[1];
for (let i = 0; i < 10; i++) T.moveFree(0.016);
ok(T.camera().eye[1] > upStart, "ascend raises the eye");
T.keys = {};

// Switching back should not teleport the view.
const preBack = T.camera().eye.slice();
T.setMode("orbit");
ok(T.mode === "orbit", "switches back to orbit");
near(dist3(preBack, T.camera().eye), 0, 0.6, "eye roughly preserved free->orbit");

console.log("\n=== orbit target is pannable (not welded to centre) ===\n");
T.fit();
const t0 = T.tgt.slice();
T.panBy(120, 60);
const t1 = T.tgt.slice();
ok(dist3(t0, t1) > 0.5, `pan moves the orbit target (${dist3(t0,t1).toFixed(2)} units)`);

// Panning must not change the eye->target distance (pure translation).
const dBefore = T.dist;
T.panBy(-40, 25);
near(T.dist, dBefore, 1e-6, "pan keeps orbit distance unchanged");

console.log("\n=== free mode pan moves the camera itself ===\n");
T.setMode("free");
const e0 = T.camera().eye.slice();
T.panBy(100, 0);
ok(dist3(e0, T.camera().eye) > 0.5, "pan translates eye in free mode");

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
