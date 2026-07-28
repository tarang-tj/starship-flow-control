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

## Test and regenerate the reference result

```bash
python3 -m unittest discover -s tests -v
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

## 60-second demo

1. Baseline: 4 target builds, 3 ready. Thermal tiles arrive after the 21-day horizon.
2. Move tile arrival from day 34 to day 9 and run: the target clears.
3. Reduce engine inventory to 22 and run: the limiting path switches to propulsion.
4. Open Method: explain assumptions, deterministic arithmetic, and what is intentionally not modeled.

## Responsible use

Flow Control is an educational decision-support prototype. Treat its outputs as demonstrations of transparent planning logic, not as production, aerospace, or safety-critical guidance.
