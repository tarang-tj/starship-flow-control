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

  assert.deepEqual(Object.keys(controller).sort(), ["dispose", "focusNext", "getState", "invalidate", "selectNode", "update"].sort());
  controller.update(scenario(["VEHICLE", "PROP-MODULE", "ENGINE"], 2));
  controller.selectNode("ENGINE");
  assert.equal(calls.selected.at(-1).id, "ENGINE");
  assert.equal(controller.getState().selectedId, "ENGINE");
  assert.equal(controller.getState().reducedMotion, true);
  assert.equal(controller.getState().pixelRatio, 2);
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
