/* ------- EditMode defaults (persisted) ------- */
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "focusMin": 25,
  "shortMin": 5,
  "longMin": 20,
  "sandCoverage": 10,
  "grainSize": 2,
  "brushRadius": 28
}/*EDITMODE-END*/;

/* ====================================================================
   HOURS — a pomodoro where you draw the dune, then walk it.
   ==================================================================== */

const state = {
  focusMin:  TWEAK_DEFAULTS.focusMin,
  shortMin:  TWEAK_DEFAULTS.shortMin,
  longMin:   TWEAK_DEFAULTS.longMin,
  // sandCoverage is a % of viewport cells (slider 5..40); sandQuota is the
  // derived grain count, recomputed on every resize so big screens demand
  // proportionally more sand.
  sandCoverage: TWEAK_DEFAULTS.sandCoverage,
  sandQuota: 0,
  grainSize: TWEAK_DEFAULTS.grainSize,
  brushRadius: TWEAK_DEFAULTS.brushRadius != null ? TWEAK_DEFAULTS.brushRadius : 16,

  sandUsed: 0,
  session: 1,              // 1..4 within current long-cycle
  completedFocus: 0,       // total completed focus sessions
  totalFocusMin: 0,        // cumulative focus minutes — 1 min = 1 mile traveled
  focusBaseTotalMin: 0,    // snapshot of totalFocusMin when current focus started
  bgmVolume: 25,           // 0..100, 0 = paused/muted; 25 = lightly audible ambient

  phase: "idle",           // idle | focus | short | long
  phaseStart: 0,
  phaseDuration: 0,        // ms
  paused: true,
  pausedElapsed: 0,        // elapsed time at moment of pause (ms)

  // sand grid
  cols: 0, rows: 0,
  grid: null,              // Uint8Array, 0 = empty, 1..N = sand shades

  // Bottom-left-anchored buffer that spans the union of every viewport the
  // window has ever been at. The visible grid is a window into the bottom-left
  // corner of this buffer. Lets us shrink the window, then grow it again, and
  // still get back sand that was off-screen in between.
  persistentGrid: null,
  persistentCols: 0,
  persistentRows: 0,

  // terrain cached profile (top surface row per column)
  terrain: null,           // Float32Array length cols; settled = top row of sand (lower = higher dune)

  // input
  dragging: false,
  lastX: -1, lastY: -1,

  // traveler progress (for pausing)
  travelerPausedX: null,
};

/* ------- canvas ------- */
const canvas = document.getElementById("sand");
const ctx = canvas.getContext("2d", { willReadFrequently: false });

let imageData = null;
let buf32 = null;

function computeSandQuota() {
  // Scale the drawable sand budget to the viewport so the dune looks the
  // same fraction of the screen on a MacBook as on a 5K iMac. Without this
  // the fixed grain count felt generous on a small display and too sparse
  // on a big one.
  return Math.max(1, Math.round(state.cols * state.rows * state.sandCoverage / 100));
}

// preserveGrid=true syncs sand through a persistent canonical buffer so the
// dunes stay locked to the floor across window resize / fullscreen toggles
// AND survive a shrink-then-grow cycle (off-screen sand is preserved rather
// than cropped away). preserveGrid=false is used when grain size changes —
// the old cell pitch no longer matches the new one, so we wipe everything.
function resize(preserveGrid = true) {
  const w = Math.floor(window.innerWidth);
  const h = Math.floor(window.innerHeight);
  const g = state.grainSize;
  const newCols = Math.floor(w / g);
  const newRows = Math.floor(h / g);

  if (!preserveGrid) {
    state.persistentGrid = null;
    state.persistentCols = 0;
    state.persistentRows = 0;
    state.sandUsed = 0;
  }

  // 1) Flush the live viewport grid back into persistent (bottom-left anchor).
  //    Persistent's bottom row == viewport's bottom row.
  if (state.grid && state.persistentGrid && state.cols && state.rows) {
    const pCols = state.persistentCols;
    const dRow = state.persistentRows - state.rows;
    for (let y = 0; y < state.rows; y++) {
      const srcOff = y * state.cols;
      const dstOff = (y + dRow) * pCols;
      for (let x = 0; x < state.cols; x++) {
        state.persistentGrid[dstOff + x] = state.grid[srcOff + x];
      }
    }
  }

  // 2) Grow (or create) persistent so it covers the new viewport. Persistent
  //    only ever grows — sand that went off-screen when the window shrank is
  //    still there when the user expands again.
  const needCols = Math.max(newCols, state.persistentCols);
  const needRows = Math.max(newRows, state.persistentRows);
  if (!state.persistentGrid) {
    state.persistentGrid = new Uint8Array(needCols * needRows);
    state.persistentCols = needCols;
    state.persistentRows = needRows;
  } else if (needCols > state.persistentCols || needRows > state.persistentRows) {
    const grown = new Uint8Array(needCols * needRows);
    const oldCols = state.persistentCols;
    const dRow = needRows - state.persistentRows;   // bottom-anchor growth
    for (let y = 0; y < state.persistentRows; y++) {
      const srcOff = y * oldCols;
      const dstOff = (y + dRow) * needCols;
      for (let x = 0; x < oldCols; x++) {
        grown[dstOff + x] = state.persistentGrid[srcOff + x];
      }
    }
    state.persistentGrid = grown;
    state.persistentCols = needCols;
    state.persistentRows = needRows;
  }

  // 3) Build the new viewport grid by reading persistent's bottom-left window.
  const newGrid = new Uint8Array(newCols * newRows);
  {
    const pCols = state.persistentCols;
    const dRow = state.persistentRows - newRows;
    for (let y = 0; y < newRows; y++) {
      const srcOff = (y + dRow) * pCols;
      const dstOff = y * newCols;
      for (let x = 0; x < newCols; x++) {
        newGrid[dstOff + x] = state.persistentGrid[srcOff + x];
      }
    }
  }

  state.cols = newCols;
  state.rows = newRows;
  state.grid = newGrid;
  state.sandQuota = computeSandQuota();
  canvas.width = newCols;
  canvas.height = newRows;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  state.terrain = new Float32Array(newCols).fill(newRows);
  imageData = ctx.createImageData(newCols, newRows);
  buf32 = new Uint32Array(imageData.data.buffer);

  // Keep the traveler SVG coordinate space matched to the viewport, otherwise
  // the figure drifts off or gets cropped when the window changes size.
  const travelerLayerEl = document.getElementById("travelerLayer");
  if (travelerLayerEl) {
    travelerLayerEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
    travelerLayerEl.setAttribute("width", w);
    travelerLayerEl.setAttribute("height", h);
  }

  updateGauge();
}
window.addEventListener("resize", () => resize(true));

/* ------- sand palette (warm) ------- */
// shade index 1..7
// Uint32 ImageData is little-endian: 0xAABBGGRR
// Source warm sand palette (RGB): A5C8DD → 38526A  ← NO, warm palette:
// DDC8A5, CFB48E, BEA079, B0936B, 9C7F58, 826748, 6A5238
const SAND_COLORS = [
  0, // 0 empty
  0xFFA5C8DD, // DDC8A5 — lightest warm
  0xFF8EB4CF, // CFB48E
  0xFF79A0BE, // BEA079
  0xFF6B93B0, // B0936B
  0xFF587F9C, // 9C7F58
  0xFF486782, // 826748
  0xFF38526A, // 6A5238
];
// pick a shade with slight variation
function pickShade() {
  // bias toward middle
  const r = Math.random();
  if (r < 0.15) return 1;
  if (r < 0.40) return 2;
  if (r < 0.65) return 3;
  if (r < 0.85) return 4;
  if (r < 0.95) return 5;
  return 6;
}

/* ------- sand drop (input) ------- */
// Drops a thin stream of individual grains at (x,y). Rather than filling
// every cell in a disk (which looks like a slab), we scatter a small number
// of sparse grains within a soft circle — they then tumble down through the
// cellular automaton as separate particles, like paint.toys/sand.
function dropAt(x, y, radiusPx) {
  const g = state.grainSize;
  const rPx = radiusPx != null ? radiusPx : state.brushRadius;
  // Keep scatter close to the brush handle so the stream stays thin
  // and ribbon-like — a narrow, silky pour rather than a wide spray.
  const scatterRPx = rPx * 1.2;
  const rCells = Math.max(1.5, scatterRPx / g);
  const cx = x / g;
  const cy = y / g;
  // Lots of grains per event so the pour feels fast and continuous,
  // but the narrow scatter keeps density believable per frame.
  const grainsPerEvent = Math.max(14, Math.round(rCells * 7));
  let dropped = 0;
  for (let n = 0; n < grainsPerEvent; n++) {
    if (state.sandUsed >= state.sandQuota) break;
    const a = Math.random() * Math.PI * 2;
    // uniform disk distribution (no inward bias) so the scatter looks
    // even across the whole brush area instead of pooling at center
    const r = Math.sqrt(Math.random()) * rCells;
    const xx = Math.round(cx + Math.cos(a) * r);
    // spawn slightly above cursor so grains are in-flight when they appear
    const yy = Math.round(cy + Math.sin(a) * r) - 1;
    if (xx < 1 || xx >= state.cols - 1 || yy < 0 || yy >= state.rows) continue;
    const i = yy * state.cols + xx;
    if (state.grid[i] === 0) {
      state.grid[i] = pickShade();
      state.sandUsed++;
      dropped++;
    }
  }
  if (dropped > 0) {
    checkReady();
    updateGauge();
  }
}

/* ------- falling sand step ------- */
function stepSand() {
  const cols = state.cols, rows = state.rows;
  const g = state.grid;
  // bottom-up scan; alternate L/R bias per row
  for (let y = rows - 2; y >= 0; y--) {
    const bias = (y & 1) ? 1 : -1;
    for (let x0 = 0; x0 < cols; x0++) {
      // to reduce directional bias, use alternating scan direction
      const x = (y & 1) ? (cols - 1 - x0) : x0;
      const i = y * cols + x;
      const v = g[i];
      if (v === 0) continue;
      const below = i + cols;
      if (g[below] === 0) {
        g[below] = v; g[i] = 0;
        continue;
      }
      // diagonal
      const canL = x > 0 && g[below - 1] === 0;
      const canR = x < cols - 1 && g[below + 1] === 0;
      if (canL && canR) {
        if (bias < 0) { g[below - 1] = v; g[i] = 0; }
        else { g[below + 1] = v; g[i] = 0; }
      } else if (canL) {
        g[below - 1] = v; g[i] = 0;
      } else if (canR) {
        g[below + 1] = v; g[i] = 0;
      }
    }
  }
}

/* ------- render ------- */
function render() {
  const cols = state.cols, rows = state.rows;
  const g = state.grid;
  const buf = buf32;
  // clear to transparent
  buf.fill(0x00000000);
  const tt = state.terrain;
  for (let x = 0; x < cols; x++) tt[x] = rows; // reset; will set to first non-empty row found

  for (let y = 0; y < rows; y++) {
    const rowOff = y * cols;
    for (let x = 0; x < cols; x++) {
      const v = g[rowOff + x];
      if (v !== 0) {
        buf[rowOff + x] = SAND_COLORS[v];
        if (tt[x] === rows) tt[x] = y; // first (topmost) hit
      }
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/* ------- terrain smoothing (for traveler path) ------- */
function smoothedTerrain() {
  const t = state.terrain;
  const cols = state.cols;
  const out = new Float32Array(cols);
  const W = 6; // window half-width
  for (let x = 0; x < cols; x++) {
    let sum = 0, cnt = 0;
    for (let k = -W; k <= W; k++) {
      const xi = Math.min(cols - 1, Math.max(0, x + k));
      sum += t[xi]; cnt++;
    }
    out[x] = sum / cnt;
  }
  return out;
}

/* ------- traveler ------- */
const travelerLayer = document.getElementById("travelerLayer");
let travelerEl = null;
let emberEl = null;

function ensureTraveler() {
  if (travelerEl) return;
  // Layer dimensions are kept in sync by resize() — no one-shot setup here.

  // Journey-inspired cloaked wanderer: tall, narrow silhouette, small
  // rounded hood, cloak that tapers toward the feet, a long scarf that
  // trails behind and ripples in the wind. Origin (0,0) is at the feet,
  // so positioning puts bottom-center on the dune surface.
  const ns = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(ns, "g");
  g.setAttribute("id", "traveler");

  // The whole figure lives inside a local frame where y grows downward
  // and the feet sit on y=0. Height ~62px on screen (tall + slender).
  // We animate: body bob, cloak sway, scarf path.
  g.innerHTML = `
    <g id="traveler-body">
      <path id="traveler-scarf-tail" fill="#8A3A1E" opacity="0.65" />
      <path id="traveler-scarf"      fill="#B04A25" opacity="0.95" />
      <path id="traveler-leg-back"  fill="#2A1408" opacity="0.85"/>
      <path id="traveler-leg-front" fill="#1A0C06" />
      <path id="traveler-cloak" fill="#3A1B0D" />
      <path id="traveler-hem"   fill="#E8A96B" opacity="0.75" fill-rule="evenodd"/>
      <path id="traveler-head"  fill="#2A1408" />
    </g>
  `;
  travelerLayer.appendChild(g);
  travelerEl = g;

  // Fox is a separate top-level group — NOT inside the traveler — so it
  // doesn't inherit the traveler's rotation (which otherwise made the fox
  // tilt off the terrain on slopes, causing clipping and floating).
  const foxG = document.createElementNS(ns, "g");
  foxG.setAttribute("id", "fox");
  foxG.innerHTML = `
    <path id="fox-tail" fill="#D26A2A" />
    <path id="fox-tail-tip" fill="#FFF5E0" />
    <path id="fox-body" fill="#E07A35" />
    <path id="fox-belly" fill="#F1A15A" opacity="0.65" />
    <path id="fox-head" fill="#E07A35" />
    <path id="fox-ears" fill="#B85524" />
    <path id="fox-leg-back"  fill="#8A3A14" />
    <path id="fox-leg-front" fill="#8A3A14" />
  `;
  travelerLayer.appendChild(foxG);

  emberEl = document.createElement("div");
  emberEl.className = "ember-dot";
  document.querySelector(".stage").appendChild(emberEl);
}

// Traveler path builders. Figure is ~92px tall; feet at y=0.
// Proportions (reference: Journey cloaked wanderer):
//   head top  -88
//   neck      -72  (scarf anchors here)
//   shoulders -68
//   waist     -40
//   hem       -10  (widest)
//   feet        0
function cloakPath(sway) {
  const s = sway;
  // Fully TRAPEZOIDAL silhouette (no curves). Feet at y=0.
  // Stacked trapezoids: head, neck, body (taper bottom→top for the cloak body).
  //   head top  y=-74  (±2.0)
  //   head base y=-62  (±2.8)   -- small trapezoid head
  //   neck top  y=-62  (±2.2)
  //   neck base y=-56  (±3.0)   -- short trapezoid neck
  //   body top  y=-56  (±4.5)   -- narrow shoulders
  //   body bot  y=  0  (±12)    -- wide flared hem (big trapezoid)
  return [
    'M', (-12 + s*0.1).toFixed(2), 0,       // bottom-left hem
    'L', (-4.5 + s*0.5).toFixed(2), -56,    // left shoulder
    'L', (-3.0 + s*0.8).toFixed(2), -56,    // left neck base
    'L', (-2.2 + s*0.9).toFixed(2), -62,    // left neck top
    'L', (-2.8 + s).toFixed(2),    -62,     // left head base
    'L', (-2.0 + s).toFixed(2),    -74,     // left head top
    'L', ( 2.0 + s).toFixed(2),    -74,     // right head top
    'L', ( 2.8 + s).toFixed(2),    -62,     // right head base
    'L', ( 2.2 + s*0.9).toFixed(2), -62,
    'L', ( 3.0 + s*0.8).toFixed(2), -56,
    'L', ( 4.5 + s*0.5).toFixed(2), -56,
    'L', ( 12 + s*0.1).toFixed(2),  0,
    'Z'
  ].join(' ');
}
function headPath(sway) {
  // Head is now rendered as part of cloakPath (continuous silhouette).
  // Return an empty path so the separate <path id="traveler-head"> stays invisible.
  return '';
}
function hemPath(sway) {
  // Thin trapezoidal stripe plus a row of 5 tiny angular glyphs
  // embroidered along the hem. Keeps the silhouette legible from a distance.
  const parts = [];
  // base stripe
  parts.push('M', -11, -1, 'L', 11, -1, 'L', 11, 1, 'L', -11, 1, 'Z');
  // glyph centers, y sits just ABOVE the stripe so they show as embroidery
  const positions = [-8, -4, 0, 4, 8];
  const y = -3.4;
  for (let i = 0; i < positions.length; i++) {
    const cx = positions[i];
    const kind = i % 3;
    if (kind === 0) {
      // ≡ three tiny horizontal bars
      parts.push('M', cx-1.3, y-1.1, 'L', cx+1.3, y-1.1, 'L', cx+1.3, y-0.8, 'L', cx-1.3, y-0.8, 'Z');
      parts.push('M', cx-1.3, y-0.3, 'L', cx+1.3, y-0.3, 'L', cx+1.3, y+0.0, 'L', cx-1.3, y+0.0, 'Z');
      parts.push('M', cx-1.3, y+0.5, 'L', cx+1.3, y+0.5, 'L', cx+1.3, y+0.8, 'L', cx-1.3, y+0.8, 'Z');
    } else if (kind === 1) {
      // ⊥ bracket
      parts.push('M', cx-1.3, y-1.1, 'L', cx+1.3, y-1.1, 'L', cx+1.3, y-0.75, 'L', cx-1.3, y-0.75, 'Z');
      parts.push('M', cx-0.22, y-1.1, 'L', cx+0.22, y-1.1, 'L', cx+0.22, y+0.9, 'L', cx-0.22, y+0.9, 'Z');
    } else {
      // ⊞ dot-in-box
      parts.push('M', cx-1.3, y-1.1, 'L', cx+1.3, y-1.1, 'L', cx+1.3, y-0.78, 'L', cx-1.3, y-0.78, 'Z');
      parts.push('M', cx-1.3, y+0.6, 'L', cx+1.3, y+0.6, 'L', cx+1.3, y+0.92, 'L', cx-1.3, y+0.92, 'Z');
      parts.push('M', cx-1.3, y-1.1, 'L', cx-0.97, y-1.1, 'L', cx-0.97, y+0.9, 'L', cx-1.3, y+0.9, 'Z');
      parts.push('M', cx+0.97, y-1.1, 'L', cx+1.3, y-1.1, 'L', cx+1.3, y+0.9, 'L', cx+0.97, y+0.9, 'Z');
    }
  }
  return parts.join(' ');
}
function legPath(xOffset, phase) {
  // Legs removed — silhouette extends straight to the ground.
  return '';
}

// Scarf: long ribbon anchored at the neck (sway-tracked), trailing opposite
// of travel direction with a travelling-wave ripple.
function scarfPathImpl(time, dir, sway, length, amp, thickness, phaseOff, anchorY) {
  // Journey-style angular ribbon: tapers slightly through the middle, then
  // FLARES into a wide rectangular tip at the end (like a weighted cloth tail).
  const ax = sway * 0.7;
  const ay = anchorY;
  const back = -dir;
  const segs = 6;                // few segments -> clearly angular
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const droop = u * u * 5;
    const x = ax + back * u * length;
    const y = ay + Math.sin(time * 3.2 + u * 3.0 + phaseOff) * amp * u + droop;
    pts.push([x, y]);
  }
  // Thickness profile keyed by u (0=root, 1=tip):
  //   root ...... full thickness
  //   middle .... narrows to ~0.55 (visible taper)
  //   last 20% .. flares UP to a wide rectangular paddle (~1.6x base)
  function thicknessAt(u) {
    if (u < 0.75) {
      // Smooth taper from root to mid-slim
      const k = u / 0.75; // 0..1 across the shaft
      return thickness * (1 - k * 0.45);     // 1.0 -> 0.55
    }
    // Flared paddle in the last quarter
    const k = (u - 0.75) / 0.25;               // 0..1 across the paddle
    // Quickly ramp up to the wide tip, then hold flat for a rectangle feel
    const ramp = Math.min(1, k * 2.2);         // flares by u=0.86
    const paddle = 0.55 + ramp * 1.25;         // 0.55 -> 1.80 (base units)
    return thickness * paddle;
  }
  const top = [], bot = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(pts.length - 1, i + 1)];
    const tx = p1[0] - p0[0], ty = p1[1] - p0[1];
    const mag = Math.hypot(tx, ty) || 1;
    const nx = -ty / mag, ny = tx / mag;
    const u = i / (pts.length - 1);
    const th = thicknessAt(u);
    top.push([pts[i][0] + nx * th, pts[i][1] + ny * th]);
    bot.push([pts[i][0] - nx * th, pts[i][1] - ny * th]);
  }
  // Snap tip corners so the paddle reads as a clean rectangle:
  // last two vertices on top/bot use the same normal as the last segment.
  const tipIdx = pts.length - 1;
  const preIdx = tipIdx - 1;
  const ttx = pts[tipIdx][0] - pts[preIdx][0];
  const tty = pts[tipIdx][1] - pts[preIdx][1];
  const tmag = Math.hypot(ttx, tty) || 1;
  const tnx = -tty / tmag, tny = ttx / tmag;
  const tipTh = thicknessAt(1);
  top[tipIdx] = [pts[tipIdx][0] + tnx * tipTh, pts[tipIdx][1] + tny * tipTh];
  bot[tipIdx] = [pts[tipIdx][0] - tnx * tipTh, pts[tipIdx][1] - tny * tipTh];
  // Add an extra vertex slightly past the tip so the rectangle has a hard straight edge
  const extendLen = 3;
  const ex = pts[tipIdx][0] + (ttx / tmag) * extendLen;
  const ey = pts[tipIdx][1] + (tty / tmag) * extendLen;
  top.push([ex + tnx * tipTh, ey + tny * tipTh]);
  bot.push([ex - tnx * tipTh, ey - tny * tipTh]);

  let d = 'M ' + top[0][0].toFixed(2) + ' ' + top[0][1].toFixed(2);
  for (let i = 1; i < top.length; i++) d += ' L ' + top[i][0].toFixed(2) + ' ' + top[i][1].toFixed(2);
  for (let i = bot.length - 1; i >= 0; i--) d += ' L ' + bot[i][0].toFixed(2) + ' ' + bot[i][1].toFixed(2);
  d += ' Z';
  return d;
}
function scarfPath(time, dir, sway)     { return scarfPathImpl(time, dir, sway, 85, 10, 2.2, 0.0, -60); }
function scarfTailPath(time, dir, sway) { return scarfPathImpl(time, dir, sway, 105, 14, 1.5, 1.3, -58); }


// ===== Fox companion (all-trapezoidal, Journey-palette orange) =====
// Fox local origin: its own feet at y=0, drawn as a small creature
// about 22px long, 12px tall, facing RIGHT (same as traveler).
function foxBodyPath() {
  // Trapezoid body, wider at front, narrower at rear.
  return ['M', -10, -6, 'L', 8, -8, 'L', 8, 0, 'L', -10, 0, 'Z'].join(' ');
}
function foxBellyPath() {
  return ['M', -8, -2, 'L', 7, -3, 'L', 7, 0, 'L', -8, 0, 'Z'].join(' ');
}
function foxHeadPath() {
  // Trapezoidal head + pointed snout trapezoid, anchored at front of body.
  return [
    'M', 7, -12,    // top-back of head
    'L', 13, -11,   // top-front
    'L', 16, -7,    // snout tip top
    'L', 16, -5,    // snout tip bottom
    'L', 12, -6,    // lower snout
    'L', 8, -6,     // jaw
    'L', 7, -8,     // neck
    'Z'
  ].join(' ');
}
function foxEarsPath() {
  // Two triangular (trapezoidal-narrow) ears atop the head.
  return [
    // left ear
    'M', 8.5, -12, 'L', 9.2, -15, 'L', 10.2, -12.3, 'Z',
    // right ear
    'M', 11.2, -12.3, 'L', 12, -15, 'L', 12.8, -11.8, 'Z',
  ].join(' ');
}
function foxLegPath(xOffset, phase) {
  return '';
}
function foxTailPath(time) {
  // Pointed tail tapering from the fox body (x=-10) to a narrow tip (x=-19),
  // with an animated wag. The white tuft (foxTailTipPath) extends past the tip.
  const wag = Math.sin(time * 5) * 2;
  return [
    'M', -10, -7,
    'L', -14, -10 + wag,
    'L', -18, -8.5 + wag,
    'L', -19, -7 + wag,
    'L', -18, -5.5 + wag,
    'L', -14, -4 + wag,
    'L', -10, -4,
    'Z'
  ].join(' ');
}
function foxTailTipPath(time) {
  // Small white tuft extending beyond the tail's tip, wags in sync.
  const wag = Math.sin(time * 5) * 2;
  return [
    'M', -18, -8.5 + wag,
    'L', -22, -7 + wag,
    'L', -18, -5.5 + wag,
    'Z'
  ].join(' ');
}

function updateTraveler(progress, showEmber = true) {
  ensureTraveler();
  const w = window.innerWidth;
  const g = state.grainSize;
  const terr = smoothedTerrain();
    // --- GLIDE (not stride) ---
  // Traveler moves smoothly at a constant rate along the progress axis,
  // no discrete foot-planting. Legs still sway gently so the silhouette
  // doesn't look frozen, but xPx is a direct mapping of progress.
  const totalPx = Math.max(0, Math.min(w, progress * w));
  const xPx = totalPx;
  const colF = xPx / g;
  const col = Math.min(state.cols - 1, Math.floor(colF));
  const col2 = Math.min(state.cols - 1, col + 1);
  const frac = colF - col;
  const yCell = terr[col] * (1 - frac) + terr[col2] * frac;
  const yPx = yCell * g;
  // slope for terrain-following rotation (degrees)
  const dCol = 8;
  const yL = terr[Math.max(0, col - dCol)];
  const yR = terr[Math.min(state.cols - 1, col + dCol)];
  const slopePx = ((yR - yL) * g) / (2 * dCol * g);
  const angle = Math.atan2(slopePx, 1) * (180 / Math.PI);

  const time = performance.now() / 1000;
  // Gliding: barely-there vertical bob (½px) and a slow cloak sway.
  const bob = Math.sin(time * 1.2) * 0.35;
  const sway = Math.sin(time * 1.1) * 0.9;
  const dir = 1;
  // Slow leg sway only — no stride cadence. Half the old speed.
  const stridePhase = time * 0.9 * Math.PI;

  travelerEl.setAttribute("transform",
    `translate(${xPx}, ${yPx + bob}) rotate(${angle * 0.4})`);

  const cloak     = document.getElementById("traveler-cloak");
  const head      = document.getElementById("traveler-head");
  const hem       = document.getElementById("traveler-hem");
  const legBack   = document.getElementById("traveler-leg-back");
  const legFront  = document.getElementById("traveler-leg-front");
  const scarf     = document.getElementById("traveler-scarf");
  const scarfTail = document.getElementById("traveler-scarf-tail");

  if (legBack)  legBack.setAttribute("d",  legPath(-1.5, stridePhase + Math.PI));
  if (legFront) legFront.setAttribute("d", legPath( 1.5, stridePhase));
  if (cloak)    cloak.setAttribute("d", cloakPath(sway));
  if (hem)      hem.setAttribute("d", hemPath(sway));
  if (head)     head.setAttribute("d", headPath(sway));
  if (scarfTail) scarfTail.setAttribute("d", scarfTailPath(time, dir, sway));
  if (scarf)     scarf.setAttribute("d", scarfPath(time, dir, sway));

  // Hide the old ember dot entirely — silhouette is enough
  
  // --- FOX companion updates ---
  // Fox lives as a sibling of the traveler (NOT inside), so it uses world
  // coordinates and doesn't inherit the traveler's rotation. Its feet always
  // sit exactly on the terrain at its own x — no clipping, no floating.
  const foxOffsetPx = -38; // pixels behind the traveler
  const foxX = Math.max(0, xPx + foxOffsetPx);
  const foxColF = foxX / g;
  const foxCol = Math.min(state.cols - 1, Math.floor(foxColF));
  const foxCol2 = Math.min(state.cols - 1, foxCol + 1);
  const foxFrac = foxColF - foxCol;
  const foxTerrY = (terr[foxCol] * (1 - foxFrac) + terr[foxCol2] * foxFrac) * g;
  const foxBob = Math.sin(stridePhase + Math.PI * 0.5) * 0.4;
  const foxGroup = document.getElementById('fox');
  if (foxGroup) {
    foxGroup.setAttribute('transform',
      `translate(${foxX.toFixed(2)}, ${(foxTerrY + foxBob).toFixed(2)})`);
    const foxStride = stridePhase * 1.4;
    document.getElementById('fox-body').setAttribute('d', foxBodyPath());
    document.getElementById('fox-belly').setAttribute('d', foxBellyPath());
    document.getElementById('fox-head').setAttribute('d', foxHeadPath());
    document.getElementById('fox-ears').setAttribute('d', foxEarsPath());
    document.getElementById('fox-leg-back').setAttribute('d', foxLegPath(-6, foxStride + Math.PI));
    document.getElementById('fox-leg-front').setAttribute('d', foxLegPath(6, foxStride));
    document.getElementById('fox-tail').setAttribute('d', foxTailPath(time));
    document.getElementById('fox-tail-tip').setAttribute('d', foxTailTipPath(time));
  }

  if (emberEl) emberEl.classList.remove("visible");
}

function hideTraveler() {
  if (travelerEl) travelerEl.setAttribute("transform", "translate(-100,-100)");
  const foxGroup = document.getElementById('fox');
  if (foxGroup) foxGroup.setAttribute("transform", "translate(-100,-100)");
  if (emberEl) emberEl.classList.remove("visible");
}

/* ------- UI: gauge / clock / pips ------- */
const gaugeFill = document.getElementById("gaugeFill");
const gaugeCount = document.getElementById("gaugeCount");
const clockEl = document.getElementById("clock");
const helperEl = document.getElementById("helper");
const beginBtn = document.getElementById("beginBtn");
const promptEl = document.getElementById("prompt");
const phaseLabel = document.getElementById("phaseLabel");
const whisperEl = document.getElementById("whisper");
const whisperBig = document.getElementById("whisperBig");
const whisperSmall = document.getElementById("whisperSmall");
const sessionNum = document.getElementById("sessionNum");
const resetBtn = document.getElementById("resetBtn");
const pauseBtn = document.getElementById("pauseBtn");

function updateGauge() {
  const pct = 1 - state.sandUsed / state.sandQuota;
  gaugeFill.style.width = (pct * 100) + "%";
  const remaining = Math.max(0, state.sandQuota - state.sandUsed);
  if (state.sandUsed === 0) gaugeCount.textContent = "full";
  else if (remaining === 0) gaugeCount.textContent = "spent";
  else gaugeCount.textContent = Math.round(pct * 100) + "%";
}

function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function setClock(ms, ember = false) {
  clockEl.textContent = fmtTime(ms);
  clockEl.classList.toggle("ember", ember);
}

function updatePips() {
  sessionNum.textContent = ["one", "two", "three", "four"][state.session - 1];
}

/* ------- readiness ------- */
function checkReady() {
  // require the full sand quota to be poured before beginning — empty the hourglass first
  const ready = state.sandUsed >= state.sandQuota && state.phase === "idle";
  beginBtn.disabled = !ready;
  helperEl.textContent = ready ? "press begin — walking for " + state.focusMin + " minutes"
                               : (state.sandUsed === 0 ? "shape a path first" : "keep pouring — empty the hourglass");
  if (ready) {
    promptEl.classList.add("hidden");
    hideWhisper();
  }
}

/* ------- phase control ------- */
function startPhase(phase) {
  state.phase = phase;
  state.phaseStart = performance.now();
  state.paused = false;
  state.pausedElapsed = 0;
  pauseBtn.textContent = "pause";
  hideWhisper();
  promptEl.classList.add("hidden");
  document.body.classList.add("is-running");
  document.body.classList.toggle("phase-rest", phase === "short" || phase === "long");

  let dur = 0, label = "";
  if (phase === "focus") {
    dur = state.focusMin * 60 * 1000;
    label = "focus";
    // snapshot the journey baseline so each frame can compute live miles
    state.focusBaseTotalMin = state.totalFocusMin;
  } else if (phase === "short") {
    dur = state.shortMin * 60 * 1000;
    label = "rest";
  } else if (phase === "long") {
    dur = state.longMin * 60 * 1000;
    label = "long rest";
    // long rest stays in the golden-day palette like focus/short rest;
    // only the journey-end (after long rest) screen switches to dark night.
  }
  // (note: `night` class is now controlled solely by the user's dark-mode
  // toggle in the tweaks panel — no auto-add/remove based on phase)
  state.phaseDuration = dur;
  phaseLabel.textContent = label;
  beginBtn.style.display = "none";
  helperEl.textContent = phase === "focus"
    ? "walking the dune"
    : "breathe — resting";
  updatePips();
}

function refreshTotems() {
  // Number of totems lit = completed focus sessions within the current cycle.
  // During a long break (all 4 done), light all 4 before reset.
  let lit;
  if (state.phase === "long") {
    lit = 4;
  } else {
    // state.session is the CURRENT session index (1..4). Completed = session-1.
    // If we're in a focus phase, that focus isn't done yet, so still session-1.
    lit = Math.max(0, Math.min(4, state.session - 1));
  }
  const totems = document.querySelectorAll('#totems .totem');
  totems.forEach((el, idx) => {
    el.setAttribute('data-lit', idx < lit ? 'true' : 'false');
    // stagger breath so they don't pulse in unison
    el.style.setProperty('--breath-delay', (idx * 0.4) + 's');
  });
}

function completePhase() {
  if (state.phase === "focus") {
    state.completedFocus++;
    // snap to exact value so many frames of fractional accumulation don't drift
    state.totalFocusMin = state.focusBaseTotalMin + state.focusMin;
    updateJourneyDist();
    persistJourneyDist();
    playChime();
    if (state.session === 4) {
      startPhase("long");
    } else {
      // Light the totem for the session we JUST finished BEFORE starting break.
      state.session = Math.min(4, state.session + 1);
      refreshTotems();
      startPhase("short");
      return;
    }
    refreshTotems();
  } else if (state.phase === "short") {
    // Session increment already happened when focus completed; just idle.
    playChime();
    goIdleForNextFocus();
  } else if (state.phase === "long") {
    // full journey complete — don't auto-reset; wait for user to click "new journey"
    playChime();
    state.phase = "journey-end";
    state.paused = true;
    hideTraveler();
    document.body.classList.remove("is-running");
    document.body.classList.remove("phase-rest");
    document.body.classList.add("journey-end");
    // keep night bg and lit totems (celebration); click will reset them
  }
}

function goIdleForNextFocus() {
  state.phase = "idle";
  state.paused = true;
  hideTraveler();
  // clear sand for the next session
  clearSand();
  beginBtn.style.display = "";
  beginBtn.disabled = true;
  helperEl.textContent = "shape a new path";
  phaseLabel.textContent = "focus";
  setClock(state.focusMin * 60 * 1000, false);
  promptEl.classList.remove("hidden");
  document.body.classList.remove("is-running");
  document.body.classList.remove("phase-rest");
  showWhisper("", "draw the next path");
  setTimeout(hideWhisper, 2800);
  updatePips();
}

function clearSand() {
  state.grid.fill(0);
  state.sandUsed = 0;
  state.terrain.fill(state.rows);
  if (state.persistentGrid) state.persistentGrid.fill(0);
  updateGauge();
}

function spellOut(n) {
  const words = ["zero","one","two","three","four","five","six","seven","eight","nine","ten",
                 "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen",
                 "eighteen","nineteen","twenty"];
  return words[n] || String(n);
}

function showWhisper(big, small) {
  whisperBig.textContent = big;
  whisperSmall.textContent = small;
  whisperEl.classList.add("show");
  clearTimeout(showWhisper._t);
  showWhisper._t = setTimeout(() => whisperEl.classList.remove("show"), 3400);
}
function hideWhisper() {
  whisperEl.classList.remove("show");
}

/* ------- input ------- */
function eventXY(e) {
  const t = (e.touches && e.touches[0]) || e;
  return { x: t.clientX, y: t.clientY };
}

canvas.addEventListener("pointerdown", (e) => {
  if (state.phase !== "idle") return;
  state.dragging = true;
  const { x, y } = eventXY(e);
  state.lastX = x; state.lastY = y;
  dropAt(x, y);
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!state.dragging) return;
  const { x, y } = eventXY(e);
  // Fine-grained interpolation so fast drags still render a smooth ribbon.
  const stepPx = Math.max(1.5, state.brushRadius * 0.35);
  const dist = Math.hypot(x - state.lastX, y - state.lastY);
  const steps = Math.max(1, Math.floor(dist / stepPx));
  for (let s = 1; s <= steps; s++) {
    const xx = state.lastX + (x - state.lastX) * (s / steps);
    const yy = state.lastY + (y - state.lastY) * (s / steps);
    dropAt(xx, yy);
  }
  state.lastX = x; state.lastY = y;
});
const endDrag = () => { state.dragging = false; };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("pointerleave", endDrag);

beginBtn.addEventListener("click", () => {
  startPhase("focus");
});

function fullReset() {
  state.phase = "idle";
  state.session = 1;
  state.completedFocus = 0;
  state.paused = true;
  updatePips();
  refreshTotems();
  clearSand();
  hideTraveler();
  beginBtn.style.display = "";
  beginBtn.disabled = true;
  phaseLabel.textContent = "focus";
  setClock(state.focusMin * 60 * 1000, false);
  promptEl.classList.remove("hidden");
  helperEl.textContent = "shape a path first";
  document.body.classList.remove("is-running");
  document.body.classList.remove("phase-rest");
  document.body.classList.remove("journey-end");
}
resetBtn.addEventListener("click", fullReset);

const newJourneyBtn = document.getElementById("newJourneyBtn");
newJourneyBtn.addEventListener("click", fullReset);

pauseBtn.addEventListener("click", () => {
  if (state.phase === "idle" || state.phase === "journey-end") return;
  if (state.paused) {
    // resume: shift phaseStart so elapsed picks up where it left off
    state.phaseStart = performance.now() - state.pausedElapsed;
    state.paused = false;
    pauseBtn.textContent = "pause";
  } else {
    state.pausedElapsed = performance.now() - state.phaseStart;
    state.paused = true;
    pauseBtn.textContent = "resume";
  }
  updatePips();
});

/* ------- loop ------- */
// Run the cellular automaton multiple sub-steps per frame so grains fall
// fast enough to stack into tall dunes. Each stepSand() only moves a grain
// one cell — at 60Hz that tops out around 60 cells/sec, which feels like
// sand drifting in honey. 4 sub-steps makes it behave like real gravity.
const SAND_SUBSTEPS = 4;
function loop(t) {
  for (let s = 0; s < SAND_SUBSTEPS; s++) stepSand();
  render();

  if (state.phase === "idle" || state.phase === "journey-end") {
    hideTraveler();
  } else {
    // When paused, keep phaseStart sliding so `elapsed` stays frozen.
    if (state.paused) state.phaseStart = performance.now() - state.pausedElapsed;
    const elapsed = performance.now() - state.phaseStart;
    const remaining = state.phaseDuration - elapsed;
    const ember = state.phase === "focus";
    setClock(remaining, ember);

    if (state.phase === "focus") {
      const p = Math.min(1, elapsed / state.phaseDuration);
      updateTraveler(p, true);
      // Live-accumulate journey miles: 1 minute = 1 mile. Recompute from the
      // baseline each frame so no drift, and throttle the persist.
      const virtualElapsedMin = elapsed / 60000;
      state.totalFocusMin = state.focusBaseTotalMin + virtualElapsedMin;
      updateJourneyDist();
      if (performance.now() - lastJourneyPersist > 1000) {
        persistJourneyDist();
        lastJourneyPersist = performance.now();
      }
    } else {
      hideTraveler();
    }

    if (remaining <= 0) completePhase();
  }

  requestAnimationFrame(loop);
}

/* ------- journey distance (cumulative focus miles) ------- */
const JOURNEY_KEY = "hours.journey.v1";
const journeyDistEl = document.getElementById("journeyDist");
let lastJourneyPersist = 0;
try {
  const saved = parseFloat(localStorage.getItem(JOURNEY_KEY));
  if (!isNaN(saved) && saved >= 0) state.totalFocusMin = saved;
} catch (_) {}
function updateJourneyDist() {
  const n = Math.round(state.totalFocusMin);
  journeyDistEl.textContent = `${n} ${n === 1 ? "mile" : "miles"} traveled`;
}
function persistJourneyDist() {
  try { localStorage.setItem(JOURNEY_KEY, String(state.totalFocusMin)); } catch (_) {}
}
// flush on unload so partial focus time isn't lost
window.addEventListener("beforeunload", persistJourneyDist);
updateJourneyDist();

/* ------- bgm (background music) ------- */
// Drop a royalty-free track at ./bgm.mp3 (try Pixabay or Bensound).
// Volume is the BGM slider in the tweaks panel; 0 = paused, >0 = playing.
const bgmAudio = document.getElementById("bgm");
function applyBgmVolume() {
  const v = Math.max(0, Math.min(100, state.bgmVolume || 0)) / 100;
  bgmAudio.volume = v;
  if (v > 0 && bgmAudio.paused) bgmAudio.play().catch(() => {});
  if (v === 0 && !bgmAudio.paused) bgmAudio.pause();
}

/* ------- phase-end chime (Web Audio, no file needed) ------- */
let _audioCtx = null;
function playChime() {
  // Duck the BGM so the chime stands out, then resume after it ends.
  const bgmWasPlaying = !bgmAudio.paused;
  if (bgmWasPlaying) bgmAudio.pause();

  const REPS = 3;
  const REP_SPACING = 2.0;   // seconds between chime repetitions
  const NOTE2_OFFSET = 0.45; // seconds between A5 and E5 inside one rep
  const NOTE2_DUR = 1.6;
  // Total chime length: last note's start + its duration + small buffer
  const totalSec = (REPS - 1) * REP_SPACING + NOTE2_OFFSET + NOTE2_DUR + 0.3;

  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    // Soft sine note with quick attack + long exponential decay — bell-like.
    const note = (freq, start, dur, peak = 0.42) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur);
    };
    for (let i = 0; i < REPS; i++) {
      const t = now + i * REP_SPACING;
      note(880,    t, 1.4);                  // A5
      note(659.25, t + NOTE2_OFFSET, NOTE2_DUR); // E5
    }
  } catch (_) {
    // Web Audio failed — resume BGM immediately, no chime
    if (bgmWasPlaying) bgmAudio.play().catch(() => {});
    return;
  }

  if (bgmWasPlaying) {
    setTimeout(() => {
      if ((state.bgmVolume || 0) > 0) bgmAudio.play().catch(() => {});
    }, totalSec * 1000);
  }
}
// Initial application happens AFTER tweaks hydration restores state.bgmVolume
// from localStorage — see below the tweaks wiring.

/* ------- tweaks wiring ------- */
const tweaksEl = document.getElementById("tweaks");
const tkPairs = [
  ["tkFocus", "tkFocusV", "focusMin",     v => v + "m"],
  ["tkShort", "tkShortV", "shortMin",     v => v + "m"],
  ["tkLong",  "tkLongV",  "longMin",      v => v + "m"],
  ["tkSand",  "tkSandV",  "sandCoverage", v => v + "%"],
  ["tkBgm",   "tkBgmV",   "bgmVolume",    v => v],
];

/* hydrate from localStorage so user-adjusted values survive phase transitions
   and refreshes. runs BEFORE syncTweaksUI so the UI reflects saved values. */
const TWEAKS_STORAGE_KEY = "hours.tweaks.v1";
try {
  const saved = JSON.parse(localStorage.getItem(TWEAKS_STORAGE_KEY) || "{}");
  for (const [, , key] of tkPairs) {
    if (typeof saved[key] === "number") state[key] = saved[key];
  }
} catch (_) {}
// now that bgmVolume is restored, apply it. If > 0, defer play until first
// user interaction (browsers block autoplay before that).
applyBgmVolume();
if ((state.bgmVolume || 0) > 0) {
  const resume = () => {
    bgmAudio.play().catch(() => {});
    document.removeEventListener("pointerdown", resume);
  };
  document.addEventListener("pointerdown", resume, { once: true });
}
function persistTweaks() {
  const data = {};
  for (const [, , key] of tkPairs) data[key] = state[key];
  try { localStorage.setItem(TWEAKS_STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
}
function syncRangePct(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty("--pct", pct + "%");
}
function syncTweaksUI() {
  for (const [ctl, val, key, fmt] of tkPairs) {
    const c = document.getElementById(ctl);
    const v = document.getElementById(val);
    c.value = state[key];
    v.textContent = fmt(state[key]);
    syncRangePct(c);
  }
  setClock(state.focusMin * 60 * 1000, false);
  updateGauge();
}
for (const [ctl, val, key, fmt] of tkPairs) {
  const ctlEl = document.getElementById(ctl);
  syncRangePct(ctlEl);
  ctlEl.addEventListener("input", (e) => {
    const n = Number(e.target.value);
    state[key] = n;
    document.getElementById(val).textContent = fmt(n);
    syncRangePct(e.target);
    if (key === "grainSize") resize(false);
    if (key === "sandCoverage") { state.sandQuota = computeSandQuota(); updateGauge(); }
    if (key === "focusMin" && state.phase === "idle") setClock(state.focusMin * 60 * 1000, false);
    if (key === "bgmVolume") applyBgmVolume();
    // persist — localStorage for this tab, postMessage for editmode host
    persistTweaks();
    const edits = {}; edits[key] = n;
    try { window.parent.postMessage({ type: "__edit_mode_set_keys", edits }, "*"); } catch(_) {}
  });
}

/* hamburger toggle */
const tweaksToggle = document.getElementById("tweaksToggle");
tweaksToggle.addEventListener("click", () => {
  const open = tweaksEl.classList.toggle("open");
  tweaksToggle.classList.toggle("active", open);
});

/* edit-mode handshake */
window.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "__activate_edit_mode") {
    tweaksEl.classList.add("open");
    tweaksToggle.classList.add("active");
  } else if (d.type === "__deactivate_edit_mode") {
    tweaksEl.classList.remove("open");
    tweaksToggle.classList.remove("active");
  }
});
try { window.parent.postMessage({ type: "__edit_mode_available" }, "*"); } catch(_) {}

/* ------- boot ------- */
resize();
updatePips();
refreshTotems();
setClock(state.focusMin * 60 * 1000, false);
updateGauge();
syncTweaksUI();
requestAnimationFrame(loop);


// ===== SKY: drifting trapezoid clouds + bird flocks =====
(function() {
  const canvas = document.getElementById('sky-layer');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, DPR = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width  = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // Clouds: soft trapezoids drifting slowly right-to-left or left-to-right
  const clouds = [];
  function spawnCloud(offscreen) {
    const y = 40 + Math.random() * (H * 0.35);
    const w = 140 + Math.random() * 360;
    const h = 26 + Math.random() * 28;
    const speed = 0.08 + Math.random() * 0.14;   // px per frame baseline
    const dir = Math.random() < 0.7 ? 1 : -1;    // mostly left→right (wind direction)
    const x = offscreen
      ? (dir === 1 ? -w - Math.random() * 400 : W + Math.random() * 400)
      : Math.random() * W;
    const alpha = 0.28 + Math.random() * 0.32;
    clouds.push({ x, y, w, h, speed: speed * dir, alpha });
  }
  for (let i = 0; i < 6; i++) spawnCloud(false);

  function drawCloud(c) {
    // Layered trapezoids for a soft "clump" — no curves, all angular.
    ctx.globalAlpha = c.alpha;
    // back layer (wider, fainter)
    ctx.fillStyle = 'rgba(255, 238, 205, 0.55)';
    trap(c.x, c.y, c.w, c.h, 0.7);
    ctx.fillStyle = 'rgba(255, 228, 180, 0.85)';
    trap(c.x + c.w * 0.15, c.y - c.h * 0.35, c.w * 0.65, c.h * 0.75, 0.55);
    ctx.fillStyle = 'rgba(255, 248, 225, 0.9)';
    trap(c.x + c.w * 0.35, c.y - c.h * 0.65, c.w * 0.45, c.h * 0.55, 0.4);
    ctx.globalAlpha = 1;
  }
  function trap(x, y, w, h, topInset) {
    // Trapezoid: top edge narrower than bottom by topInset * w
    const inset = (w * topInset) / 2;
    ctx.beginPath();
    ctx.moveTo(x + inset, y);
    ctx.lineTo(x + w - inset, y);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fill();
  }

  // ===== BIRDS: smooth-curve silhouettes, gentle flap, loose V formations =====
  // Drawn with quadratic curves so wings read as actual wings, not polylines.
  // Flap cycles slowly (~1.4s per cycle); within a flock each bird has a small
  // phase offset so the flock doesn't pulse in unison.

  const flocks = [];

  function spawnFlock() {
    const y = 70 + Math.random() * (H * 0.42);
    const dir = Math.random() < 0.6 ? 1 : -1;            // mostly left→right
    const speed = (0.55 + Math.random() * 0.55) * dir;   // slow: 0.55..1.1 px/frame
    const startX = dir === 1 ? -80 : W + 80;
    const size = 0.85 + Math.random() * 0.5;             // some flocks bigger
    const n = 3 + Math.floor(Math.random() * 4);         // 3..6 birds
    const birds = [];
    // loose V / staggered trailing formation
    for (let i = 0; i < n; i++) {
      // half alternate to the near side, half to the far side of the leader
      const sideSign = i === 0 ? 0 : (i % 2 === 1 ? -1 : 1);
      const rank = i === 0 ? 0 : Math.ceil(i / 2);
      birds.push({
        ox: -rank * (22 + Math.random() * 8) * dir,
        oy: sideSign * rank * (5 + Math.random() * 3) + (Math.random() - 0.5) * 3,
        phase: Math.random() * Math.PI * 2,               // flap phase offset
        rate: 0.85 + Math.random() * 0.35,                // 0.85..1.2x individual cadence
        scale: size * (0.9 + Math.random() * 0.2)         // individual size jitter
      });
    }
    flocks.push({ x: startX, y, dir, speed, birds, t0: performance.now() });
  }

  let nextFlockAt = performance.now() + 2500 + Math.random() * 5000;

  // drawBird(x, y, dir, flapT) — flapT is a phase in radians.
  //   flapPos: 0 = wings flat/level, +1 = fully raised, -1 = fully lowered
  //   We favor the raised phase slightly (birds glide with wings up more often).
  function drawBird(x, y, dir, flapT, scale) {
    const sinT = Math.sin(flapT);
    // Bias so the neutral pose is wings-slightly-raised
    const flapPos = sinT * 0.5 + 0.3;   // range ≈ [-0.2, 0.8]

    const s = scale;
    const halfSpan = 9 * s;                            // horizontal reach of each wing
    const tipRise  = flapPos * 5 * s;                  // vertical lift at tips
    const bendLift = flapPos * 2.5 * s;                // mid-wing control-point lift
    // Body sits a hair lower than the wing roots so the silhouette reads
    const bodyDip  = 0.7 * s;

    ctx.beginPath();
    // Left wing: from left tip, curve inward & down to body
    ctx.moveTo(x - halfSpan, y - tipRise);
    ctx.quadraticCurveTo(
      x - halfSpan * 0.45, y - bendLift,      // control: mid-wing, slightly raised
      x,                   y + bodyDip        // body
    );
    // Right wing: curve back out & up to right tip
    ctx.quadraticCurveTo(
      x + halfSpan * 0.45, y - bendLift,
      x + halfSpan,        y - tipRise
    );
    ctx.stroke();
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(50, now - last) / 16.67; // ~1 at 60fps
    last = now;
    ctx.clearRect(0, 0, W, H);

    // ---- clouds ----
    for (let i = clouds.length - 1; i >= 0; i--) {
      const c = clouds[i];
      c.x += c.speed * dt;
      if (c.speed > 0 && c.x > W + 50) { clouds.splice(i, 1); spawnCloud(true); continue; }
      if (c.speed < 0 && c.x + c.w < -50) { clouds.splice(i, 1); spawnCloud(true); continue; }
      drawCloud(c);
    }

    // ---- birds ----
    if (now > nextFlockAt) {
      spawnFlock();
      nextFlockAt = now + 15000 + Math.random() * 20000; // rare flocks (15–35s)
    }
    // Atmospheric haze: desaturated warm-brown that blends toward the sky.
    // Lower saturation (R/G/B closer together) simulates distance haze without
    // losing visibility the way high transparency does.
    ctx.strokeStyle = 'rgba(118, 92, 70, 0.55)';
    ctx.lineWidth = 1.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Base flap angular speed: 2π radians per ~1.4s → 2π / (60fps * 1.4) ≈ 0.075 per frame
    const baseFlapPerFrame = 0.075;

    for (let i = flocks.length - 1; i >= 0; i--) {
      const f = flocks[i];
      f.x += f.speed * dt;
      // whole flock drifts vertically a touch
      const drift = Math.sin((now - f.t0) / 1800 + i) * 0.08;
      f.y += drift;
      for (const b of f.birds) {
        b.phase += baseFlapPerFrame * b.rate * dt;
        drawBird(f.x + b.ox, f.y + b.oy, f.dir, b.phase, b.scale);
      }
      // cull when off-screen
      if ((f.dir === 1 && f.x > W + 200) || (f.dir === -1 && f.x < -200)) {
        flocks.splice(i, 1);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
