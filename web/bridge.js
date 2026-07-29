// Integration seam between the scene renderer (scene.js, ES module) and the
// cockpit controller (app.js, classic script). Kept in its own file so the
// renderer and the markup can evolve without editing each other.
import { createDigitalThread } from "./scene.js";

const canvas = document.getElementById("sceneCanvas");
const status = document.getElementById("sceneStatus");
const fallback = document.getElementById("sceneFallback");

let controller;

const ensure = (onSelect) => {
  if (!controller) {
    controller = createDigitalThread(canvas, {
      onSelect,
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
