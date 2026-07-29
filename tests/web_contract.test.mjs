import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const baselineData = JSON.parse(await readFile(new URL("../data/baseline.json", import.meta.url), "utf8"));

// Markup ids are the artifact the cockpit contract is written against, so these
// stay structural. Every behavioural claim about app.js below is executed, not
// pattern-matched: a regex over source text passes on a comment and cannot fail.
const requiredIds = [
  "main", "horizonLabel", "tileArrival", "engineStock", "runBtn", "resetBtn",
  "readyBuilds", "targetBuilds", "buildGap", "constraintCount", "riskValue",
  "constraintList", "criticalPath", "ordersBody", "methodDialog"
];
const boundIds = requiredIds.filter((id) => id !== "main");
const WRITTEN_IDS = ["horizonLabel", "readyBuilds", "targetBuilds", "buildGap", "constraintCount", "riskValue"];
const FILLED_IDS = ["constraintList", "criticalPath", "ordersBody"];
const WIRED_IDS = { tileArrival: "input", engineStock: "input", runBtn: "click", resetBtn: "click" };

test("the operating view declares every required node in the markup", () => {
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
});

test("the public interface states synthetic data and non-affiliation", () => {
  assert.match(html, /synthetic/i);
  assert.match(html, /Not affiliated with or endorsed by SpaceX/i);
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
  assert.match(readme, /60-second demo/i);
  assert.match(readme, /3D digital thread/i);
  assert.match(readme, /on-demand render/i);
  assert.match(readme, /npm run gate/);
  assert.match(readme, /closed.*prohibited interview|prohibited interview.*closed/is);
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

// README claims are prose, so they are matched as text — but line-anchored, so
// deleting the claim fails the test. An /s-flagged .* over a whole file matches
// any two words in order and proves nothing.
test("README documents both risk implementations and the shell that consumes the renderer seam", () => {
  assert.match(readme, /^`engine\.py` is authoritative for the risk score/m);
  assert.match(readme, /^The browser scenario engine in `web\/app\.js` implements the first three terms only\./m);
  assert.match(readme, /inbound_confidence_penalty.*engine\.py only/);
  assert.match(readme, /^- `web\/shell\.js`, the vehicle-view chrome, calls `setLayout/m);
  assert.match(readme, /^\| `web\/shell\.js` \|/m);
  assert.match(readme, /^- The baseline renders on load/m);
});

// Drift guard, not a behaviour test: the boot probe's own behaviour is verified
// by running it (`npm run verify:boot`). This only catches the README describing
// checks the probe no longer performs.
test("the README description of the boot probe matches the checks the probe still carries", async () => {
  const probe = await readFile(new URL("../scripts/verify_boot.mjs", import.meta.url), "utf8");
  assert.match(readme, /^- The renderer came up on WebGL/m);
  assert.match(readme, /at least 5% of the vehicle column to be lit/);
  assert.match(probe, /const MIN_PAINTED = 0\.05;/, "README quotes a 5% paint floor the probe no longer enforces");
  assert.match(probe, /assert\.equal\(boot\.renderer, "webgl"/, "README claims a WebGL assertion the probe no longer makes");
});

// --------------------------------------------------------- app execution ---
// app.js is a classic script, so it cannot be imported. It is executed in a vm
// context against a stub DOM, which exercises the real arithmetic and the real
// render path instead of asserting on source text. The stub records every
// innerHTML assignment and every animation frame so DOM-safety and throttling
// claims are observed as behaviour.

function stubElement(tag, registry) {
  const node = {
    tagName: tag,
    className: "",
    children: [],
    attributes: {},
    handlers: {},
    style: {},
    dataset: {},
    value: undefined,
    writes: 0,
    opened: 0,
    closed: 0,
    selectors: [],
    _queried: new Map(),
    _text: "",
    get textContent() {
      return this.children.length ? this.children.map((child) => child.textContent).join("") : this._text;
    },
    set textContent(value) {
      this._text = String(value);
      this.children = [];
      this.writes += 1;
    },
    get innerHTML() {
      return "";
    },
    set innerHTML(value) {
      registry.htmlWrites.push({ tag: this.tagName, value: String(value) });
    },
    insertAdjacentHTML(position, value) {
      registry.htmlWrites.push({ tag: this.tagName, value: `${position}:${value}` });
    },
    append(...kids) { this.children.push(...kids); this.writes += 1; },
    replaceChildren(...kids) { this.children = kids.slice(); this._text = ""; this.writes += 1; },
    setAttribute(key, value) { this.attributes[key] = String(value); },
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); },
    querySelector(selector) {
      this.selectors.push(selector);
      if (!this._queried.has(selector)) this._queried.set(selector, stubElement("button", registry));
      return this._queried.get(selector);
    },
    showModal() { this.opened += 1; },
    close() { this.closed += 1; }
  };
  registry.created.push(node);
  return node;
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

async function launchApp({ withDom = true, ok = true, scene } = {}) {
  const registry = { htmlWrites: [], created: [] };
  const nodes = new Map();
  const lookups = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, stubElement("div", registry));
    return nodes.get(id);
  };
  if (withDom) {
    node("tileArrival").value = "34";
    node("engineStock").value = "25";
  }
  const presets = ["baseline", "recover", "switch"].map((name) => {
    const button = stubElement("button", registry);
    button.dataset = { preset: name };
    return button;
  });
  const frames = { scheduled: 0, cancelled: 0, queue: new Map(), nextId: 1 };
  const errors = [];
  let loaded = null;
  const sandbox = {
    console: { error: (...args) => errors.push(args.map(String).join(" ")), log() {}, warn() {} },
    document: {
      getElementById: (id) => { lookups.push(id); return withDom ? node(id) : null; },
      createElement: (tag) => stubElement(tag, registry),
      querySelectorAll: () => (withDom ? presets : [])
    },
    structuredClone,
    requestAnimationFrame: (fn) => {
      frames.scheduled += 1;
      const id = frames.nextId++;
      frames.queue.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id) => { frames.cancelled += 1; frames.queue.delete(id); },
    addEventListener() {},
    fetch: async () => {
      if (!ok) return { ok: false, status: 503 };
      loaded = structuredClone(baselineData);
      return { ok: true, json: async () => loaded };
    }
  };
  sandbox.window = sandbox;
  if (scene) sandbox.FlowScene = scene;
  vm.createContext(sandbox);
  vm.runInContext(app, sandbox, { filename: "web/app.js" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = (id) => (nodes.has(id) ? nodes.get(id).textContent : "");
  const readout = () => textLines(nodes.get("selectedNodeDetail")).join(" || ");
  const dispatch = (id, type, event = {}) => {
    const handlers = nodes.has(id) ? nodes.get(id).handlers[type] : undefined;
    assert.ok(handlers && handlers.length, `#${id} has no ${type} handler bound`);
    handlers.forEach((handler) => handler(event));
  };
  const flushFrames = () => {
    const pending = [...frames.queue.values()];
    frames.queue.clear();
    pending.forEach((fn) => fn(0));
    return pending.length;
  };
  return {
    sandbox, nodes, presets, errors, text, readout, registry, frames,
    lookups, dispatch, flushFrames, loaded: () => loaded
  };
}

test("the cockpit binds every required control and writes every required readout at runtime", async () => {
  const { nodes, lookups, dispatch, text, errors } = await launchApp();
  assert.deepEqual(errors, []);
  for (const id of boundIds) assert.ok(lookups.includes(id), `app never looked up #${id}`);

  for (const id of WRITTEN_IDS) {
    assert.ok(nodes.get(id).writes > 0, `#${id} was never written`);
    assert.notEqual(text(id), "", `#${id} rendered empty`);
  }
  for (const id of FILLED_IDS) {
    assert.ok(nodes.get(id).children.length > 0, `#${id} received no rendered nodes`);
  }
  for (const [id, type] of Object.entries(WIRED_IDS)) {
    assert.ok((nodes.get(id).handlers[type] || []).length > 0, `#${id} has no ${type} listener`);
  }

  // #methodDialog is a real control, not a string: opening and closing it is observable.
  const dialog = nodes.get("methodDialog");
  assert.ok(dialog.selectors.includes(".dialog-close"), "method dialog never queried its close control");
  dispatch("aboutBtn", "click");
  assert.equal(dialog.opened, 1);
  dialog._queried.get(".dialog-close").handlers.click.forEach((handler) => handler({}));
  assert.equal(dialog.closed, 1);

  // The run and reset controls must actually recompute, not just be bound.
  nodes.get("tileArrival").value = "9";
  const before = nodes.get("readyBuilds").writes;
  dispatch("runBtn", "click");
  assert.equal(text("readyBuilds"), "4");
  assert.ok(nodes.get("readyBuilds").writes > before, "#runBtn did not recompute the scenario");
  dispatch("resetBtn", "click");
  assert.equal(nodes.get("tileArrival").value, 34, "#resetBtn did not restore the baseline lever");
  assert.equal(text("readyBuilds"), "3");
});

test("scenario presets are frozen inputs that never mutate the loaded baseline", async () => {
  const { sandbox, presets, text, loaded, nodes, dispatch } = await launchApp();
  const pristine = structuredClone(baselineData);
  const exposed = sandbox.FlowApp.presets;

  assert.deepEqual({ ...exposed.baseline }, { day: 34, engines: 25 });
  assert.deepEqual({ ...exposed.recover }, { day: 9, engines: 25 });
  assert.deepEqual({ ...exposed.switch }, { day: 9, engines: 22 });
  assert.throws(() => { exposed.baseline.day = 1; }, TypeError, "preset values must be frozen");
  assert.throws(() => { exposed.extra = { day: 1, engines: 1 }; }, TypeError, "preset table must be frozen");

  for (const button of presets) {
    button.handlers.click.forEach((handler) => handler({}));
  }
  nodes.get("tileArrival").value = "12";
  dispatch("tileArrival", "input");
  assert.deepEqual(loaded(), pristine, "running scenarios mutated the loaded baseline document");

  // evaluate() must not mutate its argument either, or repeat runs would drift.
  const copy = structuredClone(baselineData);
  sandbox.FlowApp.evaluate(copy);
  assert.deepEqual(copy, pristine, "evaluate mutated the scenario it was handed");

  sandbox.FlowApp.setPreset(exposed.baseline);
  assert.equal(text("readyBuilds"), "3", "baseline is no longer reproducible after other presets ran");
});

test("rapid slider input is coalesced into exactly one animation frame", async () => {
  const { nodes, dispatch, frames, flushFrames, text } = await launchApp();
  const ready = nodes.get("readyBuilds");
  const writesAtRest = ready.writes;

  for (let day = 30; day >= 21; day -= 1) {
    nodes.get("tileArrival").value = String(day);
    dispatch("tileArrival", "input");
  }

  assert.equal(text("tileDayOut"), "21", "the lever readout must track input immediately");
  assert.equal(ready.writes, writesAtRest, "preview recomputed before its animation frame fired");
  assert.equal(frames.queue.size, 1, `10 inputs left ${frames.queue.size} live frames instead of 1`);
  assert.equal(frames.cancelled, 9, "each superseded frame must be cancelled");

  assert.equal(flushFrames(), 1);
  assert.equal(ready.writes, writesAtRest + 1, "the coalesced frame must recompute exactly once");
  assert.equal(text("readyBuilds"), "4");
});

test("the decision narrative is announced through a live region for every scenario", async () => {
  const { nodes, sandbox, text } = await launchApp();
  const live = nodes.get("statusAnnouncement");
  assert.equal(live.attributes["aria-live"], "polite");
  assert.equal(live.attributes.role, "status");

  const delta = text("beforeAfter");
  const advice = text("recommendation");
  assert.match(delta, /Preset 01 baseline: 3 of 4 builds ready, gap 1, \$960,000 of shortage value\./);
  assert.match(advice, /^Recommendation: Evaluate expediting 4,000 units inside day 21\./);
  assert.equal(live.textContent, `${delta} ${advice}`, "the live region must carry delta and recommendation");

  const { presets, setPreset } = sandbox.FlowApp;
  setPreset(presets.recover);
  assert.match(live.textContent, /ready 3 to 4 \(\+1\); gap 1 to 0 \(-1\)/);
  assert.match(live.textContent, /Recommendation: protect the recovered dates/);
});

test("the optional 3D scene is feature-detected and cannot break the core view", async () => {
  const bare = await launchApp({ scene: {} });
  assert.deepEqual(bare.errors, []);
  assert.equal(bare.text("readyBuilds"), "3");

  const updates = [];
  const legacy = await launchApp({ scene: { update: (payload) => updates.push(payload) } });
  assert.deepEqual(legacy.errors, []);
  assert.equal(updates.length, 1, "a renderer without setScenario must still receive update()");
  assert.equal(updates[0].result.summary.ready, 3);
  assert.equal(typeof updates[0].onSelect, "function");
  assert.deepEqual({ ...updates[0].inputs }, { day: 34, engines: 25 });

  const payloads = [];
  const full = await launchApp({
    scene: {
      setScenario: (payload) => payloads.push(payload),
      update: () => assert.fail("update must not be called when setScenario exists"),
      getSelectedNode: () => ({ id: "ENGINE" })
    }
  });
  assert.deepEqual(full.errors, []);
  assert.equal(payloads.length, 1);
  assert.match(full.readout(), /Not the binding constraint: Engine assembly supports 4 builds/);

  // The renderer's onSelect callback drives the same readout the cockpit owns.
  payloads[0].onSelect({ id: "PROP-MODULE" });
  assert.match(full.readout(), /ASSEMBLY \/ Propulsion/);
});

test("dynamic fixture rendering never routes scenario data through HTML interpolation", async () => {
  const { registry, sandbox, nodes, presets } = await launchApp();
  const { presets: table, setPreset } = sandbox.FlowApp;
  for (const button of presets) button.handlers.click.forEach((handler) => handler({}));
  setPreset(table.baseline);
  sandbox.FlowApp.renderSelectedNode({ id: "METHANE-VALVE" });

  assert.deepEqual(
    registry.htmlWrites,
    [],
    `scenario data reached innerHTML: ${JSON.stringify(registry.htmlWrites.slice(0, 3))}`
  );

  // Positive half: the fixtures are real element nodes carrying real text.
  const list = nodes.get("constraintList");
  assert.ok(registry.created.length > 20, "render path created no elements");
  assert.equal(list.children[0].tagName, "article");
  assert.match(list.children[0].textContent, /Thermal protection tile/);
  const row = nodes.get("ordersBody").children[0];
  assert.equal(row.tagName, "tr");
  assert.ok(row.children.every((cell) => cell.tagName === "td"), "order rows must be built from td elements");
  assert.match(row.textContent, /PO-1042/);

  // Nothing anywhere smuggled markup through a text node either.
  const markup = registry.created.filter((element) => /<\s*[a-z/!]/i.test(element._text));
  assert.deepEqual(markup.map((element) => element._text), [], "rendered text contains raw markup");
});

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
