# Flow Control

A deterministic, multi-level bill-of-materials constraint radar built as an independent supply-chain operations demonstration.

**Live demo:** https://tarang-tj.github.io/starship-flow-control/

> All quantities, component names, costs, lead times, purchase orders, and build structures in this repository are synthetic. This project is not affiliated with or endorsed by SpaceX and does not represent SpaceX operations.

## Why this exists

A planning dashboard that only lists late purchase orders misses the important question: which late or short component actually limits the integrated build plan? A late purchase order is not automatically the constraint. Flow Control propagates leaf-level material availability through a multi-level BOM, surfaces the limiting path, and lets an operator compare recovery scenarios without changing the baseline.

## What it does

- Converts on-hand inventory and inbound purchase orders into usable supply inside a planning horizon.
- Recursively computes available parent assemblies from child quantities.
- Propagates a limiting leaf component to the integrated vehicle.
- Ranks target-plan shortages with a transparent impact heuristic.
- Explains each selected component: usable versus required, the fate of every inbound order against the horizon, lead-time feasibility, quantity-per-parent propagation, and the resulting integrated-build consequence.
- States the causal chain in plain language: which leaf caps which parent, and what that costs the build plan.
- Provides two what-if levers: arrival timing and engine inventory.
- Fails loudly on unknown BOM references, unknown order parts, and cycles.

## Run

```bash
cd ~/dev/starship-flow-control
python3 -m http.server 8765
```

Open http://localhost:8765/web/

## Verification gate

Install dependencies once with `npm install`, then run the exact repository gate:

```bash
npm run gate
```

`npm run gate` expands to exactly:

```bash
npm run lint && npm run test:python && npm run test:web && npm run verify:assets && npm run verify:boot
```

| Step | What it actually runs |
|---|---|
| `lint` | ESLint over `web/*.js`, `tests/*.test.mjs`, `scripts/*.mjs`, `eslint.config.mjs` |
| `test:python` | `python3 -m unittest discover -s tests` — deterministic engine tests |
| `test:web` | `node --test tests/*.test.mjs` — scene and cockpit contract tests, including the cockpit executed in a `node:vm` sandbox against a stub DOM |
| `verify:assets` | `python3 scripts/verify_assets.py` — deterministic output, baseline assertions, entry point, disclosures |
| `verify:boot` | `node scripts/verify_boot.mjs`: Playwright Chromium boots the real page at 1440×900 and 375×812 (see below) |

### What the boot probe actually asserts

At each of the two viewports, against the real page served over HTTP:

- The baseline renders on load: `#readyBuilds` reaches 3 with no click. Baseline is the initial state, so the probe verifies it rather than driving it from a preset button.
- Clicking the recover preset yields 4 ready builds; clicking the switch preset moves the critical path to the engine assembly.
- The renderer came up on WebGL, reported by the renderer itself through `getVehicleState()`, not inferred from the absence of a fallback message.
- The vehicle actually reached the framebuffer: the probe reads back the drawing buffer and requires at least 5% of the vehicle column to be lit. Measured in this headless Chromium, that column comes back 12% lit (desktop) and 24% (mobile) with the mesh drawn, and 0.74% and 1.1% with the mesh draw call removed, so the floor sits an order of magnitude clear of a dead renderer.
- The exploded-view control moves state the renderer owns (separation target, then animated amount, then the layout event the renderer raises), not the button's own `aria-pressed` attribute. A disconnected control still sets its own attributes and still passes lint, so attributes prove nothing.
- Clicking a subsystem button changes `#selectedNodeDetail` and the renderer reports the same selection back.
- Zero console errors and zero page errors, at both viewports.
- No horizontal overflow, no scene canvas wider than the viewport, and no hard-coded inline canvas width.

The cockpit contract tests cover the arithmetic and the render path; this probe covers what only a real browser can answer.

There is no hosted CI. This local gate is the only gate, and a partial run does not count. To regenerate the checked reference result separately:

```bash
python3 engine.py data/baseline.json --output web/result.json
```

## Model contract

For leaf component `i`:

```text
usable_i = on_hand_i + sum(inbound PO qty arriving inside horizon)
```

For an assembly `a`:

```text
available_builds_a = min(available_child_i // qty_per_parent_i)
```

Target demand is expanded down the BOM. A leaf is an active constraint when usable supply is below target demand. The risk score is deliberately inspectable:

```text
50 × build_gap
+ 20 × late_order_indicator
+ 15 × min(lead_time / horizon, 2)
+ 15 × inbound_confidence_penalty        # engine.py only, see below
```

The score prioritizes work. It is not a predicted probability of failure.

### Two implementations, one authoritative

`engine.py` is authoritative for the risk score and for the checked reference result in `web/result.json`. It implements all four terms, where `inbound_confidence_penalty = 1 − supply_confidence` and `supply_confidence` is the lowest confidence among the orders for that part that land **inside** the horizon (1.0 when there are none).

The browser scenario engine in `web/app.js` implements the first three terms only. It does not track `supply_confidence`, so it omits the fourth term.

The two agree on every scenario this UI can produce, and not by luck: the fourth term is non-zero only for a leaf that is both short and expecting a discounted receipt inside the horizon, and no leaf reachable through the two levers is ever in that state. The only leaf with a discounted inbound order is the thermal tile, and pulling PO-1088 inside the horizon is exactly what clears its shortage. Swept over both levers (tile arrival day 0–60 × engines on hand 0–40), every constraint `engine.py` reports carries `supply_confidence = 1.0`, so the penalty is always zero.

This is a documented divergence, not a claim of equivalence. A wider dataset, one with a discounted receipt on a leaf that stays short, would separate the two scores, and `engine.py`'s number would be the correct one.

## IP and model boundaries

### What is synthetic

Everything in `data/baseline.json` and everything rendered from it. Part names, part numbers, categories, on-hand quantities, unit costs, lead times, purchase-order identifiers, order quantities, arrival days, confidence values, the BOM structure, the 21-day horizon, and the four-build target were authored for this demonstration. No real inventory, schedule, supplier, price, or operational record is used anywhere in this repository.

### What is modeled

- Horizon-gated supply: an inbound order counts only if it arrives on or before the horizon day.
- Quantity-per-parent propagation through a fixed multi-level BOM.
- Availability of a parent as the minimum over its children, floored to whole builds.
- Target demand expanded top-down from the build target.
- A leaf-level shortage against expanded demand, its build-gap consequence, and an inspectable priority score.
- Two what-if levers only: the thermal tile arrival day and engine assemblies on hand.

### What is not claimed

- No affiliation with, endorsement by, or representation of SpaceX or any other company. No logos, wordmarks, trade dress, CAD, telemetry, facilities, or operational data are used or implied.
- The vehicle view is a procedural, stylized depiction used as a spatial index into the synthetic BOM. It is not engineering geometry and carries no dimensional meaning.
- The risk score is a work-prioritization heuristic, not a calibrated probability of failure or delay.
- The result is not a schedule, an MRP run, a purchasing recommendation, or safety-critical guidance.
- Assembly-level on-hand stock is deliberately not credited toward parent availability. Parent availability comes from child supply only, which is a modeling simplification, not a claim about how real work-in-process is counted.

### Deliberately not modeled

This is a narrow decision-support prototype, not an MRP system. It does not model:

- supplier capacity or production yield,
- alternate parts or substitutions,
- work-center capacity and routing,
- partial assembly, work-in-process, or safety stock,
- quality holds or engineering-change effectivity,
- real aerospace hardware or proprietary operations.

Those omissions are explicit because an explainable small model is more credible than a large model whose assumptions are hidden.

## Architecture

```text
data/baseline.json
       │
       ├── engine.py ──> deterministic JSON result
       │      └── tests/test_engine.py (6 fault-oriented tests)
       │
       └── web/app.js ──> browser scenario engine + operator readout
              ├── web/bridge.js ──> web/scene.js (WebGL vehicle view)
              ├── web/shell.js ──> vehicle-view controls (layout, explode, node focus)
              └── web/index.html + styles.css
```

| File | Role |
|---|---|
| `web/app.js` | Classic script. Owns the arithmetic, the DOM readout, and the presets. Never imports the renderer. |
| `web/bridge.js` | ES module. Imports `scene.js` and publishes `window.FlowScene`. The only seam. |
| `web/scene.js` | ES module. Owns its own drawing context and all geometry. |
| `web/shell.js` | Classic script. Chrome-level controls (view mode, explode slider, subsystem buttons) that call the renderer through `window.FlowScene`. |

## 3D digital thread and the vehicle view

The vehicle view is a procedural, stylized depiction of a stainless-steel launch vehicle that acts as the spatial index into the synthetic BOM. Selecting a subsystem in the exploded view selects the same node in the deterministic result: the constraint queue, critical path, and operator readout all describe that one component. The scene is a navigation aid, not a second source of truth, and it renders nothing the arithmetic does not already contain. It is a depiction, not engineering geometry.

The renderer lives in `web/scene.js` (an ES module, import-free so GitHub Pages serves it with no build step) and reaches the rest of the page only through `web/bridge.js`, which publishes `window.FlowScene`. `scene.js` owns its own drawing context, so the depiction can be rendered with WebGL or with the 2D canvas without the cockpit changing.

Two files consume that seam, and they consume different halves of it:

- `web/app.js`, the cockpit controller, stays a classic script, never imports the renderer, and only ever sees `setScenario`, `update`, and `getSelectedNode`. That is the scenario half.
- `web/shell.js`, the vehicle-view chrome, calls `setLayout({ mode, amount })` with `setExplode(amount)` as a fallback, plus `selectNode(partId)`. That is the view half, and it never touches the scenario arithmetic.

Every call in both directions is feature-detected. `shell.js` additionally wraps each call in a try/catch and downgrades a throwing renderer to a `console.warn` and its text readout, because a renderer fault must not break the cockpit. If the module, the graphics context, or the canvas is unavailable, the renderer reports it through `#sceneFallback`, the operating view keeps running, and the critical path and exception queue carry the same answer in plain HTML.

Rendering has an explicit performance boundary: scenario arithmetic and the accessible DOM remain primary. Slider previews are coalesced to one animation-frame update, while the optional scene receives an on-demand render/update only after a scenario state is evaluated. There is no perpetual render loop required by the decision workflow.

## Operator readout

Selecting any node writes a full evidence block, not a status word. For the baseline limiting leaf it reads:

```text
Thermal protection tile — LIMITING LEAF
COMPONENT / Structures — 4,200 per thermal protection set, 42-day nominal lead time.
Supply: 12,800 on hand + 0 inbound inside day 21 = 12,800 usable against 16,800
  required for 4 builds, so short 4,000 units.
Inbound PO-1088: 5,200 units land day 34, after the 21-day horizon, so the model
  excludes them from usable supply (72% confidence).
Lead time 42 days exceeds the 21-day horizon, so a fresh buy cannot land in time.
  Recovery has to come from pulling an existing receipt inside the horizon.
Consequence: supports 3 of 4 integrated builds, a build gap of 1, $960,000 of
  synthetic shortage value.
Causal chain (builds supported at each level): thermal protection tile covers 3
  builds then thermal protection set covers 3 builds then integrated vehicle
  delivers 3 of 4. That chain is the build gap: 1 vehicle short of target.
Action: Evaluate expediting 4,000 units inside day 21.
```

Nodes that are not on the limiting path say so and name the chain that is binding instead, so the view answers "why not this one" as well as "why this one".

## 60-second demo

**Frame the decision (0–10s).** Four builds are due inside a 21-day horizon. The question is not which order is late, it is which material condition limits release. Every input is synthetic.

**Preset 01 baseline (10–24s).** Tile arrival day 34, 25 engines on hand. Result: **3 of 4 ready, gap 1, $960,000 of shortage value**, limiting leaf thermal protection tile. The causal chain: 12,800 tiles on hand against 16,800 required, PO-1088's 5,200 units land day 34 which is outside the horizon so they do not count, the thermal protection set is therefore capped at 3, and the integrated vehicle is capped at 3. **Recommendation: expedite 4,000 tiles inside day 21.** PO-1088 already covers 5,200 units, so this is a date change, not a new buy — which matters because the 42-day lead time means a fresh buy cannot land inside the horizon at all.

**Preset 02 recover (24–38s).** Hold engines at 25, pull tile arrival to day 9. Before → after: **ready 3 → 4 (+1), gap 1 → 0 (−1), shortage value $960,000 → $0**, and the limiting leaf moves from thermal protection tile to engine assembly. The baseline stays frozen as the comparison anchor. **Recommendation: release the four-build plan, but the new tightest leaf is engine assembly with exactly 1 spare unit (25 on hand against 24 required), so confirm that cover before committing.**

**Preset 03 switch the constraint (38–52s).** Hold day 9, drop engines to 22. Before → after against baseline: **ready 3 → 3 (no change), gap 1 → 1 (no change)** — the headline numbers are identical to the baseline, and that is the point. The limiting leaf has moved from thermal protection tile to engine assembly, and shortage value has risen $960,000 → $1,880,000. Engines are 2 units short of the 24 required at 6 per propulsion module, with no order on the book and a 28-day lead time against a 21-day horizon. **Recommendation: validate a recovery source for 2 engine assemblies; the thermal fix no longer helps this plan.** Solving one shortage exposes the next one.

**Close on verification (52–60s).** Open Method: a prioritization score is not a probability, the omissions are listed on purpose, and `npm run gate` is the reproducible contract that includes a real browser boot of this page.

## Responsible use and interview boundary

Flow Control is an educational decision-support prototype and rehearsal artifact. Treat its outputs as demonstrations of transparent planning logic, not as production, aerospace, or safety-critical guidance. Use it to prepare and rehearse beforehand; it must be closed during any prohibited interview or assessment where AI, outside tools, or portfolio aids are not allowed.
