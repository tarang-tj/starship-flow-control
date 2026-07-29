import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const baselineData = JSON.parse(await readFile(new URL("../data/baseline.json", import.meta.url), "utf8"));

const requiredIds = [
  "main", "horizonLabel", "tileArrival", "engineStock", "runBtn", "resetBtn",
  "readyBuilds", "targetBuilds", "buildGap", "constraintCount", "riskValue",
  "constraintList", "criticalPath", "ordersBody", "methodDialog"
];
const boundIds = requiredIds.filter((id) => id !== "main");

test("the operating view preserves every required interaction contract", () => {
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const id of boundIds) {
    assert.match(app, new RegExp(`\\$\\(['\"]${id}['\"]\\)`), `app does not bind #${id}`);
  }
});

test("the public interface states synthetic data and non-affiliation", () => {
  assert.match(html, /synthetic/i);
  assert.match(html, /Not affiliated with or endorsed by SpaceX/i);
});

test("the app fails visibly when scenario loading fails", () => {
  assert.match(app, /MODEL LOAD FAILED/);
  assert.match(app, /console\.error/);
});

test("scenario presets are explicit, immutable decision inputs", () => {
  assert.match(app, /Object\.freeze\(\{\s*baseline:\s*Object\.freeze\(\{\s*day:\s*34,\s*engines:\s*25\s*\}\)/s);
  assert.match(app, /recover:\s*Object\.freeze\(\{\s*day:\s*9,\s*engines:\s*25\s*\}\)/s);
  assert.match(app, /switch:\s*Object\.freeze\(\{\s*day:\s*9,\s*engines:\s*22\s*\}\)/s);
  assert.match(app, /structuredClone\(baseline\)/);
});

test("slider previews are frame-throttled and announce a decision narrative", () => {
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /cancelAnimationFrame/);
  assert.match(app, /before.*after|beforeAfter/is);
  assert.match(app, /recommend/i);
  assert.match(app, /aria-live/);
});

test("optional 3D scene and future narrative elements cannot break the core view", () => {
  assert.match(app, /window\.FlowScene/);
  assert.match(app, /\?\.(?:render|update|setScenario)/);
  assert.match(app, /selectedNodeDetail/);
  assert.match(app, /statusAnnouncement/);
  assert.match(app, /if\s*\(.*\).*textContent/s);
});

test("dynamic fixture rendering uses DOM text APIs instead of HTML interpolation", () => {
  assert.doesNotMatch(app, /\.innerHTML\s*=\s*r\.(?:constraints|orders|root)/);
  assert.match(app, /createElement/);
  assert.match(app, /textContent/);
});

test("the mission cockpit exposes the 3D thread, presets, decision delta, and accessible fallback", () => {
  for (const id of ["sceneCanvas", "sceneStatus", "sceneFallback", "selectedNodeDetail", "beforeAfter", "recommendation", "statusAnnouncement"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const preset of ["baseline", "recover", "switch"]) {
    assert.match(html, new RegExp(`data-preset=["']${preset}["']`), `missing ${preset} preset`);
  }
  assert.match(html, /bridge\.js/);
  assert.match(html, /type=["']module["']/);
});

test("the bridge is the module seam that wires the scene renderer to the cockpit", async () => {
  const bridge = await readFile(new URL("../web/bridge.js", import.meta.url), "utf8");
  assert.match(bridge, /import\s*\{[^}]*createDigitalThread[^}]*\}\s*from\s*["']\.\/scene\.js["']/);
  assert.match(bridge, /window\.FlowScene\s*=/);
  for (const method of ["setScenario", "update", "getSelectedNode"]) {
    assert.match(bridge, new RegExp(`${method}\\s*\\(`), `bridge must expose ${method}`);
  }
  assert.match(bridge, /flowscene-ready/);
});

test("README carries the rehearsal story, digital thread, performance boundary, and exact gate", () => {
  return readFile(new URL("../README.md", import.meta.url), "utf8").then((file) => {
    assert.match(file, /60-second demo/i);
    assert.match(file, /3D digital thread/i);
    assert.match(file, /on-demand render/i);
    assert.match(file, /npm run gate/);
    assert.match(file, /closed.*prohibited interview|prohibited interview.*closed/is);
  });
});

// --------------------------------------------------------- app execution ---
// app.js is a classic script, so it cannot be imported. It is executed in a vm
// context against a stub DOM, which exercises the real arithmetic and the real
// render path instead of asserting on source text.

function stubElement(tag = "div") {
  return {
    tagName: tag,
    className: "",
    children: [],
    attributes: {},
    handlers: {},
    style: {},
    dataset: {},
    value: undefined,
    _text: "",
    get textContent() {
      return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
    },
    set textContent(value) {
      this._text = String(value);
      this.children = [];
    },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids.slice(); this._text = ""; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); },
    querySelector() { return stubElement("button"); },
    showModal() {},
    close() {}
  };
}

function textLines(node) {
  const out = [];
  const walk = (current) => {
    if (!current) return;
    if (current.children && current.children.length) current.children.forEach(walk);
    else if (current._text) out.push(current._text);
  };
  walk(node);
  return out;
}

async function launchApp({ withDom = true, ok = true } = {}) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, stubElement("div"));
    return nodes.get(id);
  };
  if (withDom) {
    node("tileArrival").value = "34";
    node("engineStock").value = "25";
  }
  const presets = ["baseline", "recover", "switch"].map((name) => {
    const button = stubElement("button");
    button.dataset = { preset: name };
    return button;
  });
  const errors = [];
  const sandbox = {
    console: { error: (...args) => errors.push(args.map(String).join(" ")), log() {}, warn() {} },
    document: {
      getElementById: (id) => (withDom ? node(id) : null),
      createElement: (tag) => stubElement(tag),
      querySelectorAll: () => (withDom ? presets : [])
    },
    structuredClone,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    addEventListener() {},
    fetch: async () => (ok
      ? { ok: true, json: async () => structuredClone(baselineData) }
      : { ok: false, status: 503 })
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(app, sandbox, { filename: "web/app.js" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = (id) => (nodes.has(id) ? nodes.get(id).textContent : "");
  const readout = () => textLines(nodes.get("selectedNodeDetail")).join(" || ");
  return { sandbox, nodes, presets, errors, text, readout };
}

test("the selected-node readout shows on-hand, inbound horizon fate, propagation, and consequence", async () => {
  const { readout, errors } = await launchApp();
  const detail = readout();
  assert.deepEqual(errors, []);
  assert.match(detail, /Thermal protection tile/);
  assert.match(detail, /12,800 on hand \+ 0 inbound inside day 21 = 12,800 usable against 16,800 required for 4 builds, so short 4,000 units/);
  assert.match(detail, /Inbound PO-1088: 5,200 units land day 34, after the 21-day horizon, so the model excludes them from usable supply \(72% confidence\)/);
  assert.match(detail, /4,200 per thermal protection set, 42-day nominal lead time/);
  assert.match(detail, /Lead time 42 days exceeds the 21-day horizon/);
  assert.match(detail, /supports 3 of 4 integrated builds, a build gap of 1, \$960,000 of synthetic shortage value/);
  assert.match(detail, /Action: Evaluate expediting 4,000 units inside day 21\./);
});

test("the readout states the causal chain from leaf to parent to integrated build gap", async () => {
  const { readout, sandbox } = await launchApp();
  assert.match(
    readout(),
    /Causal chain \(builds supported at each level\): thermal protection tile covers 3 builds then thermal protection set covers 3 builds then integrated vehicle delivers 3 of 4\. That chain is the build gap: 1 vehicle short of target\./
  );
  sandbox.FlowApp.renderSelectedNode({ id: "ENGINE" });
  const engine = readout();
  assert.match(engine, /Not the binding constraint: Engine assembly supports 4 builds, 1 build above the 3 the plan can release/);
  assert.match(engine, /The binding chain is thermal protection tile covers 3 builds/);
});

test("assembly and over-covered nodes explain their own position instead of a bare status", async () => {
  const { sandbox, readout } = await launchApp();
  sandbox.FlowApp.renderSelectedNode({ id: "PROP-MODULE" });
  const assembly = readout();
  assert.match(assembly, /ASSEMBLY \/ Propulsion — 1 per integrated vehicle\./);
  assert.match(assembly, /Assembly availability comes from child supply only: engine assembly sets the ceiling at 4 of 4 builds\./);

  sandbox.FlowApp.renderSelectedNode({ id: "METHANE-VALVE" });
  const valve = readout();
  assert.match(valve, /68 on hand \+ 24 inbound inside day 21 = 92 usable against 72 required for 4 builds, so 20 units spare/);
  assert.match(valve, /Inbound PO-1042: 24 units land day 12, inside the 21-day horizon, so they count as usable supply/);
  assert.match(valve, /Consequence: covers 5 builds against a target of 4, no build gap from this part\./);
});

test("each preset reports its own before/after delta and a concrete recommendation", async () => {
  const { sandbox, text } = await launchApp();
  const { presets, setPreset } = sandbox.FlowApp;

  assert.equal(text("readyBuilds"), "3");
  assert.match(text("beforeAfter"), /Preset 01 baseline: 3 of 4 builds ready, gap 1, \$960,000 of shortage value\. Thermal protection tile is the limiting leaf\./);
  assert.match(text("recommendation"), /Evaluate expediting 4,000 units inside day 21\..*the only leaf holding the plan at 3 of 4; clearing it lifts this path to 4/);

  setPreset(presets.recover);
  assert.equal(text("readyBuilds"), "4");
  assert.match(text("beforeAfter"), /Preset 02 recover the thermal receipt against baseline: ready 3 to 4 \(\+1\); gap 1 to 0 \(-1\); shortage value \$960,000 to \$0; limiting leaf moves thermal protection tile to engine assembly\./);
  assert.match(text("recommendation"), /release the 4-build plan\. Next tightest leaf: engine assembly at 1 spare unit \(4 builds of cover\), so confirm that cover before committing to the full plan\./);

  setPreset(presets.switch);
  assert.equal(text("readyBuilds"), "3");
  assert.match(text("beforeAfter"), /Preset 03 switch the constraint against baseline: ready 3 to 3 \(no change\); gap 1 to 1 \(no change\); .*limiting leaf moves thermal protection tile to engine assembly\./);
  assert.match(text("recommendation"), /Validate a recovery source for 2 units\./);
  assert.match(text("criticalPath"), /Engine assembly/);

  setPreset(presets.baseline);
  assert.equal(text("readyBuilds"), "3");
  assert.match(text("beforeAfter"), /Preset 01 baseline/);
});

test("a missing cockpit node never throws and never logs a console error", async () => {
  const { errors, sandbox } = await launchApp({ withDom: false });
  assert.deepEqual(errors, []);
  assert.equal(typeof sandbox.FlowApp.evaluate, "function");
  const result = sandbox.FlowApp.evaluate(structuredClone(baselineData));
  assert.equal(result.summary.ready, 3);
  assert.equal(result.evidence["TPS-TILE"].shortage, 4000);
});

test("a failed scenario load surfaces in the constraint list instead of failing silently", async () => {
  const { errors, text } = await launchApp({ ok: false });
  assert.match(text("constraintList"), /MODEL LOAD FAILED/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Scenario load failed: 503/);
});

test("the model rejects orders and BOM rows that reference unknown parts", async () => {
  const { sandbox } = await launchApp({ withDom: false });
  const withBadOrder = structuredClone(baselineData);
  withBadOrder.purchase_orders.push({ id: "PO-9999", part_id: "GHOST", qty: 1, arrival_day: 3, confidence: 1 });
  assert.throws(() => sandbox.FlowApp.evaluate(withBadOrder), /unknown part GHOST/);
  const withBadChild = structuredClone(baselineData);
  withBadChild.bom[0].children.push({ part_id: "GHOST", qty: 1 });
  assert.throws(() => sandbox.FlowApp.evaluate(withBadChild), /Unknown part GHOST/);
});

test("README declares the synthetic/modeled/not-claimed boundaries, the gate, and the vehicle view", () => {
  assert.match(readme, /Not affiliated with or endorsed by SpaceX/i);
  assert.match(readme, /What is synthetic/i);
  assert.match(readme, /What is modeled/i);
  assert.match(readme, /What is not claimed/i);
  assert.match(readme, /npm run lint && npm run test:python && npm run test:web && npm run verify:assets && npm run verify:boot/);
  assert.match(readme, /WebGL/);
  for (const preset of [/Preset 01/, /Preset 02/, /Preset 03/]) assert.match(readme, preset);
});
