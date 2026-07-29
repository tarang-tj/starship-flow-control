// Digital-thread renderer. Draws an ORIGINAL procedural stainless-steel heavy-lift
// launch vehicle in WebGL and uses it as the spatial index into the synthetic BOM.
// Import-free on purpose: GitHub Pages serves this module with no build step.
// Nothing here depicts, replicates, or is derived from any real vehicle CAD,
// imagery, or trade dress; the geometry is generated from the numbers below.

const THREAD_LAYOUT = [
  ["VEHICLE", 0, -112, 0],
  ["PROP-MODULE", -158, -18, 12],
  ["HEAT-SHIELD", 0, 18, 28],
  ["AVIONICS", 158, -18, 12],
  ["ENGINE", -205, 116, 42],
  ["METHANE-VALVE", -105, 144, 54],
  ["TPS-TILE", 0, 158, 62],
  ["FLIGHT-COMP", 158, 132, 48],
];

const THREAD_LINKS = [
  ["VEHICLE", "PROP-MODULE"], ["VEHICLE", "HEAT-SHIELD"], ["VEHICLE", "AVIONICS"],
  ["PROP-MODULE", "ENGINE"], ["PROP-MODULE", "METHANE-VALVE"],
  ["HEAT-SHIELD", "TPS-TILE"], ["AVIONICS", "FLIGHT-COMP"],
];

const FALLBACK_PARTS = {
  VEHICLE: ["Integrated vehicle", "Integration"],
  "PROP-MODULE": ["Propulsion module", "Propulsion"],
  "HEAT-SHIELD": ["Thermal protection set", "Structures"],
  AVIONICS: ["Avionics package", "Avionics"],
  ENGINE: ["Engine assembly", "Propulsion"],
  "METHANE-VALVE": ["Cryogenic methane valve", "Propulsion"],
  "TPS-TILE": ["Thermal protection tile", "Structures"],
  "FLIGHT-COMP": ["Flight computer", "Avionics"],
};

function stateFor(result, path) {
  if (!result.summary?.gap || path.length <= 1) return "clear";
  const leaf = path.at(-1);
  if (leaf === "TPS-TILE" || path.includes("HEAT-SHIELD")) return "thermal";
  if (leaf === "ENGINE" || leaf === "METHANE-VALVE" || path.includes("PROP-MODULE")) return "propulsion";
  return "constraint";
}

export function buildThreadModel(result) {
  if (!result || !result.summary) throw new TypeError("A scenario evaluation result is required");
  const constraintPath = result.root?.path?.length ? [...result.root.path] : ["VEHICLE"];
  const state = stateFor(result, constraintPath);
  const labels = {
    thermal: "THERMAL CONSTRAINT", propulsion: "PROPULSION CONSTRAINT",
    constraint: "ACTIVE CONSTRAINT", clear: "PLAN CLEAR",
  };
  const activeEdges = new Set(constraintPath.slice(1).map((id, index) => `${constraintPath[index]}:${id}`));
  const constraintById = new Map((result.constraints || []).map((item) => [item.id, item]));
  const nodes = THREAD_LAYOUT.map(([id, x, y, z]) => {
    const supplied = result.parts?.[id] || {};
    const fallback = FALLBACK_PARTS[id];
    const constraint = constraintById.get(id);
    const onPath = constraintPath.includes(id);
    let status = onPath ? "path" : "nominal";
    if (state === "clear" && id === "VEHICLE") status = "clear";
    else if (state !== "clear" && id === constraintPath.at(-1)) status = "limiting";
    const name = supplied.name || fallback[0];
    const category = supplied.category || fallback[1];
    return {
      id, x, y, z, name, category, status, selectable: true,
      detail: {
        id, name, category, status,
        scenarioState: state,
        readiness: `${result.summary.ready} / ${result.summary.target}`,
        shortage: constraint?.shortage || 0,
        risk: constraint?.risk || 0,
        action: constraint?.action || (state === "clear" ? "No recovery action required." : "Not on the limiting path."),
      },
    };
  });
  const links = THREAD_LINKS.map(([from, to]) => ({ from, to, active: state !== "clear" && activeEdges.has(`${from}:${to}`) }));
  return { state, label: labels[state], constraintPath, nodes, links, summary: { ...result.summary } };
}

/* ------------------------------------------------------------------ palette */

const ACCENT = [1.0, 0.52, 0.18];      // the single warm constraint accent
const CLEAR = [0.42, 0.88, 0.66];      // cool signal, reserved for "plan clear"
const ACCENT_CSS = "#ff8530";
const CLEAR_CSS = "#6be0a9";
const STEEL_CSS = "#93a4b8";

/* ------------------------------------------------------------- linear algebra */

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function lookAt(eye, target) {
  const z = unit(sub(eye, target));
  const x = unit(cross([0, 1, 0], z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/* -------------------------------------------------- procedural vehicle geometry
 * Y is the vehicle axis, +Z is the windward (thermal protection) face, which is
 * the face turned toward the camera so the thermal story is actually visible.
 * Every subsystem below is one contiguous vertex range so a subsystem is one
 * draw call with its own explode offset and constraint tint.
 * kind: 0 rolled stainless sheet, 1 ceramic thermal tile, 2 nozzle alloy, 3 machined block.
 */

const R = 0.5;

// Stack members separate along the vehicle axis; attached hardware separates
// sideways into the space the lens shift opens up. The axial offsets are chosen
// so no subsystem ends up inside another once fully exploded (in particular the
// avionics collar has to clear the nose), and the lateral ones are staggered in
// height so the four detached items never overlap each other.
const SUBSYSTEMS = {
  VEHICLE: { anchor: [0, 0.62, 0], extent: 0.72, explode: [0, 0.25, 0] },
  "PROP-MODULE": { anchor: [0, -1.62, 0], extent: 0.66, explode: [0, -0.95, 0] },
  AVIONICS: { anchor: [0, 1.4, 0], extent: 0.6, explode: [0, 1.95, 0] },
  ENGINE: { anchor: [0, -2.66, 0], extent: 0.58, explode: [0, -1.75, 0] },
  "HEAT-SHIELD": { anchor: [0, 0.34, 0.56], extent: 0.62, explode: [1.55, 0.35, 0.85] },
  "TPS-TILE": { anchor: [0, 0.24, 0.64], extent: 0.32, explode: [2.55, -0.85, 1.15] },
  "FLIGHT-COMP": { anchor: [0.62, 1.38, 0], extent: 0.2, explode: [1.5, 1.65, 0.5] },
  "METHANE-VALVE": { anchor: [0.6, -1.3, 0], extent: 0.26, explode: [1.55, -1.7, 0.4] },
};

function faces(target, profile, options) {
  const { segments, kind } = options;
  const a0 = options.arcStart ?? 0;
  const a1 = options.arcEnd ?? Math.PI * 2;
  const flat = options.flat === true;
  const [ox, oy, oz] = options.offset || [0, 0, 0];
  for (let i = 0; i < profile.length - 1; i += 1) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i + 1];
    const len = Math.hypot(r1 - r0, y1 - y0) || 1;
    const nr = (y1 - y0) / len;
    const ny = -(r1 - r0) / len;
    for (let j = 0; j < segments; j += 1) {
      const t0 = a0 + (a1 - a0) * (j / segments);
      const t1 = a0 + (a1 - a0) * ((j + 1) / segments);
      const tm = (t0 + t1) / 2;
      const corners = [[r0, y0, t0], [r0, y0, t1], [r1, y1, t1], [r1, y1, t0]];
      const points = corners.map(([r, y, a]) => [ox + r * Math.cos(a), oy + y, oz + r * Math.sin(a)]);
      const normals = corners.map(([, , a]) => (flat
        ? [nr * Math.cos(tm), ny, nr * Math.sin(tm)]
        : [nr * Math.cos(a), ny, nr * Math.sin(a)]));
      const tangents = corners.map(([, , a]) => (flat ? [-Math.sin(tm), 0, Math.cos(tm)] : [-Math.sin(a), 0, Math.cos(a)]));
      for (const k of [0, 1, 2, 0, 2, 3]) target.push(...points[k], ...normals[k], ...tangents[k], kind);
    }
  }
}

function ogive(from, to, radius, steps) {
  const profile = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    profile.push([radius * Math.cos(t * Math.PI * 0.5) ** 0.68, from + (to - from) * t]);
  }
  return profile;
}

function buildVehicle() {
  const data = [];
  const ranges = new Map();
  const seg = 44;
  const mark = (id, fn) => {
    const first = data.length / 10;
    fn();
    ranges.set(id, { first, count: data.length / 10 - first });
  };

  mark("PROP-MODULE", () => {
    faces(data, [[R, -1.05], [R, -1.86], [0.548, -1.97], [0.548, -2.14], [0.5, -2.23]], { segments: seg, kind: 0 });
    faces(data, [[0.5, -2.23], [0.34, -2.26], [0.0, -2.28]], { segments: seg, kind: 3, flat: true });
  });

  mark("VEHICLE", () => {
    faces(data, [[R, -1.05], [R, 0.4], [R, 1.72]], { segments: seg, kind: 0 });
    faces(data, ogive(1.72, 2.52, 0.5, 9), { segments: seg, kind: 0 });
  });

  mark("HEAT-SHIELD", () => {
    const windward = Math.PI / 2;
    faces(data, [[0.5, -1.02], [0.538, -0.94], [0.538, 1.56], [0.5, 1.64]], {
      segments: 26, kind: 1, arcStart: windward - 1.22, arcEnd: windward + 1.22,
    });
  });

  mark("AVIONICS", () => {
    faces(data, [[0.505, 1.16], [0.552, 1.23], [0.552, 1.55], [0.505, 1.62]], { segments: seg, kind: 3 });
  });

  mark("ENGINE", () => {
    const bell = [];
    for (let i = 0; i <= 9; i += 1) {
      const t = i / 9;
      bell.push([0.052 + 0.152 * t ** 0.62, -2.28 - 0.76 * t]);
    }
    for (const angle of [Math.PI / 2, Math.PI * 7 / 6, Math.PI * 11 / 6]) {
      faces(data, bell, { segments: 22, kind: 2, offset: [0.235 * Math.cos(angle), 0, 0.235 * Math.sin(angle)] });
    }
  });

  mark("METHANE-VALVE", () => {
    faces(data, [[0.0, -1.46], [0.105, -1.46], [0.105, -1.24], [0.0, -1.24]], { segments: 6, kind: 3, flat: true, offset: [0.56, 0, 0] });
    faces(data, [[0.042, -1.24], [0.042, -0.24]], { segments: 8, kind: 3, offset: [0.56, 0, 0] });
  });

  // The limiting leaf has to be legible at thumbnail size, so the tile patch is
  // both larger than a real tile and noticeably proud of the shield beneath it.
  mark("TPS-TILE", () => {
    const windward = Math.PI / 2;
    for (let col = 0; col < 4; col += 1) {
      for (let row = 0; row < 3; row += 1) {
        const a = windward - 0.435 + col * 0.29;
        const y = -0.16 + row * 0.28;
        faces(data, [[0.552, y], [0.592, y + 0.022], [0.592, y + 0.208], [0.552, y + 0.23]], {
          segments: 4, kind: 1, arcStart: a, arcEnd: a + 0.235,
        });
      }
    }
  });

  mark("FLIGHT-COMP", () => {
    faces(data, [[0.0, 1.27], [0.088, 1.27], [0.088, 1.49], [0.0, 1.49]], {
      segments: 4, kind: 3, flat: true, arcStart: Math.PI / 4, arcEnd: Math.PI / 4 + Math.PI * 2, offset: [0.6, 0, 0.02],
    });
  });

  return { data: new Float32Array(data), ranges };
}

/* -------------------------------------------------------------------- shaders */

const MESH_VERTEX = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec3 aTangent;
attribute float aKind;
uniform mat4 uViewProj;
uniform vec3 uOffset;
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vTangent;
varying float vKind;
varying float vAxial;
void main() {
  vec3 world = aPos + uOffset;
  vPos = world;
  vNormal = aNormal;
  vTangent = aTangent;
  vKind = aKind;
  vAxial = aPos.y;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

// Anisotropic stainless: the specular streak follows the circumferential tangent,
// which is what makes a rolled steel barrel read as steel rather than plastic.
const MESH_FRAGMENT = `
precision highp float;
varying vec3 vPos;
varying vec3 vNormal;
varying vec3 vTangent;
varying float vKind;
varying float vAxial;
uniform vec3 uEye;
uniform vec3 uAccentColor;
uniform vec3 uClearColor;
uniform float uAccent;
uniform float uHighlight;
uniform float uClearMix;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uEye - vPos);
  vec3 T = normalize(vTangent - N * dot(N, vTangent));

  float grain = hash11(floor(vAxial * 430.0));
  float seam = abs(fract(vAxial * 2.38) - 0.5) * 2.0;
  float weld = smoothstep(0.86, 1.0, seam);
  float stringer = smoothstep(0.980, 1.0, abs(fract(vAxial * 11.9) - 0.5) * 2.0);
  float shade = 1.0 - weld * 0.46 - stringer * 0.14;

  vec3 key = normalize(vec3(-0.62, 0.74, 0.55));
  vec3 fill = normalize(vec3(0.80, 0.18, -0.42));
  float dKey = max(dot(N, key), 0.0);
  float dFill = max(dot(N, fill), 0.0);

  // Ward anisotropic lobe. A plain pow(sin(T,H), n) term is close to 1 across
  // most of a cylinder, so it floods the whole hull with white instead of
  // making a streak. Splitting the roughness across the circumferential
  // tangent (broad) and the axial bitangent (tight) gives the narrow rolled
  // sheet highlight, and leaves everything off-highlight properly dark.
  // Tight across the circumferential tangent, broad along the axis: that draws
  // the highlight as a vertical band running down the barrel, which is what a
  // rolled stainless cylinder actually does. The other way round the lobe never
  // lights at all, because the key light sits high and the axial bitangent then
  // pushes the exponent to zero everywhere.
  vec3 B = normalize(cross(N, T));
  float alongT = 0.055 + grain * 0.055;
  float alongB = 0.55;

  vec3 hKey = normalize(key + V);
  float nhKey = max(dot(N, hKey), 0.0);
  float tKey = dot(hKey, T) / alongT;
  float bKey = dot(hKey, B) / alongB;
  float aniso = exp(-2.0 * (tKey * tKey + bKey * bKey) / (1.0 + nhKey)) * step(0.0, dot(N, key));

  vec3 hFill = normalize(fill + V);
  float nhFill = max(dot(N, hFill), 0.0);
  float tFill = dot(hFill, T) / 0.030;
  float bFill = dot(hFill, B) / 0.40;
  float anisoFill = exp(-2.0 * (tFill * tFill + bFill * bFill) / (1.0 + nhFill)) * step(0.0, dot(N, fill));

  float fresnel = pow(1.0 - max(dot(N, V), 0.0), 4.0);

  // Albedos are authored in linear light: the tone curve and the 1/2.2 encode
  // below lift them hard, so ceramic and nozzle alloy have to start near black
  // to survive as dark surfaces against the stainless.
  float isTile = step(0.5, vKind) * step(vKind, 1.5);
  float isNozzle = step(1.5, vKind) * step(vKind, 2.5);
  float isBlock = step(2.5, vKind);
  vec3 base = vec3(0.40, 0.44, 0.51);
  base = mix(base, vec3(0.042, 0.044, 0.052), isTile);
  base = mix(base, vec3(0.105, 0.110, 0.122), isNozzle);
  base = mix(base, vec3(0.22, 0.24, 0.28), isBlock);
  float metal = 1.0 - isTile * 0.88;

  vec3 col = base * (0.15 + 0.70 * dKey) * shade;
  col += base * dFill * 0.24;
  col += vec3(1.0, 0.99, 0.97) * aniso * 0.90 * metal;
  col += vec3(0.55, 0.68, 0.92) * anisoFill * 0.34 * metal;
  col += vec3(0.14, 0.20, 0.32) * fresnel * (0.20 + 0.80 * metal);

  col *= 1.35;
  col = col / (col + vec3(1.0));
  col = pow(col, vec3(1.0 / 2.2));

  // Constraint signalling happens after the tone curve, in display space. Doing
  // it before means the highlight rolloff compresses the red channel and the
  // gamma encode lifts the blue, so a saturated warning colour comes out pale
  // peach. The root subsystem is always on the constraint path, so the body
  // tint is steeply non-linear as well: only the limiting subsystem takes real
  // colour, the rest of the path carries a silhouette rim.
  float windward = max(0.0, N.z);
  float heat = uAccent * mix(1.0, 0.35 + 0.65 * windward, isTile);
  // A tight rim (exponent 6) rather than the broad fresnel above: on a slender
  // cylinder a broad term covers most of the visible width and turns stainless
  // into copper, which is both off-brand and a false material cue.
  float rim = pow(1.0 - max(dot(N, V), 0.0), 6.0);
  col = mix(col, uAccentColor, clamp(pow(heat, 2.4) * 0.85, 0.0, 0.92));
  col += uAccentColor * heat * (0.01 + 0.55 * rim);
  col = mix(col, uClearColor, uClearMix * (0.05 + 0.55 * rim));
  // Selection is already carried by the corner brackets, so this stays a thin
  // edge, and it backs off on warm subsystems. Small parts are nearly all
  // grazing angle, so an unconditional white lift bleaches the accent straight
  // off the limiting leaf, which is the one thing that must stay readable.
  col += vec3(0.82, 0.91, 1.0) * uHighlight * rim * 0.30 * (1.0 - 0.70 * heat);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Overlay geometry arrives already in clip space so the callout rules stay
// pixel-exact. Untextured shapes point at an opaque white texel in the atlas,
// which keeps the whole HUD to a single draw call.
const OVERLAY_VERTEX = `
attribute vec2 aPos;
attribute vec2 aUV;
attribute vec4 aColor;
varying vec2 vUV;
varying vec4 vColor;
void main() {
  vUV = aUV;
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const OVERLAY_FRAGMENT = `
precision mediump float;
varying vec2 vUV;
varying vec4 vColor;
uniform sampler2D uTex;
void main() {
  gl_FragColor = vec4(vColor.rgb, vColor.a * texture2D(uTex, vUV).a);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl, vertexSource, fragmentSource) {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`program link failed: ${log}`);
  }
  return program;
}

/* --------------------------------------------------------------- label atlas */

const ATLAS = 512;
const ROW = 34;

function buildAtlas(doc, entries) {
  const surface = doc?.createElement?.("canvas");
  const ctx = surface?.getContext?.("2d");
  if (!ctx) return null;
  surface.width = ATLAS;
  surface.height = ATLAS;
  ctx.clearRect(0, 0, ATLAS, ATLAS);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 8, 8);
  ctx.font = '600 22px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = "middle";
  const rows = new Map();
  let y = 10;
  for (const [key, text] of entries) {
    if (y + ROW > ATLAS) break;
    const width = Math.min(ATLAS - 6, Math.ceil(ctx.measureText(text).width) + 2);
    ctx.fillText(text, 3, y + ROW / 2, ATLAS - 8);
    rows.set(key, { u0: 2 / ATLAS, v0: y / ATLAS, u1: (2 + width) / ATLAS, v1: (y + ROW) / ATLAS, width, height: ROW });
    y += ROW;
  }
  return { surface, rows };
}

/* ------------------------------------------------------------- webgl renderer */

function createWebglRenderer(gl, doc) {
  const geometry = buildVehicle();
  const mesh = link(gl, MESH_VERTEX, MESH_FRAGMENT);
  const overlay = link(gl, OVERLAY_VERTEX, OVERLAY_FRAGMENT);
  const meshBuffer = gl.createBuffer();
  const overlayBuffer = gl.createBuffer();
  const backdropBuffer = gl.createBuffer();
  const texture = gl.createTexture();

  gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, geometry.data, gl.STATIC_DRAW);

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));

  const meshAttr = {
    pos: gl.getAttribLocation(mesh, "aPos"),
    normal: gl.getAttribLocation(mesh, "aNormal"),
    tangent: gl.getAttribLocation(mesh, "aTangent"),
    kind: gl.getAttribLocation(mesh, "aKind"),
  };
  const meshUniform = {
    viewProj: gl.getUniformLocation(mesh, "uViewProj"),
    offset: gl.getUniformLocation(mesh, "uOffset"),
    eye: gl.getUniformLocation(mesh, "uEye"),
    accentColor: gl.getUniformLocation(mesh, "uAccentColor"),
    clearColor: gl.getUniformLocation(mesh, "uClearColor"),
    accent: gl.getUniformLocation(mesh, "uAccent"),
    highlight: gl.getUniformLocation(mesh, "uHighlight"),
    clearMix: gl.getUniformLocation(mesh, "uClearMix"),
  };
  const overlayAttr = {
    pos: gl.getAttribLocation(overlay, "aPos"),
    uv: gl.getAttribLocation(overlay, "aUV"),
    color: gl.getAttribLocation(overlay, "aColor"),
  };
  const overlayTex = gl.getUniformLocation(overlay, "uTex");

  let atlas = null;
  let atlasKey = "";
  let pickables = [];
  let pickRatio = 1;

  function syncAtlas(model) {
    const entries = model.nodes.map((node) => [node.id, node.name.toUpperCase()]);
    const key = entries.map(([, text]) => text).join("|");
    if (key === atlasKey) return;
    const next = buildAtlas(doc, entries);
    atlasKey = key;
    atlas = next;
    if (!next) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, next.surface);
  }

  const WHITE = { u0: 2 / ATLAS, v0: 2 / ATLAS, u1: 6 / ATLAS, v1: 6 / ATLAS };

  function quad(out, x, y, w, h, color, uv = WHITE) {
    const push = (px, py, u, v) => out.push(px, py, u, v, color[0], color[1], color[2], color[3]);
    const x0 = x;
    const y0 = y;
    const x1 = x + w;
    const y1 = y + h;
    push(x0, y0, uv.u0, uv.v0);
    push(x1, y0, uv.u1, uv.v0);
    push(x1, y1, uv.u1, uv.v1);
    push(x0, y0, uv.u0, uv.v0);
    push(x1, y1, uv.u1, uv.v1);
    push(x0, y1, uv.u0, uv.v1);
  }

  // Screen-space (pixel) helpers that emit clip-space vertices.
  function makeScreen(out, width, height) {
    const nx = (x) => (x / width) * 2 - 1;
    const ny = (y) => 1 - (y / height) * 2;
    return {
      rect(x, y, w, h, color, uv) {
        quad(out, nx(x), ny(y), nx(x + w) - nx(x), ny(y + h) - ny(y), color, uv);
      },
      line(x0, y0, x1, y1, thickness, color) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const px = (-dy / len) * (thickness / 2);
        const py = (dx / len) * (thickness / 2);
        const corners = [[x0 + px, y0 + py], [x1 + px, y1 + py], [x1 - px, y1 - py], [x0 - px, y0 - py]];
        for (const index of [0, 1, 2, 0, 2, 3]) {
          const [cx, cy] = corners[index];
          out.push(nx(cx), ny(cy), WHITE.u0, WHITE.v0, color[0], color[1], color[2], color[3]);
        }
      },
    };
  }

  // Static vertical gradient behind the vehicle; NDC, so it never needs rebuilding.
  const backdropData = (() => {
    const out = [];
    const stops = [
      [1.0, [0.047, 0.060, 0.078, 1]], [0.20, [0.060, 0.077, 0.100, 1]],
      [-0.40, [0.031, 0.043, 0.059, 1]], [-1.0, [0.010, 0.014, 0.020, 1]],
    ];
    const push = (x, y, c) => out.push(x, y, WHITE.u0, WHITE.v0, c[0], c[1], c[2], c[3]);
    for (let i = 0; i < stops.length - 1; i += 1) {
      const [yTop, top] = stops[i];
      const [yBottom, bottom] = stops[i + 1];
      push(-1, yTop, top); push(1, yTop, top); push(1, yBottom, bottom);
      push(-1, yTop, top); push(1, yBottom, bottom); push(-1, yBottom, bottom);
    }
    return new Float32Array(out);
  })();
  gl.bindBuffer(gl.ARRAY_BUFFER, backdropBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, backdropData, gl.STATIC_DRAW);

  // buildThreadModel still reports the old path membership once the gap closes,
  // so a recovered plan would otherwise show "PLAN CLEAR" next to two glowing
  // warm subsystems. Rendering treats path membership as inert when the
  // scenario is clear; the model itself is left alone.
  function tintFor(status, state) {
    if (state === "clear") {
      return status === "clear" ? { accent: 0, clear: 1, css: CLEAR } : { accent: 0, clear: 0, css: null };
    }
    if (status === "limiting") return { accent: 1, clear: 0, css: ACCENT };
    if (status === "path") return { accent: 0.20, clear: 0, css: ACCENT };
    return { accent: 0, clear: 0, css: null };
  }

  function draw(view) {
    const { model, width, height, ratio } = view;
    pickRatio = ratio;
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.010, 0.014, 0.020, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    drawOverlay(backdropBuffer, null, backdropData.length / 8);

    if (!model) {
      pickables = [];
      return;
    }
    syncAtlas(model);

    const aspect = width / Math.max(1, height);
    const explode = view.explode;
    const spread = Math.min(1, Math.max(0.5, aspect / 1.5)) * explode;
    const halfHeight = 3.06 + explode * 1.62;
    const distance = 9.2;
    const yaw = 0.36 + view.parallax[0];
    const pitch = 0.10 + view.parallax[1];
    const target = [0, -0.25 - explode * 0.45, 0];
    const eye = [
      target[0] + Math.sin(yaw) * Math.cos(pitch) * distance,
      target[1] + Math.sin(pitch) * distance,
      target[2] + Math.cos(yaw) * Math.cos(pitch) * distance,
    ];
    // Lens shift (not a camera move, so the perspective stays honest): on wide
    // canvases the vehicle sits left of centre to leave a clean callout column.
    const wide = width / ratio > 720;
    const projection = perspective(2 * Math.atan(halfHeight / distance), aspect, 0.5, 40);
    projection[8] = wide ? 0.30 : 0;
    const viewProj = multiply(projection, lookAt(eye, target));

    gl.useProgram(mesh);
    gl.enable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(meshUniform.viewProj, false, viewProj);
    gl.uniform3fv(meshUniform.eye, new Float32Array(eye));
    gl.uniform3fv(meshUniform.accentColor, new Float32Array(ACCENT));
    gl.uniform3fv(meshUniform.clearColor, new Float32Array(CLEAR));
    gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
    const stride = 40;
    for (const [location, size, offset] of [[meshAttr.pos, 3, 0], [meshAttr.normal, 3, 12], [meshAttr.tangent, 3, 24], [meshAttr.kind, 1, 36]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    }

    const projected = [];
    for (const node of model.nodes) {
      const part = SUBSYSTEMS[node.id];
      const range = geometry.ranges.get(node.id);
      if (!part || !range) continue;
      const offset = [part.explode[0] * spread, part.explode[1] * spread, part.explode[2] * spread];
      const tint = tintFor(node.status, model.state);
      const highlight = node.id === view.selectedId ? 1 : node.id === view.hoveredId ? 0.45 : 0;
      gl.uniform3f(meshUniform.offset, offset[0], offset[1], offset[2]);
      gl.uniform1f(meshUniform.accent, tint.accent);
      gl.uniform1f(meshUniform.clearMix, tint.clear);
      gl.uniform1f(meshUniform.highlight, highlight);
      gl.drawArrays(gl.TRIANGLES, range.first, range.count);

      const world = [part.anchor[0] + offset[0], part.anchor[1] + offset[1], part.anchor[2] + offset[2]];
      const clipW = viewProj[3] * world[0] + viewProj[7] * world[1] + viewProj[11] * world[2] + viewProj[15];
      const clipX = viewProj[0] * world[0] + viewProj[4] * world[1] + viewProj[8] * world[2] + viewProj[12];
      const clipY = viewProj[1] * world[0] + viewProj[5] * world[1] + viewProj[9] * world[2] + viewProj[13];
      const w = clipW || 1;
      projected.push({
        node,
        tint,
        highlight,
        sx: (clipX / w * 0.5 + 0.5) * width,
        sy: (0.5 - clipY / w * 0.5) * height,
        radius: Math.max(10 * ratio, (part.extent / (halfHeight * 2)) * height * 1.35),
      });
    }
    for (const location of Object.values(meshAttr)) gl.disableVertexAttribArray(location);

    const hud = [];
    drawHud(hud, projected, model, view);
    pickables = projected;
    gl.disable(gl.DEPTH_TEST);
    drawOverlay(overlayBuffer, new Float32Array(hud), hud.length / 8);
  }

  function drawHud(out, projected, model, view) {
    const { width, height, ratio } = view;
    const screen = makeScreen(out, width, height);
    const byId = new Map(projected.map((item) => [item.node.id, item]));
    const dim = [0.44, 0.51, 0.60, 0.55];

    for (const link of model.links) {
      const from = byId.get(link.from);
      const to = byId.get(link.to);
      if (!from || !to) continue;
      const color = link.active ? [...ACCENT, 0.95] : dim;
      screen.line(from.sx, from.sy, to.sx, to.sy, (link.active ? 2.6 : 1) * ratio, color);
    }

    for (const item of projected) {
      const marker = item.tint.css ? [...item.tint.css, 0.95] : [0.62, 0.70, 0.80, 0.85];
      const size = (item.highlight ? 8 : 5) * ratio;
      screen.rect(item.sx - size / 2, item.sy - size / 2, size, size, marker);
      if (item.highlight === 1) {
        // Corner brackets, clamped so they never spill outside the viewport.
        const margin = 4 * ratio;
        const ring = Math.min(item.radius, item.sx - margin, width - margin - item.sx, item.sy - margin, height - margin - item.sy);
        if (ring > 6 * ratio) {
          for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const cx = item.sx + dx * ring;
            const cy = item.sy + dy * ring;
            screen.line(cx, cy, cx - dx * ring * 0.32, cy, 2 * ratio, [0.95, 0.97, 1, 0.9]);
            screen.line(cx, cy, cx, cy - dy * ring * 0.32, 2 * ratio, [0.95, 0.97, 1, 0.9]);
          }
        }
      }
    }

    // A single right-hand callout column, the way an assembly drawing indexes
    // its parts list. Narrow canvases keep only the subsystems that carry the
    // current decision so the labels never bury the vehicle.
    if (!atlas) return;
    const scale = (ratio * 13) / ROW;
    const compact = width / ratio < 720;
    const entries = [];
    for (const item of projected) {
      const row = atlas.rows.get(item.node.id);
      if (!row) continue;
      if (compact && item.highlight === 0 && item.tint.css === null) continue;
      entries.push({ item, row });
    }
    entries.sort((a, b) => a.item.sy - b.item.sy);
    const chipPad = 7 * ratio;
    const chipH = ROW * scale + chipPad;
    const gap = chipH + 8 * ratio;
    let cursor = 12 * ratio;
    for (const entry of entries) {
      const chipW = entry.row.width * scale + chipPad * 2;
      const y = Math.max(cursor, Math.min(entry.item.sy - chipH / 2, height - chipH - 12 * ratio));
      cursor = y + gap;
      const x = width - chipW - 12 * ratio;
      const accent = entry.item.tint.css;
      const text = accent ? [...accent, 1] : [0.80, 0.86, 0.94, 1];
      screen.line(x, y + chipH / 2, entry.item.sx, entry.item.sy, 1.1 * ratio, accent ? [...accent, 0.65] : [0.45, 0.53, 0.63, 0.45]);
      screen.rect(x, y, chipW, chipH, [0.04, 0.055, 0.075, entry.item.highlight ? 0.95 : 0.80]);
      screen.rect(x, y, 2.5 * ratio, chipH, accent ? [...accent, 1] : [0.35, 0.42, 0.52, 1]);
      screen.rect(x + chipPad, y + chipPad / 2, entry.row.width * scale, ROW * scale, text, entry.row);
      entry.item.chip = { x, y, w: chipW, h: chipH };
    }
  }

  // One draw call for every untextured and textured overlay shape alike: the
  // untextured ones sample an opaque white texel in the atlas.
  function drawOverlay(buffer, upload, count) {
    if (count <= 0) return;
    gl.useProgram(overlay);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (upload) gl.bufferData(gl.ARRAY_BUFFER, upload, gl.DYNAMIC_DRAW);
    for (const [location, size, offset] of [[overlayAttr.pos, 2, 0], [overlayAttr.uv, 2, 8], [overlayAttr.color, 4, 16]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(overlayTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    for (const location of Object.values(overlayAttr)) gl.disableVertexAttribArray(location);
  }

  return {
    kind: "webgl",
    draw,
    // Takes CSS pixels. Callout chips win over the geometry, then the smallest
    // target first so a leaf stays reachable inside the bounding circle of the
    // assembly that contains it.
    hit(x, y) {
      const px = x * pickRatio;
      const py = y * pickRatio;
      const chip = pickables.find(({ chip: c }) => c && px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h);
      if (chip) return chip.node.id;
      const ordered = [...pickables].sort((a, b) => a.radius - b.radius);
      const found = ordered.find((item) => Math.hypot(px - item.sx, py - item.sy) <= item.radius);
      return found?.node.id || null;
    },
    dispose() {
      gl.deleteBuffer(meshBuffer);
      gl.deleteBuffer(overlayBuffer);
      gl.deleteBuffer(backdropBuffer);
      gl.deleteTexture(texture);
      gl.deleteProgram(mesh);
      gl.deleteProgram(overlay);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/* ------------------------------------------- 2d fallback (no webgl available) */

function create2dRenderer(context) {
  let pickables = [];
  return {
    kind: "2d",
    draw(view) {
      const { model, width, height, ratio } = view;
      const w = width / ratio;
      const h = height / ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, w, h);
      context.fillStyle = "#070b11";
      context.fillRect(0, 0, w, h);
      if (!model) { pickables = []; return; }
      context.fillStyle = model.state === "clear" ? CLEAR_CSS : ACCENT_CSS;
      context.font = "700 12px system-ui";
      context.textAlign = "left";
      context.fillText(model.label, 18, 26);
      context.font = "11px system-ui";
      context.fillStyle = "#8293aa";
      context.fillText(`READINESS ${model.summary.ready} / ${model.summary.target}`, 18, 44);
      const scale = Math.min(w / 680, h / 500);
      const spread = 1 + view.explode * 0.55;
      pickables = model.nodes.map((node) => ({
        node,
        sx: w / 2 + (node.x * spread - node.z * 0.38) * scale,
        sy: h / 2 + (node.y * spread + node.z * 0.2) * scale,
        radius: Math.max(13, 18 * scale),
      }));
      const byId = new Map(pickables.map((item) => [item.node.id, item]));
      for (const link of model.links) {
        const from = byId.get(link.from);
        const to = byId.get(link.to);
        if (!from || !to) continue;
        context.beginPath();
        context.moveTo(from.sx, from.sy);
        context.lineTo(to.sx, to.sy);
        context.lineWidth = link.active ? 4 : 1.5;
        context.strokeStyle = link.active ? ACCENT_CSS : "#39465a";
        context.setLineDash(link.active ? [] : [5, 7]);
        context.stroke();
        context.setLineDash([]);
      }
      for (const item of pickables) {
        const { node, radius } = item;
        const fill = node.status === "limiting" ? ACCENT_CSS
          : node.status === "path" ? "#8a5a33"
            : node.status === "clear" ? CLEAR_CSS : "#22303f";
        context.save();
        context.translate(item.sx, item.sy);
        context.beginPath();
        context.moveTo(0, -radius);
        context.lineTo(radius, -radius * 0.45);
        context.lineTo(radius, radius * 0.48);
        context.lineTo(0, radius);
        context.lineTo(-radius, radius * 0.48);
        context.lineTo(-radius, -radius * 0.45);
        context.closePath();
        context.fillStyle = fill;
        context.fill();
        const focused = node.id === view.selectedId || node.id === view.hoveredId;
        context.lineWidth = focused ? 4 : 1.5;
        context.strokeStyle = node.id === view.selectedId ? "#ffffff" : STEEL_CSS;
        context.stroke();
        context.fillStyle = "#e6eefb";
        context.font = "600 11px system-ui";
        context.textAlign = "center";
        context.fillText(node.name.toUpperCase(), 0, radius + 17);
        context.restore();
      }
    },
    // Takes CSS pixels; this renderer already lays out in CSS pixels.
    hit(x, y) {
      const found = [...pickables].reverse().find((item) => Math.hypot(x - item.sx, y - item.sy) <= item.radius + 8);
      return found?.node.id || null;
    },
    dispose() { pickables = []; },
  };
}

/* ------------------------------------------------------------------ controller */

function unavailableController(error, onError) {
  onError(error);
  return {
    update() {}, invalidate() {}, selectNode() { return false; }, focusNext() { return false; },
    setExploded() { return false; }, setExplodeAmount() { return 0; }, dispose() {},
    getState: () => ({ available: false, error, model: null, selectedId: null, reducedMotion: false, pixelRatio: 1, exploded: false }),
  };
}

const EXPLODE_MS = 520;
// Hard ceiling on frames spent in one explode transition. The clock normally
// ends it in ~32 frames; this guarantees termination even if the host clock
// never advances, so there is no way for the renderer to spin forever.
const EXPLODE_MAX_FRAMES = 240;

export function createDigitalThread(canvas, options = {}) {
  const onSelect = options.onSelect || (() => {});
  const onError = options.onError || (() => {});
  if (!canvas || typeof canvas.getContext !== "function") {
    return unavailableController(new Error("A canvas element is required"), onError);
  }

  const environment = options.environment || globalThis;
  const doc = options.document || environment.document;
  const attributes = { alpha: false, antialias: true, depth: true, powerPreference: "low-power", failIfMajorPerformanceCaveat: false };
  let renderer = null;
  let rendererError = null;
  try {
    const gl = canvas.getContext("webgl2", attributes) || canvas.getContext("webgl", attributes);
    if (gl) renderer = createWebglRenderer(gl, doc);
  } catch (error) {
    rendererError = error;
  }
  if (!renderer) {
    const context = canvas.getContext("2d");
    if (!context) {
      const message = rendererError
        ? `WebGL and 2D canvas rendering are unavailable; show the HTML BOM fallback. (${rendererError.message})`
        : "WebGL and 2D canvas rendering are unavailable; show the HTML BOM fallback.";
      return unavailableController(new Error(message), onError);
    }
    renderer = create2dRenderer(context);
  }

  const pixelRatio = Math.min(2, Math.max(1, environment.devicePixelRatio || 1));
  const media = environment.matchMedia?.("(prefers-reduced-motion: reduce)");
  const reducedMotion = Boolean(media?.matches);
  const requestFrame = environment.requestAnimationFrame?.bind(environment) || ((fn) => environment.setTimeout(fn, 16));
  const cancelFrame = environment.cancelAnimationFrame?.bind(environment) || environment.clearTimeout?.bind(environment);
  const now = () => environment.performance?.now?.() ?? Date.now();

  let model = null;
  let selectedId = null;
  let hoveredId = null;
  let frame = null;
  let disposed = false;
  let exploded = false;
  let explode = 0;
  let explodeTarget = 0;
  let explodeFrom = 0;
  let explodeStart = 0;
  let explodeFrames = 0;
  let parallax = [0, 0];

  canvas.tabIndex = canvas.tabIndex < 0 ? 0 : canvas.tabIndex;
  canvas.setAttribute?.("role", "application");
  canvas.setAttribute?.("aria-label", "Interactive vehicle digital thread. Use arrow keys to move between subsystems and Enter to inspect.");

  function invalidate() {
    if (!disposed && frame === null) frame = requestFrame(render);
  }

  function render() {
    frame = null;
    if (disposed) return;
    const target = explodeTarget;
    let running = false;
    if (explode !== target) {
      explodeFrames += 1;
      const t = Math.min(1, Math.max(0, (now() - explodeStart) / EXPLODE_MS));
      const eased = t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
      explode = explodeFrom + (target - explodeFrom) * eased;
      if (t >= 1 || explodeFrames >= EXPLODE_MAX_FRAMES) explode = target;
      else running = true;
    }
    renderer.draw({
      model, selectedId, hoveredId, explode, parallax,
      width: canvas.width, height: canvas.height, ratio: pixelRatio,
    });
    if (running) invalidate();
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect?.() || { width: canvas.clientWidth || 640, height: canvas.clientHeight || 420 };
    const width = Math.max(1, Math.round((bounds.width || 640) * pixelRatio));
    const height = Math.max(1, Math.round((bounds.height || 420) * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    invalidate();
  }

  function selectNode(id) {
    const node = model?.nodes.find((item) => item.id === id);
    if (!node) return false;
    selectedId = id;
    onSelect({ ...node.detail });
    invalidate();
    return true;
  }

  function focusNext(direction = 1) {
    if (!model?.nodes.length) return false;
    const index = Math.max(0, model.nodes.findIndex((node) => node.id === selectedId));
    return selectNode(model.nodes[(index + direction + model.nodes.length) % model.nodes.length].id);
  }

  // Both the boolean toggle and the continuous separation slider funnel through
  // one applier so a partial separation cannot be stranded by a later toggle
  // that happens to match the current boolean state.
  function applyExplode(target, flag) {
    exploded = flag;
    if (target === explodeTarget) return exploded;
    explodeTarget = target;
    if (reducedMotion) {
      explode = target;
    } else {
      explodeFrom = explode;
      explodeStart = now();
      explodeFrames = 0;
    }
    invalidate();
    return exploded;
  }

  function setExploded(next) {
    const value = Boolean(next);
    return applyExplode(value ? 1 : 0, value);
  }

  function setExplodeAmount(value) {
    const amount = Math.min(1, Math.max(0, Number(value) || 0));
    applyExplode(amount, amount > 0.5);
    return amount;
  }

  function point(event) {
    const bounds = canvas.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top, bounds };
  }

  function pointerMove(event) {
    const cursor = point(event);
    const next = renderer.hit(cursor.x, cursor.y);
    let changed = next !== hoveredId;
    if (changed) {
      hoveredId = next;
      if (canvas.style) canvas.style.cursor = next ? "pointer" : "default";
    }
    // Small camera parallax so the vehicle reads as a solid; it is driven by
    // pointer events and coalesced through invalidate(), never a frame loop.
    if (!reducedMotion && cursor.bounds.width && cursor.bounds.height) {
      const yaw = (cursor.x / cursor.bounds.width - 0.5) * 0.30;
      const pitch = -(cursor.y / cursor.bounds.height - 0.5) * 0.12;
      if (Math.abs(yaw - parallax[0]) > 0.002 || Math.abs(pitch - parallax[1]) > 0.002) {
        parallax = [yaw, pitch];
        changed = true;
      }
    }
    if (changed) invalidate();
  }

  function pointerLeave() {
    hoveredId = null;
    parallax = [0, 0];
    invalidate();
  }

  function click(event) {
    const cursor = point(event);
    const id = renderer.hit(cursor.x, cursor.y);
    if (id) selectNode(id);
  }

  function keydown(event) {
    if (["ArrowRight", "ArrowDown"].includes(event.key)) { event.preventDefault(); focusNext(1); }
    else if (["ArrowLeft", "ArrowUp"].includes(event.key)) { event.preventDefault(); focusNext(-1); }
    else if (event.key === "x" || event.key === "X") { event.preventDefault(); setExploded(!exploded); }
    else if ((event.key === "Enter" || event.key === " ") && selectedId) { event.preventDefault(); selectNode(selectedId); }
  }

  function contextLost(event) {
    event.preventDefault?.();
    disposed = true;
    onError(new Error("The WebGL context was lost; show the HTML BOM fallback."));
  }

  const listeners = [
    ["pointermove", pointerMove], ["pointerleave", pointerLeave], ["click", click],
    ["keydown", keydown], ["webglcontextlost", contextLost],
  ];
  for (const [type, listener] of listeners) canvas.addEventListener(type, listener);

  const Observer = environment.ResizeObserver;
  const observer = Observer ? new Observer(resize) : null;
  observer?.observe(canvas);
  resize();

  return {
    update(result, config = {}) {
      model = buildThreadModel(result);
      selectedId = model.constraintPath.at(-1);
      if (config.exploded !== undefined) setExploded(config.exploded);
      invalidate();
    },
    invalidate,
    selectNode,
    focusNext,
    setExploded,
    setExplodeAmount,
    getState: () => ({
      available: true, model, selectedId, hoveredId, reducedMotion, pixelRatio,
      exploded, explodeAmount: explode, renderer: renderer.kind,
    }),
    dispose() {
      disposed = true;
      if (frame !== null && cancelFrame) cancelFrame(frame);
      frame = null;
      observer?.disconnect();
      for (const [type, listener] of listeners) canvas.removeEventListener(type, listener);
      renderer.dispose();
    },
  };
}
