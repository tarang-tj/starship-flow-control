let baseline;
let baselineResult;
let previewFrame;

const $ = (id) => document.getElementById(id);
const money = (n) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
}).format(n);
const PRESETS = Object.freeze({
  baseline: Object.freeze({day: 34, engines: 25}),
  recover: Object.freeze({day: 9, engines: 25}),
  switch: Object.freeze({day: 9, engines: 22})
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function setText(target, value) {
  const node = typeof target === "string" ? $(target) : target;
  if (node) node.textContent = String(value);
}

function clear(element) {
  if (element) element.replaceChildren();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

async function boot() {
  const response = await fetch("../data/baseline.json");
  if (!response.ok) throw new Error(`Scenario load failed: ${response.status}`);
  baseline = deepFreeze(await response.json());
  baselineResult = evaluate(structuredClone(baseline));
  runScenario();
}

function evaluate(data) {
  const horizon = data.meta.horizon_days;
  const target = data.meta.target_builds;
  const parts = Object.fromEntries(data.parts.map((part) => [part.id, {...part}]));
  const children = Object.fromEntries(data.bom.map((row) => [row.parent_id, row.children]));
  const inbound = Object.fromEntries(data.parts.map((part) => [part.id, 0]));
  const late = Object.fromEntries(data.parts.map((part) => [part.id, 0]));
  for (const order of data.purchase_orders) {
    (order.arrival_day <= horizon ? inbound : late)[order.part_id] += order.qty;
  }

  const memo = {};
  const visiting = new Set();
  function solve(id) {
    if (memo[id]) return memo[id];
    if (visiting.has(id)) throw new Error(`BOM cycle at ${id}`);
    visiting.add(id);
    const part = parts[id];
    if (!part) throw new Error(`Unknown part ${id}`);
    let result;
    if (!children[id]) {
      result = {...part, usable: part.on_hand + inbound[id], available: part.on_hand + inbound[id], path: [id]};
    } else {
      const candidates = children[id].map((child) => ({
        child: solve(child.part_id),
        builds: Math.floor(solve(child.part_id).available / child.qty)
      }));
      const limiting = candidates.sort((a, b) => a.builds - b.builds)[0];
      result = {...part, usable: part.on_hand + inbound[id], available: limiting.builds, path: [id, ...limiting.child.path]};
    }
    visiting.delete(id);
    memo[id] = result;
    return result;
  }

  const root = solve("VEHICLE");
  const demand = Object.fromEntries(data.parts.map((part) => [part.id, 0]));
  demand.VEHICLE = target;
  function propagate(id, units) {
    for (const child of children[id] || []) {
      demand[child.part_id] += units * child.qty;
      propagate(child.part_id, units * child.qty);
    }
  }
  propagate("VEHICLE", target);

  const constraints = [];
  for (const [id, required] of Object.entries(demand)) {
    if (!required || children[id]) continue;
    const part = memo[id];
    const shortage = Math.max(0, required - part.usable);
    if (!shortage) continue;
    const perBuild = required / target;
    const buildGap = Math.ceil(shortage / perBuild);
    const risk = Math.round((50 * buildGap + 20 * (late[id] > 0 ? 1 : 0) + 15 * Math.min(part.lead_time_days / horizon, 2)) * 10) / 10;
    const action = late[id] >= shortage
      ? `Evaluate expediting ${shortage.toLocaleString()} units inside day ${horizon}.`
      : `Validate a recovery source for ${shortage.toLocaleString()} units.`;
    constraints.push({...part, required, shortage, buildGap, risk, late: late[id], action});
  }
  constraints.sort((a, b) => b.risk - a.risk);
  return {
    root,
    constraints,
    summary: {
      target,
      ready: Math.min(target, root.available),
      gap: Math.max(0, target - root.available),
      value: constraints.reduce((sum, constraint) => sum + constraint.shortage * constraint.unit_cost, 0)
    },
    orders: data.purchase_orders,
    horizon,
    parts
  };
}

function currentInputs() {
  return {day: Number($("tileArrival").value), engines: Number($("engineStock").value)};
}

function applyScenario(inputs) {
  const data = structuredClone(baseline);
  data.purchase_orders.find((order) => order.part_id === "TPS-TILE").arrival_day = inputs.day;
  data.parts.find((part) => part.id === "ENGINE").on_hand = inputs.engines;
  return evaluate(data);
}

function recommendation(result) {
  if (!result.summary.gap) return "Recommendation: protect the recovered dates and release the four-build plan.";
  const constraint = result.constraints[0];
  return constraint
    ? `Recommendation: ${constraint.action}`
    : "Recommendation: validate the limiting assembly before releasing the plan.";
}

function beforeAfter(result) {
  const before = baselineResult.summary;
  const after = result.summary;
  const readyDelta = after.ready - before.ready;
  const gapDelta = after.gap - before.gap;
  const signed = (value) => `${value >= 0 ? "+" : ""}${value}`;
  if (readyDelta === 0 && gapDelta === 0) {
    return `Baseline reference: ${after.ready} of ${after.target} builds ready; gap ${after.gap}. Change a recovery input to compare the decision.`;
  }
  return `Before → after: ready ${before.ready} → ${after.ready} (${signed(readyDelta)}); gap ${before.gap} → ${after.gap} (${signed(gapDelta)}).`;
}

function announce(result) {
  const message = `${beforeAfter(result)} ${recommendation(result)}`;
  const statusAnnouncement = $("statusAnnouncement");
  if (statusAnnouncement) {
    statusAnnouncement.setAttribute("role", "status");
    statusAnnouncement.setAttribute("aria-live", "polite");
    statusAnnouncement.textContent = message;
  }
  setText("beforeAfter", beforeAfter(result));
  setText("recommendation", recommendation(result));
}

function renderConstraints(result) {
  const list = $("constraintList");
  clear(list);
  if (!result.constraints.length) {
    const empty = element("div", "empty");
    empty.append(element("b", "", "PLAN CLEARS"), element("p", "", "No leaf shortage blocks the target inside this horizon."));
    list.append(empty);
    return;
  }
  for (const constraint of result.constraints) {
    const article = element("article", "constraint");
    const ring = element("div", "risk-ring", constraint.risk);
    ring.setAttribute("aria-label", `Risk score ${constraint.risk}`);
    const copy = element("div");
    copy.append(
      element("h3", "", constraint.name),
      element("p", "", `${constraint.shortage.toLocaleString()} units short · ${constraint.lead_time_days}-day nominal lead · ${constraint.action}`)
    );
    const impact = element("div", "impact");
    impact.append(element("b", "", `−${constraint.buildGap}`), element("span", "", "BUILD IMPACT"));
    article.append(ring, copy, impact);
    list.append(article);
  }
}

function renderPath(result) {
  const path = $("criticalPath");
  clear(path);
  result.root.path.forEach((id, index) => {
    const node = element("div", "path-node");
    node.append(
      element("b", "", result.parts[id].name),
      element("span", "", index === result.root.path.length - 1 ? "LIMITING LEAF" : `LEVEL ${index + 1}`)
    );
    path.append(node);
  });
}

function renderOrders(result) {
  const body = $("ordersBody");
  clear(body);
  for (const order of result.orders) {
    const part = result.parts[order.part_id];
    const inside = order.arrival_day <= result.horizon;
    const row = element("tr");
    [order.id, part.name, order.qty.toLocaleString(), `DAY ${order.arrival_day}`, `${Math.round(order.confidence * 100)}%`]
      .forEach((value) => row.append(element("td", "", value)));
    const statusCell = element("td");
    statusCell.append(element("span", inside ? "tag" : "tag late", inside ? "IN HORIZON" : "TOO LATE"));
    row.append(statusCell);
    body.append(row);
  }
}

function renderScene(result, inputs) {
  const scene = window.FlowScene;
  const payload = {result, inputs, onSelect: renderSelectedNode};
  if (scene?.setScenario) scene.setScenario(payload);
  else scene?.update?.(payload);
  const selected = scene?.getSelectedNode?.();
  if (selected) renderSelectedNode(selected);
}

function renderSelectedNode(node) {
  const selectedNodeDetail = $("selectedNodeDetail");
  if (!selectedNodeDetail || !node) return;
  const name = node.name || node.id || "Synthetic component";
  const detail = node.detail || node.status || "No additional synthetic detail.";
  const narrative = typeof detail === "object"
    ? `${detail.status}; readiness ${detail.readiness}; shortage ${detail.shortage} units; ${detail.action}`
    : detail;
  selectedNodeDetail.textContent = `${name}: ${narrative}`;
}

function render(result, inputs) {
  const changed = inputs.day !== PRESETS.baseline.day || inputs.engines !== PRESETS.baseline.engines;
  setText($("scenarioState"), changed ? "WHAT-IF" : "BASELINE");
  setText($("horizonLabel"), `${result.horizon} DAYS`);
  setText($("readyBuilds"), result.summary.ready);
  setText($("targetBuilds"), result.summary.target);
  setText($("buildGap"), result.summary.gap);
  setText($("constraintCount"), result.constraints.length);
  setText($("riskValue"), money(result.summary.value));
  setText($("readinessNote"), result.summary.gap ? `${result.summary.gap} build blocked by material timing` : "Target is feasible inside the horizon");
  setText($("pathBadge"), `${result.root.path.length} LEVELS`);
  renderConstraints(result);
  renderPath(result);
  renderOrders(result);
  announce(result);
  renderSelectedNode(result.parts[result.root.path.at(-1)]);
  renderScene(result, inputs);
}

function runScenario() {
  if (!baseline) return;
  const inputs = currentInputs();
  render(applyScenario(inputs), inputs);
}

function syncOutputs() {
  setText("tileDayOut", $("tileArrival").value);
  setText("engineOut", $("engineStock").value);
}

function schedulePreview() {
  syncOutputs();
  if (previewFrame) cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => {
    previewFrame = undefined;
    runScenario();
  });
}

function setPreset(preset) {
  $("tileArrival").value = preset.day;
  $("engineStock").value = preset.engines;
  syncOutputs();
  runScenario();
}

function reset() {
  setPreset(PRESETS.baseline);
}

$("tileArrival").addEventListener("input", schedulePreview);
$("engineStock").addEventListener("input", schedulePreview);
$("runBtn").addEventListener("click", runScenario);
$("resetBtn").addEventListener("click", reset);
document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const preset = PRESETS[button.dataset.preset];
    if (preset) setPreset(preset);
  });
});
const dialog = $("methodDialog");
$("aboutBtn").addEventListener("click", () => dialog.showModal());
dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());

window.FlowApp = Object.freeze({evaluate, presets: PRESETS, setPreset, renderSelectedNode});
window.addEventListener("flowscene-ready", runScenario);

boot().catch((error) => {
  const list = $("constraintList");
  clear(list);
  const empty = element("div", "empty");
  empty.append(
    element("b", "", "MODEL LOAD FAILED"),
    element("p", "", `${error.message}. Serve from the project root with Python's HTTP server.`)
  );
  list.append(empty);
  console.error(error);
});
