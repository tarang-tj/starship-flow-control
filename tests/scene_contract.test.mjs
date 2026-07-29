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
    ["dispose", "focusNext", "getState", "invalidate", "selectNode", "setExploded", "update"].sort(),
  );
  controller.update(scenario(["VEHICLE", "PROP-MODULE", "ENGINE"], 2));
  controller.selectNode("ENGINE");
  assert.equal(calls.selected.at(-1).id, "ENGINE");
  assert.equal(controller.getState().selectedId, "ENGINE");
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

// Harness for the controller with a fully injectable clock and frame scheduler.
function harness({ reducedMotion = false, contexts = ["2d"] } = {}) {
  const calls = { selected: [], errors: [], frames: 0, cancelled: 0, disconnected: 0 };
  const listeners = new Map();
  const context = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
  const canvas = {
    width: 0, height: 0, clientWidth: 800, clientHeight: 500, tabIndex: -1, style: {},
    getContext: (kind) => (contexts.includes(kind) ? context : null),
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
