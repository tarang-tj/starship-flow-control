let baseline;
let baselineResult;
let currentResult;
let previewFrame;

const $ = (id) => document.getElementById(id);
const money = (n) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
}).format(n);
const num = (n) => Number(n || 0).toLocaleString("en-US");
const lower = (text) => String(text || "").toLowerCase();
const PRESETS = Object.freeze({
  baseline: Object.freeze({day: 34, engines: 25}),
  recover: Object.freeze({day: 9, engines: 25}),
  switch: Object.freeze({day: 9, engines: 22})
});
const PRESET_LABEL = Object.freeze({
  baseline: "Preset 01 baseline",
  recover: "Preset 02 recover the thermal receipt",
  switch: "Preset 03 switch the constraint"
});
let lastInputs = {...PRESETS.baseline};

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

function lines(container, texts, className) {
  texts.forEach((text, index) => {
    container.append(element("span", className, text));
    if (index < texts.length - 1) container.append(element("br"));
  });
}

async function boot() {
  const response = await fetch("../data/baseline.json");
  if (!response.ok) throw new Error(`Scenario load failed: ${response.status}`);
  baseline = deepFreeze(await response.json());
  baselineResult = evaluate(structuredClone(baseline));
  runScenario();
}

// ---------------------------------------------------------------- model ----

function evaluate(data) {
  const horizon = data.meta.horizon_days;
  const target = data.meta.target_builds;
  const parts = Object.fromEntries(data.parts.map((part) => [part.id, {...part}]));
  const children = Object.fromEntries(data.bom.map((row) => [row.parent_id, row.children]));
  const parentOf = {};
  for (const row of data.bom) {
    for (const child of row.children) {
      if (!parts[child.part_id]) throw new Error(`Unknown part ${child.part_id} under ${row.parent_id}`);
      parentOf[child.part_id] = {id: row.parent_id, qty: child.qty};
    }
  }
  const inbound = Object.fromEntries(data.parts.map((part) => [part.id, 0]));
  const late = Object.fromEntries(data.parts.map((part) => [part.id, 0]));
  const ordersByPart = Object.fromEntries(data.parts.map((part) => [part.id, []]));
  const orders = data.purchase_orders.map((order) => ({...order, inside: order.arrival_day <= horizon}));
  for (const order of orders) {
    if (!parts[order.part_id]) throw new Error(`Order ${order.id} references unknown part ${order.part_id}`);
    (order.inside ? inbound : late)[order.part_id] += order.qty;
    ordersByPart[order.part_id].push(order);
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
      ? `Evaluate expediting ${num(shortage)} units inside day ${horizon}.`
      : `Validate a recovery source for ${num(shortage)} units.`;
    constraints.push({...part, required, shortage, buildGap, risk, late: late[id], action});
  }
  constraints.sort((a, b) => b.risk - a.risk);

  const summary = {
    target,
    ready: Math.min(target, root.available),
    gap: Math.max(0, target - root.available),
    value: constraints.reduce((sum, constraint) => sum + constraint.shortage * constraint.unit_cost, 0)
  };
  const evidence = buildEvidence({
    parts, children, parentOf, inbound, late, ordersByPart, memo, demand, constraints, summary, horizon, root
  });
  return {root, constraints, summary, orders, horizon, parts, evidence};
}

// Per-part decision evidence: the "why", computed once per evaluation so the
// readout never re-walks the BOM on selection.
function buildEvidence(context) {
  const {parts, children, parentOf, inbound, late, ordersByPart, memo, demand, constraints, summary, root} = context;
  const byId = new Map(constraints.map((constraint) => [constraint.id, constraint]));
  const evidence = {};
  for (const part of Object.values(parts)) {
    const id = part.id;
    const node = memo[id];
    const leaf = !children[id];
    const required = demand[id] || 0;
    const usable = part.on_hand + inbound[id];
    const perBuild = summary.target ? required / summary.target : 0;
    const supports = leaf
      ? (perBuild > 0 ? Math.floor(usable / perBuild) : summary.target)
      : (node ? node.available : 0);
    const shortage = leaf ? Math.max(0, required - usable) : 0;
    const parent = parentOf[id];
    const driverId = node && node.path.length > 1 ? node.path[1] : null;
    evidence[id] = {
      id,
      name: part.name,
      category: part.category,
      leaf,
      role: leaf ? "COMPONENT" : (parent ? "ASSEMBLY" : "INTEGRATION"),
      onHand: part.on_hand,
      leadTime: part.lead_time_days,
      unitCost: part.unit_cost,
      required,
      usable,
      perBuild,
      inboundInside: inbound[id],
      inboundLate: late[id],
      orders: ordersByPart[id] || [],
      qtyPer: parent ? parent.qty : 0,
      parentId: parent ? parent.id : null,
      parentName: parent ? parts[parent.id].name : null,
      driverId,
      driverName: driverId && parts[driverId] ? parts[driverId].name : null,
      supports,
      shortage,
      margin: usable - required,
      buildGap: Math.max(0, summary.target - supports),
      shortageValue: shortage * part.unit_cost,
      risk: byId.get(id) ? byId.get(id).risk : 0,
      action: byId.get(id) ? byId.get(id).action : "",
      onPath: root.path.includes(id),
      limiting: summary.gap > 0 && id === root.path.at(-1)
    };
  }
  return evidence;
}

// ------------------------------------------------------------ narrative ----

function chainText(result) {
  const path = result.root.path;
  return path
    .slice()
    .reverse()
    .map((id, index) => {
      const ev = result.evidence[id];
      const name = lower(ev ? ev.name : id);
      return index === path.length - 1
        ? `${name} delivers ${result.summary.ready} of ${result.summary.target}`
        : `${name} covers ${ev ? ev.supports : 0} builds`;
    })
    .join(" then ");
}

function causalLine(ev, result) {
  const chain = chainText(result);
  if (ev.onPath) {
    const tail = result.summary.gap
      ? `That chain is the build gap: ${result.summary.gap} vehicle${result.summary.gap === 1 ? "" : "s"} short of target.`
      : "No level in that chain falls below target, so the plan clears.";
    return `Causal chain (builds supported at each level): ${chain}. ${tail}`;
  }
  const slack = ev.supports - result.summary.ready;
  const position = slack > 0
    ? `${slack} build${slack === 1 ? "" : "s"} above the ${result.summary.ready} the plan can release`
    : `level with the ${result.summary.ready} the plan can release`;
  return `Not the binding constraint: ${ev.name} supports ${ev.supports} builds, ${position}. The binding chain is ${chain}.`;
}

function flagFor(ev, result) {
  if (!result.summary.gap) return ev.onPath ? "TIGHTEST PATH / PLAN CLEAR" : "NOT BINDING";
  if (ev.limiting) return "LIMITING LEAF";
  if (ev.onPath) return "ON THE LIMITING PATH";
  return ev.shortage ? "SHORT BUT NOT BINDING" : "NOT BINDING";
}

function evidenceLines(ev, result) {
  const horizon = result.horizon;
  const target = result.summary.target;
  const out = [];
  const lead = ev.leadTime ? `, ${ev.leadTime}-day nominal lead time` : "";
  out.push(ev.parentName
    ? `${ev.role} / ${ev.category} — ${num(ev.qtyPer)} per ${lower(ev.parentName)}${lead}.`
    : `${ev.role} / ${ev.category} — top level, ${target} builds due inside day ${horizon}.`);

  if (ev.leaf) {
    const balance = ev.shortage
      ? `short ${num(ev.shortage)} units`
      : `${num(ev.margin)} unit${ev.margin === 1 ? "" : "s"} spare`;
    out.push(`Supply: ${num(ev.onHand)} on hand + ${num(ev.inboundInside)} inbound inside day ${horizon} = ${num(ev.usable)} usable against ${num(ev.required)} required for ${target} builds, so ${balance}.`);
  } else {
    out.push(`Assembly availability comes from child supply only: ${lower(ev.driverName || "its worst child")} sets the ceiling at ${ev.supports} of ${target} builds.${ev.onHand ? ` Its own ${num(ev.onHand)} on-hand units are not credited to the parent (see the boundaries in the README).` : ""}`);
  }

  if (!ev.orders.length) out.push("Inbound: no purchase order against this part in the synthetic order book.");
  for (const order of ev.orders) {
    out.push(order.inside
      ? `Inbound ${order.id}: ${num(order.qty)} units land day ${order.arrival_day}, inside the ${horizon}-day horizon, so they count as usable supply (${Math.round(order.confidence * 100)}% confidence).`
      : `Inbound ${order.id}: ${num(order.qty)} units land day ${order.arrival_day}, after the ${horizon}-day horizon, so the model excludes them from usable supply (${Math.round(order.confidence * 100)}% confidence).`);
  }

  if (ev.leaf && ev.shortage) {
    const late = ev.orders.some((order) => !order.inside);
    out.push(ev.leadTime > horizon
      ? `Lead time ${ev.leadTime} days exceeds the ${horizon}-day horizon, so a fresh buy cannot land in time. Recovery has to come from ${late ? "pulling an existing receipt inside the horizon" : "reallocation or an off-book source, because nothing is on the order book"}.`
      : `Lead time ${ev.leadTime} days fits inside the ${horizon}-day horizon, so a new buy is a live recovery option.`);
  }

  out.push(ev.supports > target
    ? `Consequence: covers ${ev.supports} builds against a target of ${target}, no build gap from this part.`
    : `Consequence: supports ${ev.supports} of ${target} integrated builds${ev.buildGap ? `, a build gap of ${ev.buildGap}` : ", no build gap from this part"}${ev.shortageValue ? `, ${money(ev.shortageValue)} of synthetic shortage value` : ""}.`);
  out.push(causalLine(ev, result));
  if (ev.action) out.push(`Action: ${ev.action}`);
  return out;
}

function presetName(inputs) {
  const match = Object.entries(PRESETS)
    .find(([, preset]) => preset.day === inputs.day && preset.engines === inputs.engines);
  return match ? match[0] : null;
}

function leafName(result) {
  const ev = result.evidence[result.root.path.at(-1)];
  return ev ? ev.name : "the limiting leaf";
}

function beforeAfter(result, inputs = lastInputs) {
  const before = baselineResult ? baselineResult.summary : result.summary;
  const after = result.summary;
  const name = presetName(inputs);
  const label = name ? PRESET_LABEL[name] : "What-if scenario";
  if (name === "baseline" || !baselineResult) {
    return `${label}: ${after.ready} of ${after.target} builds ready, gap ${after.gap}, ${money(after.value)} of shortage value. ${leafName(result)} is the limiting leaf. This state is the frozen anchor every other scenario is measured against.`;
  }
  const signed = (value) => (value === 0 ? "no change" : `${value > 0 ? "+" : ""}${value}`);
  const movedFrom = leafName(baselineResult);
  const movedTo = leafName(result);
  const movement = movedFrom === movedTo
    ? `limiting leaf stays ${lower(movedTo)}`
    : `limiting leaf moves ${lower(movedFrom)} to ${lower(movedTo)}`;
  return `${label} against baseline: ready ${before.ready} to ${after.ready} (${signed(after.ready - before.ready)}); gap ${before.gap} to ${after.gap} (${signed(after.gap - before.gap)}); shortage value ${money(before.value)} to ${money(after.value)}; ${movement}.`;
}

// Tightest leaf that is not yet short: the constraint that bites next.
function nextTightest(result) {
  let best = null;
  for (const ev of Object.values(result.evidence)) {
    if (!ev.leaf || !ev.required || ev.shortage) continue;
    if (!best || ev.supports < best.supports || (ev.supports === best.supports && ev.margin < best.margin)) best = ev;
  }
  return best;
}

function recommendation(result) {
  const next = nextTightest(result);
  const watch = next
    ? ` Next tightest leaf: ${lower(next.name)} at ${num(next.margin)} spare unit${next.margin === 1 ? "" : "s"} (${next.supports} builds of cover), so confirm that cover before committing to the full plan.`
    : "";
  if (!result.summary.gap) {
    return `Recommendation: protect the recovered dates and release the ${result.summary.target}-build plan.${watch}`;
  }
  const constraint = result.constraints[0];
  if (!constraint) return "Recommendation: validate the limiting assembly before releasing the plan.";
  const ev = result.evidence[constraint.id];
  const rank = result.constraints.length === 1
    ? "the only leaf"
    : `the top-ranked of ${result.constraints.length} short leaves`;
  const lift = ev
    ? ` It is ${rank} holding the plan at ${result.summary.ready} of ${result.summary.target}; clearing it lifts this path to ${result.summary.target}.`
    : "";
  return `Recommendation: ${constraint.action}${lift}${watch}`;
}

function announce(result, inputs) {
  const delta = beforeAfter(result, inputs);
  const advice = recommendation(result);
  const statusAnnouncement = $("statusAnnouncement");
  if (statusAnnouncement) {
    statusAnnouncement.setAttribute("role", "status");
    statusAnnouncement.setAttribute("aria-live", "polite");
    statusAnnouncement.textContent = `${delta} ${advice}`;
  }
  setText("beforeAfter", delta);
  setText("recommendation", advice);
}

// ---------------------------------------------------------------- views ----

function renderConstraints(result) {
  const list = $("constraintList");
  if (!list) return;
  clear(list);
  if (!result.constraints.length) {
    const empty = element("div", "empty");
    empty.append(element("b", "", "PLAN CLEARS"), element("p", "", "No leaf shortage blocks the target inside this horizon."));
    list.append(empty);
    return;
  }
  for (const constraint of result.constraints) {
    const ev = result.evidence[constraint.id];
    const article = element("article", "constraint");
    const ring = element("div", "risk-ring", constraint.risk);
    ring.setAttribute("aria-label", `Risk score ${constraint.risk}`);
    const copy = element("div");
    const detail = element("p");
    lines(detail, [
      `${num(constraint.shortage)} units short of ${num(constraint.required)} required — ${num(ev ? ev.usable : 0)} usable (${num(ev ? ev.onHand : 0)} on hand + ${num(ev ? ev.inboundInside : 0)} inside day ${result.horizon}), ${constraint.lead_time_days}-day nominal lead.`,
      constraint.action
    ], "constraint-line");
    copy.append(element("h3", "", constraint.name), detail);
    const impact = element("div", "impact");
    impact.append(element("b", "", `−${constraint.buildGap}`), element("span", "", "BUILD IMPACT"));
    article.append(ring, copy, impact);
    list.append(article);
  }
}

function renderPath(result) {
  const path = $("criticalPath");
  if (!path) return;
  clear(path);
  const total = result.root.path.length;
  result.root.path.forEach((id, index) => {
    const ev = result.evidence[id];
    const last = index === total - 1;
    const node = element("div", "path-node");
    node.append(
      element("b", "", ev ? ev.name : id),
      element("span", "", last ? "LIMITING LEAF" : `LEVEL ${index + 1}`),
      element("small", "path-figure", ev && last && ev.shortage
        ? `covers ${ev.supports}/${result.summary.target} builds, short ${num(ev.shortage)}`
        : `covers ${ev ? ev.supports : 0}/${result.summary.target} builds`)
    );
    path.append(node);
  });
}

function renderOrders(result) {
  const body = $("ordersBody");
  if (!body) return;
  clear(body);
  for (const order of result.orders) {
    const part = result.parts[order.part_id];
    const row = element("tr");
    [order.id, part ? part.name : order.part_id, num(order.qty), `DAY ${order.arrival_day}`, `${Math.round(order.confidence * 100)}%`]
      .forEach((value) => row.append(element("td", "", value)));
    const statusCell = element("td");
    statusCell.append(element("span", order.inside ? "tag" : "tag late", order.inside ? "IN HORIZON" : "TOO LATE"));
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

// Accepts either a scene node, a scene detail payload, or a raw part record.
function evidenceFor(node) {
  if (!node || !currentResult) return null;
  const id = node.id || (node.detail && node.detail.id);
  if (id && currentResult.evidence[id]) return currentResult.evidence[id];
  const name = node.name || (node.detail && node.detail.name);
  return Object.values(currentResult.evidence).find((ev) => ev.name === name) || null;
}

function renderSelectedNode(node) {
  const selectedNodeDetail = $("selectedNodeDetail");
  if (!selectedNodeDetail || !node) return;
  const ev = evidenceFor(node);
  clear(selectedNodeDetail);
  if (!ev) {
    const detail = node.detail || node.status;
    const narrative = detail && typeof detail === "object"
      ? `${detail.status}; readiness ${detail.readiness}`
      : detail || "No additional synthetic detail.";
    selectedNodeDetail.textContent = `${node.name || node.id || "Synthetic component"}: ${narrative}`;
    return;
  }
  selectedNodeDetail.append(
    element("b", "evidence-name", ev.name),
    element("span", "evidence-flag", ` — ${flagFor(ev, currentResult)}`),
    element("br")
  );
  lines(selectedNodeDetail, evidenceLines(ev, currentResult), "evidence-line");
}

function render(result, inputs) {
  currentResult = result;
  const changed = inputs.day !== PRESETS.baseline.day || inputs.engines !== PRESETS.baseline.engines;
  setText($("scenarioState"), changed ? "WHAT-IF" : "BASELINE");
  setText($("horizonLabel"), `${result.horizon} DAYS`);
  setText($("readyBuilds"), result.summary.ready);
  setText($("targetBuilds"), result.summary.target);
  setText($("buildGap"), result.summary.gap);
  setText($("constraintCount"), result.constraints.length);
  setText($("riskValue"), money(result.summary.value));
  setText($("readinessNote"), result.summary.gap
    ? `${result.summary.gap} build blocked by ${lower(leafName(result))} timing`
    : "Target is feasible inside the horizon");
  setText($("pathBadge"), `${result.root.path.length} LEVELS`);
  renderConstraints(result);
  renderPath(result);
  renderOrders(result);
  announce(result, inputs);
  renderSelectedNode(result.parts[result.root.path.at(-1)]);
  renderScene(result, inputs);
}

// ------------------------------------------------------------ scenarios ----

function readNumber(node, fallback) {
  const raw = node ? node.value : undefined;
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) ? value : fallback;
}

function currentInputs() {
  lastInputs = {
    day: readNumber($("tileArrival"), lastInputs.day),
    engines: readNumber($("engineStock"), lastInputs.engines)
  };
  return lastInputs;
}

function applyScenario(inputs) {
  const data = structuredClone(baseline);
  const tileOrder = data.purchase_orders.find((order) => order.part_id === "TPS-TILE");
  const enginePart = data.parts.find((part) => part.id === "ENGINE");
  if (!tileOrder || !enginePart) throw new Error("Scenario levers are missing from the baseline data");
  tileOrder.arrival_day = inputs.day;
  enginePart.on_hand = inputs.engines;
  return evaluate(data);
}

function runScenario() {
  if (!baseline) return;
  const inputs = currentInputs();
  render(applyScenario(inputs), inputs);
}

function syncOutputs() {
  setText("tileDayOut", lastInputs.day);
  setText("engineOut", lastInputs.engines);
}

function schedulePreview() {
  currentInputs();
  syncOutputs();
  if (previewFrame) cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => {
    previewFrame = undefined;
    runScenario();
  });
}

function setPreset(preset) {
  const tile = $("tileArrival");
  const engines = $("engineStock");
  if (tile) tile.value = preset.day;
  if (engines) engines.value = preset.engines;
  lastInputs = {day: preset.day, engines: preset.engines};
  syncOutputs();
  runScenario();
}

function reset() {
  setPreset(PRESETS.baseline);
}

$("tileArrival")?.addEventListener("input", schedulePreview);
$("engineStock")?.addEventListener("input", schedulePreview);
$("runBtn")?.addEventListener("click", runScenario);
$("resetBtn")?.addEventListener("click", reset);
document.querySelectorAll("[data-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const preset = PRESETS[button.dataset.preset];
    if (preset) setPreset(preset);
  });
});
const dialog = $("methodDialog");
$("aboutBtn")?.addEventListener("click", () => dialog?.showModal?.());
dialog?.querySelector(".dialog-close")?.addEventListener("click", () => dialog.close());

window.FlowApp = Object.freeze({evaluate, presets: PRESETS, setPreset, renderSelectedNode, beforeAfter, recommendation});
window.addEventListener("flowscene-ready", runScenario);

boot().catch((error) => {
  const list = $("constraintList");
  if (list) {
    clear(list);
    const empty = element("div", "empty");
    empty.append(
      element("b", "", "MODEL LOAD FAILED"),
      element("p", "", `${error.message}. Serve from the project root with Python's HTTP server.`)
    );
    list.append(empty);
  }
  console.error(error);
});
