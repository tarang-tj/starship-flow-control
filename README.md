# Flow Control

A deterministic, multi-level bill-of-materials constraint radar built as an independent supply-chain operations demonstration.

**Live demo:** https://tarang-tj.github.io/starship-flow-control/

> All quantities, component names, costs, lead times, purchase orders, and build structures in this repository are synthetic. This project is not affiliated with or endorsed by SpaceX and does not represent SpaceX operations.

## Why this exists

A planning dashboard that only lists late purchase orders misses the important question: which late or short component actually limits the integrated build plan? Flow Control propagates leaf-level material availability through a multi-level BOM, surfaces the limiting path, and lets an operator compare recovery scenarios without changing the baseline.

## What it does

- Converts on-hand inventory and inbound purchase orders into usable supply inside a planning horizon.
- Recursively computes available parent assemblies from child quantities.
- Propagates a limiting leaf component to the integrated vehicle.
- Ranks target-plan shortages with a transparent impact heuristic.
- Provides two what-if levers: arrival timing and engine inventory.
- Fails loudly on unknown BOM references and cycles.

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

The gate runs ESLint, the deterministic Python model tests, browser-contract tests, and asset verification. To regenerate the checked reference result separately:

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
+ 15 × inbound_confidence_penalty
```

The score prioritizes work. It is not a predicted probability of failure.

## Deliberate boundaries

This is a narrow decision-support prototype, not an MRP system. It does not model:

- supplier capacity or production yield,
- alternate parts or substitutions,
- work-center capacity and routing,
- partial assembly or safety stock,
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
       └── web/app.js ──> browser scenario engine
              └── web/index.html + styles.css
```

## 3D digital thread

The optional 3D scene is a digital-thread navigation aid, not a second source of truth. A selected node links the visible vehicle/assembly/component to the same deterministic BOM result shown in the constraint queue, critical path, and order board. If the scene module or canvas is unavailable, the operating view still runs; future selected-node detail regions receive concise synthetic fixture text when present.

Rendering has an explicit performance boundary: scenario arithmetic and the accessible DOM remain primary. Slider previews are coalesced to one animation-frame update, while the optional scene receives an on-demand render/update only after a scenario state is evaluated. There is no perpetual render loop required by the decision workflow.

## 60-second demo

1. **Frame the decision (0–10s):** four builds are due inside 21 days; ask which material condition limits release. All inputs are synthetic.
2. **Read baseline (10–22s):** day 34 / 25 engines yields 3 ready versus 4 target. Trace the limiting leaf through the digital thread and state the operator recommendation.
3. **Recover (22–37s):** move tile arrival to day 9 while holding engines at 25. The live preview reports the explicit before → after delta: readiness rises and the gap clears. The frozen baseline remains the comparison anchor.
4. **Switch the constraint (37–50s):** hold day 9 and reduce engines to 22. The limiting path moves to propulsion, showing why solving one shortage can expose the next constraint.
5. **Close on verification (50–60s):** open Method, distinguish a prioritization score from a probability, name the model omissions, and cite `npm run gate` as the reproducible contract.

## Responsible use and interview boundary

Flow Control is an educational decision-support prototype and rehearsal artifact. Treat its outputs as demonstrations of transparent planning logic, not as production, aerospace, or safety-critical guidance. Use it to prepare and rehearse beforehand; it must be closed during any prohibited interview or assessment where AI, outside tools, or portfolio aids are not allowed.
