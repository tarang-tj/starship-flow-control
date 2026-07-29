// Vehicle-view shell controls: integrated/exploded subsystem layout and
// subsystem focus. The 3D renderer is optional by design. Every call into
// window.FlowScene is feature-detected and try/caught, so a renderer that is
// missing, still loading, or broken degrades to the text readout below the
// canvas instead of throwing into the console.
//
// Renderer API this file consumes, in preference order:
//   window.FlowScene.setLayout({ mode: "integrated" | "exploded", amount: 0..1 })
//   window.FlowScene.setExplode(amount)          // fallback, amount 0..1
//   window.FlowScene.selectNode(partId)          // subsystem focus
// Markup hooks: [data-scene-layout], [data-scene-explode], [data-scene-node].

const EXPLODED_PERCENT = 65;

const SUBSYSTEMS = {
  "VEHICLE": "Integrated stack — three level-1 assemblies roll up to one vehicle. Select a subsystem to focus its branch of the thread.",
  "PROP-MODULE": "Propulsion module — consumes 6 engine assemblies and 18 cryogenic methane valves per vehicle. This is the branch that moves when the engine-stock input is stressed.",
  "HEAT-SHIELD": "Thermal protection set — consumes 4,200 protection tiles per vehicle. In the baseline scenario its inbound tile order lands outside the 21-day horizon, which is what holds readiness at 3.",
  "AVIONICS": "Avionics package — consumes 2 flight computers per vehicle. Covered in every shipped scenario; it is in the model to show a branch that is not the constraint."
};

const byId = (id) => document.getElementById(id);
const all = (selector) => Array.prototype.slice.call(document.querySelectorAll(selector));

const slider = byId("explodeAmount");
const readout = byId("explodeOut");
const detail = byId("subsystemDetail");
const layoutButtons = all("[data-scene-layout]");
const nodeButtons = all("[data-scene-node]");

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

function currentPercent() {
  const value = slider ? Number(slider.value) : 0;
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

function applyLayout(percent, moveSlider) {
  const clamped = Math.min(100, Math.max(0, percent));
  const mode = clamped > 0 ? "exploded" : "integrated";
  if (moveSlider && slider) slider.value = String(clamped);
  if (readout) readout.textContent = `${clamped}%`;
  pressOnly(layoutButtons, "sceneLayout", mode);
  if (callScene("setLayout", { mode, amount: clamped / 100 }) === "missing") {
    callScene("setExplode", clamped / 100);
  }
}

function focusSubsystem(id) {
  pressOnly(nodeButtons, "sceneNode", id);
  if (detail) detail.textContent = SUBSYSTEMS[id] || "Synthetic subsystem.";
  callScene("selectNode", id);
}

layoutButtons.forEach((button) => {
  button.addEventListener("click", () => {
    applyLayout(button.dataset.sceneLayout === "exploded" ? EXPLODED_PERCENT : 0, true);
  });
});

if (slider) slider.addEventListener("input", () => applyLayout(currentPercent(), false));

nodeButtons.forEach((button) => {
  button.addEventListener("click", () => focusSubsystem(button.dataset.sceneNode));
});

// Re-push layout once the renderer announces itself, so the scene matches the
// control state no matter which script finished booting first.
window.addEventListener("flowscene-ready", () => applyLayout(currentPercent(), false));

applyLayout(currentPercent(), false);
