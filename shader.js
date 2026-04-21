/* ==================================================================
   Interactive WebGL shader — the cursor is a warm point light that
   illuminates the sand. It samples the sand canvas as a texture, so
   as the cursor passes over sand it brightens those pixels clearly;
   over empty air only a tiny halo hints at the cursor position.
   Clean radial light + a single geometric ripple, no haze/fog.
   ================================================================== */
(function () {
  const canvas = document.getElementById("shader-bg");
  if (!canvas) return;
  // Premultiplied alpha throughout. Safari's compositor divides RGB by A when
  // the context is premultipliedAlpha:false — with SRC_ALPHA blending over a
  // cleared buffer the framebuffer ends up with A=alpha² and RGB=color*alpha,
  // which on un-multiply becomes color/alpha and blows highlights out.
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true });
  if (!gl) { canvas.style.display = "none"; return; }

  // The sand canvas may not exist at script-load time if app.js runs after
  // and replaces it; grab a fresh reference each frame just in case.
  function getSandCanvas() { return document.getElementById("sand"); }

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
    uniform vec2 u_mouse;
    uniform vec2 u_resolution;
    uniform sampler2D u_sand;

    // 2D value noise — cheap, smooth enough for a slowly drifting mist layer.
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
    // Two octaves — enough body without feeling like noise grain.
    float mist(vec2 p) {
      return noise(p) * 0.65 + noise(p * 2.0) * 0.35;
    }

    void main() {
      vec2 uv = v_uv;
      // Sand canvas was uploaded with UNPACK_FLIP_Y_WEBGL, so uv.y aligns.
      vec4 sand = texture2D(u_sand, uv);

      // Aspect-corrected distance so the light is circular on any viewport.
      float aspect = u_resolution.x / u_resolution.y;
      vec2 toCursor = (uv - u_mouse) * vec2(aspect, 1.0);
      float dist = length(toCursor);

      // Radial falloffs for the cursor light — smaller overall diameter.
      float core = smoothstep(0.045, 0.0, dist);
      float ring = smoothstep(0.08, 0.015, dist);
      float glow = smoothstep(0.16, 0.03, dist);

      // Geometric ripple that travels outward from the cursor.
      float phase = dist * 28.0 - u_time * 3.5;
      float wave = pow(0.5 + 0.5 * sin(phase), 6.0) * exp(-dist * 4.0);

      // Sand mask — where there's sand.
      float sandMask = smoothstep(0.05, 0.35, sand.a);

      /* ---- sand illumination (warm point light on sand) ---- */
      vec3 cream = vec3(1.00, 0.96, 0.82);
      vec3 amber = vec3(1.00, 0.86, 0.54);
      vec3 sandColor = mix(amber, cream, core + ring * 0.6);
      float sandLight = (ring * 0.7 + glow * 0.35 + wave * 0.4) * sandMask;

      /* ---- mist layer (warm haze over the sky that the cursor parts) ---- */
      vec2 mp = uv * vec2(2.2, 1.4) + vec2(u_time * 0.015, u_time * 0.008);
      float mistField = mist(mp);
      float verticalBias = smoothstep(0.15, 1.0, uv.y);
      float mistDensity = (0.55 + 0.45 * mistField) * (0.55 + 0.45 * verticalBias);

      // Soft, gradual clearing — long falloff so there's no hard edge
      // between "cleared" and "full mist" (which was creating a dark ring).
      float clearing = smoothstep(0.22, 0.0, dist);
      mistDensity *= (1.0 - clearing * 0.75);

      vec3 mistColor = vec3(0.99, 0.94, 0.80);  // lighter, airier cream
      float mistAlpha = mistDensity * (1.0 - sandMask) * 0.48;

      /* ---- dreamy white-gold cursor light (IN AIR) ----
         Pale warm-white at center blending through light cream into mist —
         nothing saturated, no gold core that reads as a "dot". The whole
         effect is a soft luminous glow, like sun through high cloud. */
      vec3 glowCore = vec3(1.00, 0.98, 0.92);  // nearly white, faint warmth
      vec3 glowHalo = vec3(1.00, 0.94, 0.82);  // pale light cream
      float airCore = smoothstep(0.045, 0.0, dist);
      float airHalo = smoothstep(0.16, 0.01, dist); // wider, fades smoothly into mist

      /* ---- composite ---- */
      vec3 color;
      float alpha;
      if (sandMask > 0.5) {
        color = sandColor;
        alpha = sandLight + core * 0.4;
      } else {
        // Air: mist → pale halo → soft white-gold core, all in light tones
        vec3 airColor = mix(mistColor, glowHalo, airHalo);
        airColor = mix(airColor, glowCore, airCore * 0.8);
        float airAlpha = mistAlpha + airHalo * 0.35 + airCore * 0.40;
        color = airColor;
        alpha = airAlpha;
      }
      alpha = clamp(alpha, 0.0, 0.95);

      // Premultiplied output — paired with blendFunc(ONE, ONE_MINUS_SRC_ALPHA).
      gl_FragColor = vec4(color * alpha, alpha);
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

  // Fullscreen quad
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
  const uSand = gl.getUniformLocation(program, "u_sand");

  // Sand texture — uploaded from the sand canvas each frame.
  const sandTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, sandTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Upload a 1x1 transparent pixel as initial content so the sampler
  // never reads garbage before the first real upload.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]));

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 0);

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    // Canvas is a replaced element — without an explicit style size it
    // renders at its intrinsic (pixel-buffer) size, which on Retina MacBooks
    // overflows the viewport and desyncs UV from the cursor.
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
  }
  resize();
  window.addEventListener("resize", resize);

  const target = { x: 0.5, y: 0.5 };
  const mouse = { x: 0.5, y: 0.5 };
  function updateTarget(e) {
    target.x = e.clientX / window.innerWidth;
    target.y = 1.0 - e.clientY / window.innerHeight;
    // Expose pixel-coord cursor so other scripts (app.js clouds) can react.
    window.__hoursCursor = { x: e.clientX, y: e.clientY };
  }
  window.addEventListener("pointermove", updateTarget);
  window.addEventListener("mousemove", updateTarget);
  window.addEventListener("pointerleave", () => {
    target.x = 0.5; target.y = 0.5;
    window.__hoursCursor = null;
  });

  const t0 = performance.now();
  function frame() {
    // Higher smoothing factor → tighter cursor follow with just enough
    // easing to keep the ripple from snapping.
    mouse.x += (target.x - mouse.x) * 0.45;
    mouse.y += (target.y - mouse.y) * 0.45;

    // Upload the current sand canvas as the texture. WebGL's UNPACK_FLIP_Y
    // flag is set just for this upload so canvas top-left maps to
    // top-left on screen (matching our v_uv orientation).
    const sandCanvas = getSandCanvas();
    if (sandCanvas && sandCanvas.width > 0 && sandCanvas.height > 0) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sandTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sandCanvas);
      } catch (_) { /* canvas not ready this frame — skip */ }
      gl.uniform1i(uSand, 0);
    }

    gl.uniform1f(uTime, (performance.now() - t0) * 0.001);
    gl.uniform2f(uMouse, mouse.x, mouse.y);
    gl.uniform2f(uResolution, canvas.width, canvas.height);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
