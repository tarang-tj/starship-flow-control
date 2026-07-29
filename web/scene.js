const THREAD_LAYOUT = [
  ["VEHICLE", 0, -112, 0],
  ["PROP-MODULE", -158, -18, 12],
  ["HEAT-SHIELD", 0, 18, 28],
  ["AVIONICS", 158, -18, 12],
  ["ENGINE", -205, 116, 42],
  ["METHANE-VALVE", -105, 144, 54],
  ["TPS-TILE", 0, 158, 62],
  ["FLIGHT-COMP", 158, 132, 48],
];

const THREAD_LINKS = [
  ["VEHICLE", "PROP-MODULE"], ["VEHICLE", "HEAT-SHIELD"], ["VEHICLE", "AVIONICS"],
  ["PROP-MODULE", "ENGINE"], ["PROP-MODULE", "METHANE-VALVE"],
  ["HEAT-SHIELD", "TPS-TILE"], ["AVIONICS", "FLIGHT-COMP"],
];

const FALLBACK_PARTS = {
  VEHICLE: ["Integrated vehicle", "Integration"],
  "PROP-MODULE": ["Propulsion module", "Propulsion"],
  "HEAT-SHIELD": ["Thermal protection set", "Structures"],
  AVIONICS: ["Avionics package", "Avionics"],
  ENGINE: ["Engine assembly", "Propulsion"],
  "METHANE-VALVE": ["Cryogenic methane valve", "Propulsion"],
  "TPS-TILE": ["Thermal protection tile", "Structures"],
  "FLIGHT-COMP": ["Flight computer", "Avionics"],
};

function stateFor(result, path) {
  if (!result.summary?.gap || path.length <= 1) return "clear";
  const leaf = path.at(-1);
  if (leaf === "TPS-TILE" || path.includes("HEAT-SHIELD")) return "thermal";
  if (leaf === "ENGINE" || leaf === "METHANE-VALVE" || path.includes("PROP-MODULE")) return "propulsion";
  return "constraint";
}

export function buildThreadModel(result) {
  if (!result || !result.summary) throw new TypeError("A scenario evaluation result is required");
  const constraintPath = result.root?.path?.length ? [...result.root.path] : ["VEHICLE"];
  const state = stateFor(result, constraintPath);
  const labels = {
    thermal: "THERMAL CONSTRAINT", propulsion: "PROPULSION CONSTRAINT",
    constraint: "ACTIVE CONSTRAINT", clear: "PLAN CLEAR",
  };
  const activeEdges = new Set(constraintPath.slice(1).map((id, index) => `${constraintPath[index]}:${id}`));
  const constraintById = new Map((result.constraints || []).map((item) => [item.id, item]));
  const nodes = THREAD_LAYOUT.map(([id, x, y, z]) => {
    const supplied = result.parts?.[id] || {};
    const fallback = FALLBACK_PARTS[id];
    const constraint = constraintById.get(id);
    const onPath = constraintPath.includes(id);
    let status = onPath ? "path" : "nominal";
    if (state === "clear" && id === "VEHICLE") status = "clear";
    else if (state !== "clear" && id === constraintPath.at(-1)) status = "limiting";
    const name = supplied.name || fallback[0];
    const category = supplied.category || fallback[1];
    return {
      id, x, y, z, name, category, status, selectable: true,
      detail: {
        id, name, category, status,
        scenarioState: state,
        readiness: `${result.summary.ready} / ${result.summary.target}`,
        shortage: constraint?.shortage || 0,
        risk: constraint?.risk || 0,
        action: constraint?.action || (state === "clear" ? "No recovery action required." : "Not on the limiting path."),
      },
    };
  });
  const links = THREAD_LINKS.map(([from, to]) => ({ from, to, active: state !== "clear" && activeEdges.has(`${from}:${to}`) }));
  return { state, label: labels[state], constraintPath, nodes, links, summary: { ...result.summary } };
}

function unavailableController(error, onError) {
  onError(error);
  return {
    update() {}, invalidate() {}, selectNode() { return false; }, focusNext() { return false; }, dispose() {},
    getState: () => ({ available: false, error }),
  };
}

export function createDigitalThread(canvas, options = {}) {
  const onSelect = options.onSelect || (() => {});
  const onError = options.onError || (() => {});
  if (!canvas || typeof canvas.getContext !== "function") return unavailableController(new Error("A canvas element is required"), onError);
  const context = canvas.getContext("2d");
  if (!context) return unavailableController(new Error("2D canvas rendering is unavailable; show the HTML BOM fallback."), onError);

  const environment = options.environment || globalThis;
  const pixelRatio = Math.min(2, Math.max(1, environment.devicePixelRatio || 1));
  const media = environment.matchMedia?.("(prefers-reduced-motion: reduce)");
  const reducedMotion = Boolean(media?.matches);
  const requestFrame = environment.requestAnimationFrame?.bind(environment) || ((fn) => environment.setTimeout(fn, 16));
  const cancelFrame = environment.cancelAnimationFrame?.bind(environment) || environment.clearTimeout?.bind(environment);
  let model = null;
  let selectedId = null;
  let hoveredId = null;
  let frame = null;
  let disposed = false;
  let screenNodes = [];

  canvas.tabIndex = canvas.tabIndex < 0 ? 0 : canvas.tabIndex;
  canvas.setAttribute?.("role", "application");
  canvas.setAttribute?.("aria-label", "Interactive exploded vehicle digital thread. Use arrow keys to move and Enter to inspect.");

  function resize() {
    const bounds = canvas.getBoundingClientRect?.() || { width: canvas.clientWidth || 640, height: canvas.clientHeight || 420 };
    const width = Math.max(1, Math.round((bounds.width || 640) * pixelRatio));
    const height = Math.max(1, Math.round((bounds.height || 420) * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
    }
    invalidate();
  }

  function project(node, width, height) {
    const scale = Math.min(width / 680, height / 500);
    return { ...node, sx: width / 2 + (node.x - node.z * 0.38) * scale, sy: height / 2 + (node.y + node.z * 0.2) * scale, radius: Math.max(13, 18 * scale) };
  }

  function drawLink(link, byId) {
    const from = byId.get(link.from), to = byId.get(link.to);
    if (!from || !to) return;
    context.beginPath(); context.moveTo(from.sx, from.sy); context.lineTo(to.sx, to.sy);
    context.lineWidth = link.active ? 5 : 1.5;
    context.strokeStyle = link.active ? "#70d7ff" : "#435064";
    context.setLineDash(link.active ? [] : [5, 7]); context.stroke(); context.setLineDash([]);
  }

  function drawNode(node) {
    const selected = node.id === selectedId, hovered = node.id === hoveredId;
    const colors = { limiting: "#ff695e", path: "#70d7ff", clear: "#79e29d", nominal: "#26364a" };
    context.save(); context.translate(node.sx, node.sy);
    context.beginPath();
    context.moveTo(0, -node.radius); context.lineTo(node.radius, -node.radius * 0.45);
    context.lineTo(node.radius, node.radius * 0.48); context.lineTo(0, node.radius);
    context.lineTo(-node.radius, node.radius * 0.48); context.lineTo(-node.radius, -node.radius * 0.45); context.closePath();
    context.fillStyle = colors[node.status]; context.fill();
    context.lineWidth = selected || hovered ? 4 : 1.5; context.strokeStyle = selected ? "#ffffff" : "#99abc2"; context.stroke();
    context.fillStyle = "#eaf2ff"; context.font = "600 11px system-ui"; context.textAlign = "center";
    context.fillText(node.name.toUpperCase(), 0, node.radius + 17);
    context.restore();
  }

  function render() {
    frame = null;
    if (disposed) return;
    const width = canvas.width / pixelRatio, height = canvas.height / pixelRatio;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#09111d"; context.fillRect(0, 0, width, height);
    if (!model) return;
    context.fillStyle = model.state === "clear" ? "#79e29d" : "#c8d4e5";
    context.font = "700 12px system-ui"; context.textAlign = "left"; context.fillText(model.label, 18, 26);
    context.font = "11px system-ui"; context.fillStyle = "#8293aa";
    context.fillText(`READINESS ${model.summary.ready} / ${model.summary.target}`, 18, 44);
    screenNodes = model.nodes.map((node) => project(node, width, height));
    const byId = new Map(screenNodes.map((node) => [node.id, node]));
    for (const link of model.links) drawLink(link, byId);
    for (const node of screenNodes) drawNode(node);
  }

  function invalidate() {
    if (!disposed && frame === null) frame = requestFrame(render);
  }

  function selectNode(id) {
    const node = model?.nodes.find((item) => item.id === id);
    if (!node) return false;
    selectedId = id; onSelect({ ...node.detail }); invalidate(); return true;
  }

  function focusNext(direction = 1) {
    if (!model?.nodes.length) return false;
    const index = Math.max(0, model.nodes.findIndex((node) => node.id === selectedId));
    return selectNode(model.nodes[(index + direction + model.nodes.length) % model.nodes.length].id);
  }

  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function hit(event) {
    const cursor = point(event);
    return [...screenNodes].reverse().find((node) => Math.hypot(cursor.x - node.sx, cursor.y - node.sy) <= node.radius + 8);
  }

  function pointerMove(event) {
    const next = hit(event)?.id || null;
    if (next !== hoveredId) { hoveredId = next; if (canvas.style) canvas.style.cursor = next ? "pointer" : "default"; invalidate(); }
  }
  function pointerLeave() { hoveredId = null; invalidate(); }
  function click(event) { const node = hit(event); if (node) selectNode(node.id); }
  function keydown(event) {
    if (["ArrowRight", "ArrowDown"].includes(event.key)) { event.preventDefault(); focusNext(1); }
    else if (["ArrowLeft", "ArrowUp"].includes(event.key)) { event.preventDefault(); focusNext(-1); }
    else if ((event.key === "Enter" || event.key === " ") && selectedId) { event.preventDefault(); selectNode(selectedId); }
  }
  const listeners = [["pointermove", pointerMove], ["pointerleave", pointerLeave], ["click", click], ["keydown", keydown]];
  for (const [type, listener] of listeners) canvas.addEventListener(type, listener);

  const Observer = environment.ResizeObserver;
  const observer = Observer ? new Observer(resize) : null;
  observer?.observe(canvas); resize();

  return {
    update(result) { model = buildThreadModel(result); selectedId = model.constraintPath.at(-1); invalidate(); },
    invalidate, selectNode, focusNext,
    getState: () => ({ available: true, model, selectedId, hoveredId, reducedMotion, pixelRatio }),
    dispose() {
      disposed = true;
      if (frame !== null && cancelFrame) cancelFrame(frame);
      frame = null; observer?.disconnect();
      for (const [type, listener] of listeners) canvas.removeEventListener(type, listener);
    },
  };
}
