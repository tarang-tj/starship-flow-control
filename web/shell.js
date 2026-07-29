// Vehicle-view shell controls: integrated/exploded subsystem layout and
// subsystem focus.
//
// The renderer is the single source of truth. These controls never assume their
// own click succeeded and never hold state of their own while the renderer is
// live: they push an intent through the bridge, and they repaint only from
// window.FlowScene.onVehicleChange. That subscription also fires for state the
// shell never asked for — the canvas `x` key, the arrow keys, pointer picking,
// and the selection reset the renderer performs on every scenario update — so a
// button can no longer report a state the vehicle is not in.
//
// The 3D renderer is still optional by design. Every call into window.FlowScene
// is feature-detected and try/caught; with no renderer the controls fall back to
// mirroring their own intent, which is the honest best available answer.
//
// Renderer API this file consumes:
//   window.FlowScene.onVehicleChange(fn)         // { exploded, explodeAmount, selectedId }, replayed on subscribe
//   window.FlowScene.setLayout({ mode, amount }) // mode "integrated" | "exploded", amount 0..1
//   window.FlowScene.setExplode(amount)          // fallback, amount 0..1
//   window.FlowScene.selectNode(partId)          // subsystem focus
// Markup hooks: [data-scene-layout], [data-scene-explode], [data-scene-node].
//
// Everything below is wrapped in an IIFE. shell.js and app.js are both classic
// scripts and therefore share one global scope: a bare `function render()` here
// silently replaces app.js's `render()` and turns every scenario update into a
// no-op with no error anywhere. The wrapper makes that impossible.

(function vehicleShell() {
"use strict";

const EXPLODED_PERCENT = 65;

// Quantities are the synthetic bill of materials in data/baseline.json.
const PARTS = {
  "VEHICLE": "Integrated stack — three level-1 assemblies roll up to one vehicle. Select a subsystem to focus its branch of the thread.",
  "PROP-MODULE": "Propulsion module — consumes 6 engine assemblies and 18 cryogenic methane valves per vehicle. This is the branch that moves when the engine-stock input is stressed.",
  "HEAT-SHIELD": "Thermal protection set — consumes 4,200 protection tiles per vehicle. In the baseline scenario its inbound tile order lands outside the 21-day horizon, which is what holds readiness at 3.",
  "AVIONICS": "Avionics package — consumes 2 flight computers per vehicle. Covered in every shipped scenario; it is in the model to show a branch that is not the constraint.",
  "ENGINE": "Engine assembly — a leaf component, 6 per propulsion module.",
  "METHANE-VALVE": "Cryogenic methane valve — a leaf component, 18 per propulsion module.",
  "TPS-TILE": "Thermal protection tile — a leaf component, 4,200 per thermal protection set.",
  "FLIGHT-COMP": "Flight computer — a leaf component, 2 per avionics package."
};

const byId = (id) => document.getElementById(id);
const all = (selector) => Array.prototype.slice.call(document.querySelectorAll(selector));

const slider = byId("explodeAmount");
const readout = byId("explodeOut");
const detail = byId("subsystemDetail");
const layoutButtons = all("[data-scene-layout]");
const nodeButtons = all("[data-scene-node]");
const pickerIds = new Set(nodeButtons.map((button) => button.dataset.sceneNode));

// Last state painted into the controls. While a subscription is live this only
// ever mirrors the renderer; without one it mirrors the shell's own intent.
let shown = { exploded: false, explodeAmount: 0, selectedId: null };
let subscribed = false;

// Returns "missing" (no such renderer method), "failed" (it threw), or "ok".
// Only "missing" should trigger a fallback method — a method that threw has
// already had its chance and must not be retried through another entry point.
function callScene(method, argument) {
  const scene = window.FlowScene;
  if (!scene || typeof scene[method] !== "function") return "missing";
  try {
    scene[method](argument);
    return "ok";
  } catch (error) {
    // Warn, never error: a renderer fault must not break the cockpit.
    console.warn(`FlowScene.${method} failed; vehicle view stays in text mode.`, error);
    return "failed";
  }
}

function pressOnly(buttons, attribute, value) {
  buttons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === value));
  });
}

function clampPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 0;
}

// A leaf component is a legitimate renderer selection but has no picker button.
// In that case no button is pressed and this text says why, rather than leaving
// a stale subsystem description standing next to an unrelated selection.
function describe(id) {
  if (!id) return "No component is selected in the renderer yet.";
  const copy = PARTS[id];
  if (!copy) return `Renderer focus: ${id}. Its full detail is in the operator readout.`;
  if (pickerIds.has(id)) return copy;
  return `${copy} It sits below the subsystem level, so no subsystem button is highlighted.`;
}

// The only function allowed to write control state. Everything it paints comes
// from the state object it is handed; it never reads the DOM back.
function render(state) {
  shown = {
    exploded: Boolean(state.exploded),
    explodeAmount: Number.isFinite(Number(state.explodeAmount)) ? Number(state.explodeAmount) : 0,
    selectedId: state.selectedId || null
  };
  const percent = clampPercent(shown.explodeAmount * 100);
  if (slider && slider.value !== String(percent)) slider.value = String(percent);
  if (readout) readout.textContent = `${percent}%`;
  pressOnly(layoutButtons, "sceneLayout", shown.exploded ? "exploded" : "integrated");
  pressOnly(nodeButtons, "sceneNode", shown.selectedId);
  // role="status": only write on a real change, or every separation tick would
  // re-announce the same subsystem description.
  const copy = describe(shown.selectedId);
  if (detail && detail.textContent !== copy) detail.textContent = copy;
}

function requestLayout(percent) {
  const clamped = clampPercent(percent);
  const mode = clamped > 0 ? "exploded" : "integrated";
  if (callScene("setLayout", { mode, amount: clamped / 100 }) === "missing") {
    callScene("setExplode", clamped / 100);
  }
  // With a live subscription the renderer's echo repaints the controls. Without
  // one, mirror the intent so the text-mode fallback still responds.
  if (!subscribed) render({ ...shown, exploded: clamped > 0, explodeAmount: clamped / 100 });
}

function requestFocus(id) {
  callScene("selectNode", id);
  if (!subscribed) render({ ...shown, selectedId: id });
}

// Idempotent: bridge.js is a module and therefore runs after this classic
// script, so the first attempt normally misses and the flowscene-ready listener
// lands it. onVehicleChange replays current state on subscribe, so there is no
// window in which the controls are stale.
function subscribe() {
  if (subscribed) return;
  const scene = window.FlowScene;
  if (!scene || typeof scene.onVehicleChange !== "function") return;
  try {
    scene.onVehicleChange(render);
    subscribed = true;
  } catch (error) {
    console.warn("FlowScene.onVehicleChange failed; vehicle controls mirror intent only.", error);
  }
}

layoutButtons.forEach((button) => {
  button.addEventListener("click", () => {
    requestLayout(button.dataset.sceneLayout === "exploded" ? EXPLODED_PERCENT : 0);
  });
});

if (slider) slider.addEventListener("input", () => requestLayout(slider.value));

nodeButtons.forEach((button) => {
  button.addEventListener("click", () => requestFocus(button.dataset.sceneNode));
});

window.addEventListener("flowscene-ready", () => {
  subscribe();
  // Legacy renderers with no change feed still need the control state pushed at
  // them once they announce themselves.
  if (!subscribed) requestLayout(slider ? slider.value : 0);
});

subscribe();
if (!subscribed) render(shown);
}());
