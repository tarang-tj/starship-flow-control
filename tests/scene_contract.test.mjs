import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../web/scene.js", import.meta.url), "utf8").catch(() => "");
const scene = source
  ? await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
  : {};

function scenario(path, ready = 3, target = 4) {
  const parts = {
    VEHICLE: { id: "VEHICLE", name: "Integrated vehicle", category: "Integration" },
    "PROP-MODULE": { id: "PROP-MODULE", name: "Propulsion module", category: "Propulsion" },
    "HEAT-SHIELD": { id: "HEAT-SHIELD", name: "Thermal protection set", category: "Structures" },
    AVIONICS: { id: "AVIONICS", name: "Avionics package", category: "Avionics" },
    ENGINE: { id: "ENGINE", name: "Engine assembly", category: "Propulsion" },
    "TPS-TILE": { id: "TPS-TILE", name: "Thermal protection tile", category: "Structures" },
  };
  return {
    root: { path }, parts,
    summary: { ready, target, gap: target - ready },
    constraints: path.length > 1 ? [{ ...parts[path.at(-1)], shortage: 12, risk: 81, action: "Recover supply" }] : [],
  };
}

test("buildThreadModel maps the limiting thermal path into honest selectable nodes and links", () => {
  assert.equal(typeof scene.buildThreadModel, "function");
  const model = scene.buildThreadModel(scenario(["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]));
  assert.equal(model.state, "thermal");
  assert.equal(model.label, "THERMAL CONSTRAINT");
  assert.deepEqual(model.constraintPath, ["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]);
  assert.equal(model.nodes.find((node) => node.id === "TPS-TILE").status, "limiting");
  assert.ok(model.links.some((link) => link.from === "HEAT-SHIELD" && link.to === "TPS-TILE" && link.active));
  assert.ok(model.nodes.every((node) => node.selectable && node.detail.name));
});

test("buildThreadModel visibly changes from propulsion constraint to plan clear", () => {
  const propulsion = scene.buildThreadModel(scenario(["VEHICLE", "PROP-MODULE", "ENGINE"], 2));
  assert.equal(propulsion.state, "propulsion");
  assert.equal(propulsion.label, "PROPULSION CONSTRAINT");
  assert.equal(propulsion.nodes.find((node) => node.id === "ENGINE").status, "limiting");

  const clear = scene.buildThreadModel(scenario(["VEHICLE"], 4, 4));
  assert.equal(clear.state, "clear");
  assert.equal(clear.label, "PLAN CLEAR");
  assert.equal(clear.nodes.find((node) => node.id === "VEHICLE").status, "clear");
  assert.ok(clear.links.every((link) => !link.active));
});

test("canvas controller exposes integration API, selection callbacks, invalidation, and disposal", () => {
  assert.equal(typeof scene.createDigitalThread, "function");
  const calls = { selected: [], errors: [], requested: 0, cancelled: 0, observed: 0, disconnected: 0 };
  const listeners = new Map();
  const context = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const canvas = {
    width: 0, height: 0, clientWidth: 640, clientHeight: 420, tabIndex: -1,
    style: {},
    getContext: (kind) => kind === "2d" ? context : null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 420 }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    setAttribute() {},
  };
  const environment = {
    devicePixelRatio: 4,
    requestAnimationFrame(fn) { calls.requested += 1; fn(); return calls.requested; },
    cancelAnimationFrame() { calls.cancelled += 1; },
    matchMedia: () => ({ matches: true }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { calls.observed += 1; } disconnect() { calls.disconnected += 1; } },
  };
  const controller = scene.createDigitalThread(canvas, {
    environment,
    onSelect: (detail) => calls.selected.push(detail),
    onError: (error) => calls.errors.push(error),
  });

  assert.deepEqual(
    Object.keys(controller).sort(),
    ["dispose", "focusNext", "getState", "invalidate", "selectNode", "setExploded", "setExplodeAmount", "update"].sort(),
  );
  controller.update(scenario(["VEHICLE", "PROP-MODULE", "ENGINE"], 2));
  controller.selectNode("ENGINE");
  assert.equal(calls.selected.at(-1).id, "ENGINE");
  assert.equal(controller.getState().selectedId, "ENGINE");
  assert.equal(controller.getState().renderer, "2d", "the granted context must be reported, not assumed");
  assert.equal(controller.getState().reducedMotion, true);
  assert.equal(controller.getState().pixelRatio, 2);
  assert.equal(canvas.style.width, undefined, "renderer must not freeze the responsive CSS width inline");
  assert.equal(canvas.style.height, undefined, "renderer must not freeze the responsive CSS height inline");
  assert.ok(calls.requested > 0);
  assert.equal(calls.observed, 1);
  controller.dispose();
  assert.equal(calls.disconnected, 1);
  assert.equal(listeners.size, 0);
  assert.deepEqual(calls.errors, []);
});

test("missing 2D canvas reports a fallback error without throwing", () => {
  const errors = [];
  const canvas = { getContext: () => null };
  const controller = scene.createDigitalThread(canvas, { onError: (error) => errors.push(error) });
  assert.match(errors[0].message, /2D canvas/i);
  assert.equal(controller.getState().available, false);
  assert.doesNotThrow(() => controller.update(scenario(["VEHICLE"])));
});

test("renderer is import-free and uses on-demand animation rather than a permanent frame loop", () => {
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.match(source, /ResizeObserver/);
  assert.match(source, /prefers-reduced-motion/);
  assert.doesNotMatch(source, /function\s+animate|requestAnimationFrame\s*\(\s*animate/);
});

test("the renderer asks for real webgl with hand-written shaders and an explicit fallback chain", () => {
  assert.match(source, /getContext\("webgl2"[\s\S]{0,120}getContext\("webgl"/, "must try webgl2 then webgl");
  assert.match(source, /getContext\("2d"\)/, "must keep the 2d canvas fallback below webgl");
  assert.match(source, /gl_Position\s*=/, "shaders must be hand-written GLSL, not a library");
  assert.match(source, /gl_FragColor\s*=/);
  assert.match(source, /COMPILE_STATUS/, "shader compilation must be checked");
  assert.match(source, /LINK_STATUS/, "program linking must be checked");
  assert.doesNotMatch(source, /https?:\/\/(?!127\.0\.0\.1)[^\s"')]*\.(?:js|glb|gltf|obj)/, "no CDN or external model files");
  // Geometry is generated, not loaded: no fetch/XHR anywhere in the renderer.
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest/);
});

// Stub WebGL context. Real rasterisation cannot be checked headlessly (the boot
// probe reads pixels back from Chromium for that), but everything around it —
// program construction, the compile/link status checks, the per-subsystem draw
// calls, and teardown — is ordinary JavaScript and is exercised here.
function stubGl({ compiles = true, links = true } = {}) {
  const calls = { programs: 0, shaders: 0, drawArrays: 0, vertices: 0, deletes: 0 };
  const base = {
    createShader: () => { calls.shaders += 1; return { shader: calls.shaders }; },
    createProgram: () => { calls.programs += 1; return { program: calls.programs }; },
    createBuffer: () => ({ buffer: true }),
    createTexture: () => ({ texture: true }),
    getShaderParameter: () => compiles,
    getProgramParameter: () => links,
    getShaderInfoLog: () => "stub shader diagnostic",
    getProgramInfoLog: () => "stub program diagnostic",
    getAttribLocation: (_program, name) => name.length,
    getUniformLocation: (_program, name) => ({ name }),
    getExtension: () => null,
    drawArrays: (_mode, _first, count) => { calls.drawArrays += 1; calls.vertices += count; },
    deleteBuffer: () => { calls.deletes += 1; },
    deleteTexture: () => { calls.deletes += 1; },
    deleteProgram: () => { calls.deletes += 1; },
  };
  let constant = 0x1000;
  // Anything not spelled out above is a GL constant (SCREAMING_SNAKE) or a
  // command whose return value the renderer never reads.
  const gl = new Proxy(base, {
    get(target, key) {
      if (key in target || typeof key !== "string") return target[key];
      constant += 1;
      target[key] = /^[A-Z][A-Z0-9_]*$/.test(key) ? constant : () => {};
      return target[key];
    },
  });
  return { gl, calls };
}

// Minimal document for the label atlas: a canvas whose 2d context measures text.
function stubDocument() {
  const context = new Proxy(
    { measureText: (text) => ({ width: text.length * 11 }) },
    { get: (target, key) => (key in target ? target[key] : (target[key] = () => {})) },
  );
  return { createElement: () => ({ width: 0, height: 0, getContext: (kind) => (kind === "2d" ? context : null) }) };
}

// Harness for the controller with a fully injectable clock and frame scheduler.
function harness({ reducedMotion = false, contexts = ["2d"], gl = null, doc = null, onLayoutChange } = {}) {
  const calls = { selected: [], errors: [], layouts: [], frames: 0, cancelled: 0, disconnected: 0 };
  const listeners = new Map();
  const context = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const canvas = {
    width: 0, height: 0, clientWidth: 800, clientHeight: 500, tabIndex: -1, style: {},
    getContext: (kind) => (contexts.includes(kind) ? (kind === "2d" ? context : gl) : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    setAttribute() {},
  };
  let clock = 0;
  let tick = 16;
  const queue = [];
  const environment = {
    devicePixelRatio: 3,
    document: doc,
    performance: { now: () => clock },
    requestAnimationFrame(fn) { calls.frames += 1; queue.push(fn); return calls.frames; },
    cancelAnimationFrame() { calls.cancelled += 1; },
    matchMedia: () => ({ matches: reducedMotion }),
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() { calls.disconnected += 1; } },
  };
  const controller = scene.createDigitalThread(canvas, {
    environment,
    onSelect: (detail) => calls.selected.push(detail),
    onError: (error) => calls.errors.push(error),
    onLayoutChange: (layout) => { calls.layouts.push(layout); if (onLayoutChange) onLayoutChange(layout); },
  });
  // Drain the queue the way a browser would: advance the clock one frame at a time.
  const pump = (limit = 400) => {
    let ran = 0;
    while (queue.length && ran < limit) {
      clock += tick;
      queue.shift()();
      ran += 1;
    }
    return ran;
  };
  const freezeClock = () => { tick = 0; };
  return { calls, canvas, listeners, controller, pump, queue, freezeClock };
}

test("a granted webgl context builds the real webgl renderer and draws every subsystem", () => {
  const stub = stubGl();
  const rig = harness({ contexts: ["webgl2", "2d"], gl: stub.gl, doc: stubDocument() });
  assert.equal(rig.controller.getState().renderer, "webgl", "a granted webgl2 context must not silently fall back");
  assert.ok(stub.calls.programs >= 2, "the mesh and overlay programs must both be built");
  assert.ok(stub.calls.shaders >= 4, "both programs need a vertex and a fragment shader");

  rig.controller.update(scenario(["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]));
  rig.pump();
  assert.ok(
    stub.calls.drawArrays >= 10,
    `expected the 8 subsystems plus backdrop and hud draws, got ${stub.calls.drawArrays}`,
  );
  assert.ok(stub.calls.vertices > 1000, `expected real geometry, got ${stub.calls.vertices} vertices`);

  const drawn = stub.calls.drawArrays;
  rig.controller.setExploded(true);
  rig.pump();
  assert.ok(stub.calls.drawArrays > drawn, "separating the stack must redraw it");

  rig.controller.dispose();
  assert.ok(stub.calls.deletes >= 6, "buffers, texture, and programs must all be released");
  assert.deepEqual(rig.calls.errors, []);
});

test("a webgl context whose shaders will not compile falls back to the 2d renderer", () => {
  const stub = stubGl({ compiles: false });
  const rig = harness({ contexts: ["webgl2", "webgl", "2d"], gl: stub.gl, doc: stubDocument() });
  assert.equal(rig.controller.getState().renderer, "2d", "an unusable webgl context must fall through to 2d");
  rig.controller.update(scenario(["VEHICLE", "PROP-MODULE", "ENGINE"], 2));
  rig.pump();
  assert.equal(stub.calls.drawArrays, 0, "nothing may be drawn through a broken webgl program");
  assert.deepEqual(rig.calls.errors, [], "a working 2d fallback is not an error condition");
});

test("a webgl program that will not link and no 2d canvas surfaces the underlying failure", () => {
  const stub = stubGl({ links: false });
  const rig = harness({ contexts: ["webgl"], gl: stub.gl, doc: stubDocument() });
  assert.equal(rig.controller.getState().available, false);
  assert.equal(rig.controller.getState().renderer, null);
  assert.match(rig.calls.errors[0].message, /2D canvas rendering are unavailable/);
  assert.match(rig.calls.errors[0].message, /program link failed: stub program diagnostic/);
});

test("layout changes are announced from every source that can move the renderer", () => {
  const rig = harness({ reducedMotion: true });
  rig.controller.update(scenario(["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]));
  rig.pump();
  assert.deepEqual(
    rig.calls.layouts.at(-1), { exploded: false, explodeAmount: 0, selectedId: "TPS-TILE" },
    "a new scenario must announce the selection it forced",
  );

  rig.controller.setExploded(true);
  assert.deepEqual(rig.calls.layouts.at(-1), { exploded: true, explodeAmount: 1, selectedId: "TPS-TILE" });
  rig.controller.setExplodeAmount(0.4);
  assert.deepEqual(rig.calls.layouts.at(-1), { exploded: false, explodeAmount: 0.4, selectedId: "TPS-TILE" });

  const settled = rig.calls.layouts.length;
  rig.controller.setExplodeAmount(0.4);
  assert.equal(rig.calls.layouts.length, settled, "an unchanged layout must not be announced again");

  rig.listeners.get("keydown")({ key: "x", preventDefault() {} });
  assert.deepEqual(rig.calls.layouts.at(-1), { exploded: true, explodeAmount: 1, selectedId: "TPS-TILE" }, "the keyboard toggle must announce");

  rig.listeners.get("keydown")({ key: "ArrowRight", preventDefault() {} });
  assert.notEqual(rig.calls.layouts.at(-1).selectedId, "TPS-TILE", "arrow focus must announce the subsystem it moved to");
  rig.controller.selectNode("ENGINE");
  assert.equal(rig.calls.layouts.at(-1).selectedId, "ENGINE");

  // Pointer pick, driven at the projected position the 2d renderer just used.
  rig.pump();
  const state = rig.controller.getState();
  const spread = 1 + state.explodeAmount * 0.55;
  const vehicle = state.model.nodes.find((node) => node.id === "VEHICLE");
  const scale = Math.min(800 / 680, 500 / 500);
  rig.listeners.get("click")({
    clientX: 400 + (vehicle.x * spread - vehicle.z * 0.38) * scale,
    clientY: 250 + (vehicle.y * spread + vehicle.z * 0.2) * scale,
  });
  assert.equal(rig.calls.layouts.at(-1).selectedId, "VEHICLE", "picking a subsystem must announce the selection");

  rig.controller.update(scenario(["VEHICLE", "PROP-MODULE", "ENGINE"], 2));
  assert.equal(rig.calls.layouts.at(-1).selectedId, "ENGINE", "a scenario reset must announce the selection it took");
  assert.deepEqual(rig.calls.errors, []);
  rig.controller.dispose();
});

test("a subscriber that throws is reported and never stalls the renderer", () => {
  const rig = harness({
    reducedMotion: true,
    onLayoutChange: () => { throw new Error("subscriber exploded"); },
  });
  rig.controller.update(scenario(["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]));
  rig.pump();
  assert.equal(rig.controller.setExploded(true), true, "the renderer must keep working through a broken listener");
  assert.equal(rig.controller.getState().explodeAmount, 1);
  assert.ok(rig.calls.errors.length > 0, "a broken listener must be reported, not swallowed");
  assert.match(rig.calls.errors.at(-1).message, /subscriber exploded/);
  rig.controller.dispose();
});

test("the exploded-view transition animates to completion and then stops requesting frames", () => {
  const rig = harness();
  rig.controller.update(scenario(["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]));
  rig.pump();
  assert.equal(rig.controller.getState().exploded, false);
  assert.equal(rig.controller.getState().explodeAmount, 0);

  assert.equal(rig.controller.setExploded(true), true);
  const frames = rig.pump();
  assert.ok(frames > 4, `expected a real transition, got ${frames} frames`);
  assert.ok(frames < 120, `transition must terminate promptly, took ${frames} frames`);
  assert.equal(rig.queue.length, 0, "settled renderer must not leave a frame pending");
  assert.equal(rig.controller.getState().explodeAmount, 1);

  // Idle: nothing further may be scheduled once the transition has settled.
  const before = rig.calls.frames;
  rig.pump();
  assert.equal(rig.calls.frames, before, "a settled renderer must not schedule more frames");

  rig.controller.setExploded(false);
  rig.pump();
  assert.equal(rig.controller.getState().explodeAmount, 0);
  assert.equal(rig.controller.getState().exploded, false);
});

test("the exploded transition still terminates when the host clock never advances", () => {
  // A stalled clock keeps the eased value pinned below the target forever, so
  // only the frame ceiling can stop the renderer re-scheduling itself.
  const rig = harness();
  rig.controller.update(scenario(["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]));
  rig.pump();
  rig.freezeClock();
  rig.controller.setExploded(true);
  const frames = rig.pump(2000);
  assert.ok(frames < 1500, `frozen clock must not spin forever, ran ${frames} frames`);
  assert.equal(rig.queue.length, 0, "renderer must stop scheduling frames");
  assert.equal(rig.controller.getState().explodeAmount, 1, "must land on the exploded layout anyway");
});

test("reduced motion snaps the exploded view instead of animating it", () => {
  const rig = harness({ reducedMotion: true });
  rig.controller.update(scenario(["VEHICLE", "PROP-MODULE", "ENGINE"], 2));
  rig.pump();
  const before = rig.calls.frames;
  rig.controller.setExploded(true);
  assert.equal(rig.controller.getState().explodeAmount, 1, "must jump straight to the exploded layout");
  const frames = rig.pump();
  assert.ok(frames <= 1, `reduced motion must not animate, ran ${frames} frames`);
  assert.equal(rig.calls.frames - before, 1, "one repaint only");
  assert.equal(rig.controller.getState().reducedMotion, true);
});

test("update accepts an exploded option and disposal tears down every listener", () => {
  const rig = harness();
  rig.controller.update(scenario(["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]), { exploded: true });
  rig.pump();
  assert.equal(rig.controller.getState().exploded, true);
  assert.equal(rig.controller.getState().pixelRatio, 2, "devicePixelRatio must stay capped at 2");
  assert.equal(rig.canvas.style.width, undefined);
  assert.equal(rig.canvas.style.height, undefined);
  assert.ok(rig.listeners.size >= 4);
  rig.controller.dispose();
  assert.equal(rig.listeners.size, 0, "every listener must be removed");
  assert.equal(rig.calls.disconnected, 1, "the resize observer must be disconnected");
  assert.deepEqual(rig.calls.errors, []);
});

test("continuous separation holds partial states and is never stranded by a later toggle", () => {
  const rig = harness({ reducedMotion: true });
  rig.controller.update(scenario(["VEHICLE", "HEAT-SHIELD", "TPS-TILE"]));
  rig.pump();

  assert.equal(rig.controller.setExplodeAmount(0.4), 0.4);
  assert.equal(rig.controller.getState().explodeAmount, 0.4, "the slider must reach partial separation, not snap");
  assert.equal(rig.controller.getState().exploded, false, "below the midpoint still reads as integrated");

  // The regression this guards: a partial separation leaves `exploded` false, so
  // a boolean toggle back to false used to early-return on the unchanged flag and
  // strand the vehicle half apart.
  rig.controller.setExploded(false);
  assert.equal(rig.controller.getState().explodeAmount, 0, "toggling integrated must fully reseat a partial separation");

  assert.equal(rig.controller.setExplodeAmount(2), 1, "out-of-range input must clamp");
  assert.equal(rig.controller.getState().explodeAmount, 1);
  assert.equal(rig.controller.getState().exploded, true, "above the midpoint reads as exploded");

  assert.equal(rig.controller.setExplodeAmount("nonsense"), 0, "non-numeric input must fall back to integrated");
  assert.deepEqual(rig.calls.errors, []);
  rig.controller.dispose();
});
