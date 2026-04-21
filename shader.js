/* ==================================================================
   Interactive WebGL background — warm heat-shimmer with cursor-driven
   displacement. A ripple emanates from the cursor position and warps a
   warm FBM noise field; near the cursor a soft amber glow brightens.
   Layered via `mix-blend-mode: screen` over the SVG desert scene so it
   adds highlights rather than replacing the art.
   ================================================================== */
(function () {
  const canvas = document.getElementById("shader-bg");
  if (!canvas) return;
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
  if (!gl) { canvas.style.display = "none"; return; }

  const VS = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = (a_position + 1.0) * 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  const FS = `
    precision mediump float;
    varying vec2 v_uv;
    uniform float u_time;
    uniform vec2 u_mouse;      // 0..1 in GL space (origin bottom-left)
    uniform vec2 u_resolution;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
        mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
        u.y
      );
    }
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p *= 2.03;  // non-integer so octaves don't align
        a *= 0.5;
      }
      return v;
    }

    void main() {
      float aspect = u_resolution.x / u_resolution.y;
      vec2 uv = v_uv;

      // Vector from cursor to current fragment, aspect-corrected so the
      // ripple is circular on screen (not elliptical on wide viewports).
      vec2 toCursor = (uv - u_mouse) * vec2(aspect, 1.0);
      float dist = length(toCursor);

      // Ripple radiating from the cursor — sine modulated by exponential
      // falloff so influence is local to the cursor, not global.
      float ripple = sin(dist * 28.0 - u_time * 2.4) * exp(-dist * 3.2);
      vec2 dir = toCursor / max(dist, 0.0001);
      vec2 displacement = dir * ripple * 0.018;

      // Warm sand-like FBM, drifting slowly in time. The cursor
      // displacement perturbs the sample coordinates so the pattern
      // bends around the pointer.
      float n = fbm((uv + displacement) * 3.2 + vec2(u_time * 0.04, u_time * 0.02));

      // Palette: deep amber → warm cream
      vec3 deep = vec3(0.28, 0.14, 0.04);
      vec3 warm = vec3(0.98, 0.80, 0.50);
      vec3 color = mix(deep, warm, smoothstep(0.2, 0.9, n));

      // Soft glow that brightens near the cursor
      float glow = exp(-dist * 4.5);
      color = mix(color, vec3(1.0, 0.88, 0.60), glow * 0.55);

      // Overall alpha — subtle ambient; stronger near cursor
      float alpha = 0.18 + glow * 0.35;
      gl_FragColor = vec4(color, alpha);
    }
  `;

  function compile(src, type) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("shader compile error:", gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  const vs = compile(VS, gl.VERTEX_SHADER);
  const fs = compile(FS, gl.FRAGMENT_SHADER);
  if (!vs || !fs) { canvas.style.display = "none"; return; }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("program link error:", gl.getProgramInfoLog(program));
    canvas.style.display = "none";
    return;
  }
  gl.useProgram(program);

  // Fullscreen quad (two triangles)
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1, -1,  1,
    -1,  1,  1, -1,  1,  1,
  ]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(program, "u_time");
  const uMouse = gl.getUniformLocation(program, "u_mouse");
  const uResolution = gl.getUniformLocation(program, "u_resolution");

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  // Resize to viewport, capped at device pixel ratio 2 for perf on retina
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  resize();
  window.addEventListener("resize", resize);

  // Mouse follow with smoothing so the ripple trails the cursor gently.
  // GL's Y axis points up, so we flip the browser's Y.
  const target = { x: 0.5, y: 0.5 };
  const mouse = { x: 0.5, y: 0.5 };
  window.addEventListener("pointermove", (e) => {
    target.x = e.clientX / window.innerWidth;
    target.y = 1.0 - e.clientY / window.innerHeight;
  });
  // Start centered when pointer leaves the window so the ripple isn't stuck
  window.addEventListener("pointerleave", () => {
    target.x = 0.5;
    target.y = 0.5;
  });

  const t0 = performance.now();
  function frame() {
    // Exponential smoothing — cursor doesn't jerk, it eases.
    mouse.x += (target.x - mouse.x) * 0.08;
    mouse.y += (target.y - mouse.y) * 0.08;

    gl.uniform1f(uTime, (performance.now() - t0) * 0.001);
    gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.uniform2f(uResolution, canvas.width, canvas.height);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
