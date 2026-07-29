// Integration seam between the scene renderer (scene.js, ES module) and the
// cockpit controller (app.js, classic script). Kept in its own file so the
// renderer and the markup can evolve without editing each other.
//
// The seam deliberately owns no vehicle state of its own. Everything it reports
// is read back out of the renderer's controller, so a control that never
// reaches the renderer cannot be made to look like it did.
import { createDigitalThread } from "./scene.js";

const canvas = document.getElementById("sceneCanvas");
const status = document.getElementById("sceneStatus");
const fallback = document.getElementById("sceneFallback");

let controller;
const subscribers = new Set();

// Layout as the RENDERER holds it. `explodeAmount` is the requested separation
// (0..1); `explodeTarget` mirrors it, and `getVehicleState().explodeAmount`
// reports where the eased transition currently sits.
const IDLE = { exploded: false, explodeAmount: 0, explodeTarget: 0, selectedId: null, renderer: null, available: false };

function readState() {
  const state = controller?.getState?.();
  if (!state) return { ...IDLE };
  return {
    exploded: Boolean(state.exploded),
    explodeAmount: typeof state.explodeAmount === "number" ? state.explodeAmount : 0,
    explodeTarget: typeof state.explodeTarget === "number" ? state.explodeTarget : 0,
    selectedId: state.selectedId ?? null,
    renderer: state.renderer ?? null,
    available: Boolean(state.available),
  };
}

function deliver(subscriber, layout) {
  try {
    subscriber({ ...layout });
  } catch (error) {
    // A broken listener must not take the renderer or its siblings down with it.
    console.warn("FlowScene.onVehicleChange listener failed.", error);
  }
}

function broadcast(layout) {
  for (const subscriber of [...subscribers]) deliver(subscriber, layout);
}

const ensure = (onSelect) => {
  if (!controller) {
    controller = createDigitalThread(canvas, {
      onSelect,
      onLayoutChange: broadcast,
      onError: (error) => {
        status.textContent = "CANVAS FALLBACK";
        fallback.hidden = false;
        console.error(error);
      },
    });
  }
  return controller;
};

window.FlowScene = {
  setScenario({ result, onSelect }) {
    const scene = ensure(onSelect);
    scene.update(result);
    status.textContent = result.summary.gap ? "CONSTRAINT ACTIVE" : "PLAN CLEAR";
  },
  update({ result, onSelect }) {
    const scene = ensure(onSelect);
    scene.update(result);
  },
  getSelectedNode() {
    const state = controller?.getState?.();
    return state?.model?.nodes?.find((node) => node.id === state.selectedId)?.detail;
  },
  // Ground truth for anything that needs to know what the vehicle is doing:
  // read straight out of the controller, never cached at this layer.
  getVehicleState() {
    return readState();
  },
  // Registers a listener for renderer-side layout changes from ANY source
  // (methods, keyboard, pointer picking, scenario reset). The current state is
  // replayed immediately so a late subscriber can never start out stale.
  onVehicleChange(callback) {
    if (typeof callback !== "function") return () => {};
    subscribers.add(callback);
    const state = readState();
    deliver(callback, { exploded: state.exploded, explodeAmount: state.explodeTarget, selectedId: state.selectedId });
    return () => subscribers.delete(callback);
  },
  // Vehicle-view pass-throughs. The shell owns the controls, the renderer owns
  // the geometry, and neither may reach past this seam. Every call is a no-op
  // until a scenario has run and built the controller.
  setLayout({ mode, amount } = {}) {
    if (!controller) return false;
    if (typeof amount === "number") return controller.setExplodeAmount(amount) > 0.5;
    return controller.setExploded(mode === "exploded");
  },
  setExplode(amount) {
    return controller ? controller.setExplodeAmount(amount) : 0;
  },
  selectNode(partId) {
    return controller ? controller.selectNode(partId) : undefined;
  },
};

window.dispatchEvent(new Event("flowscene-ready"));
