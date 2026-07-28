#!/usr/bin/env python3
"""Deterministic multi-level BOM readiness engine for a synthetic demo."""
from __future__ import annotations

import argparse
import json
import math
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Set


def load_scenario(path: Path) -> Dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _validate(data: Dict[str, Any]) -> None:
    required = {"meta", "parts", "bom", "purchase_orders"}
    missing = required - set(data)
    if missing:
        raise ValueError(f"Missing top-level fields: {sorted(missing)}")
    ids = [p["id"] for p in data["parts"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Part IDs must be unique")
    known = set(ids)
    for row in data["bom"]:
        if row["parent_id"] not in known:
            raise ValueError(f"Unknown part: {row['parent_id']}")
        for child in row["children"]:
            if child["part_id"] not in known:
                raise ValueError(f"Unknown part: {child['part_id']}")
            if child["qty"] <= 0:
                raise ValueError("BOM quantities must be positive")
    for order in data["purchase_orders"]:
        if order["part_id"] not in known:
            raise ValueError(f"Unknown part: {order['part_id']}")
        if order["qty"] < 0 or order["arrival_day"] < 0:
            raise ValueError("Order quantity and arrival day must be non-negative")


def evaluate(raw: Dict[str, Any]) -> Dict[str, Any]:
    data = deepcopy(raw)
    _validate(data)
    horizon = int(data["meta"]["horizon_days"])
    target = int(data["meta"]["target_builds"])
    parts = {p["id"]: deepcopy(p) for p in data["parts"]}
    children = {row["parent_id"]: row["children"] for row in data["bom"]}
    inbound: Dict[str, int] = {part_id: 0 for part_id in parts}
    late: Dict[str, int] = {part_id: 0 for part_id in parts}
    confidence: Dict[str, float] = {part_id: 1.0 for part_id in parts}
    for order in data["purchase_orders"]:
        bucket = inbound if order["arrival_day"] <= horizon else late
        bucket[order["part_id"]] += int(order["qty"])
        if order["arrival_day"] <= horizon:
            confidence[order["part_id"]] = min(confidence[order["part_id"]], float(order.get("confidence", 1)))

    visiting: Set[str] = set()
    memo: Dict[str, Dict[str, Any]] = {}

    def solve(part_id: str) -> Dict[str, Any]:
        if part_id in memo:
            return memo[part_id]
        if part_id in visiting:
            raise ValueError(f"BOM cycle detected at {part_id}")
        visiting.add(part_id)
        part = parts[part_id]
        on_hand = int(part.get("on_hand", 0))
        usable = on_hand + inbound[part_id]
        if part_id not in children:
            answer = {
                **part,
                "on_hand": on_hand,
                "inbound_in_horizon": inbound[part_id],
                "late_inbound": late[part_id],
                "usable_in_horizon": usable,
                "available_builds": usable,
                "constraint_path": [part_id],
                "supply_confidence": confidence[part_id],
            }
        else:
            candidate = []
            for child in children[part_id]:
                child_result = solve(child["part_id"])
                builds = child_result["available_builds"] // int(child["qty"])
                candidate.append((builds, child_result, int(child["qty"])))
            limiting_builds, limiting, _ = min(candidate, key=lambda row: (row[0], row[1]["supply_confidence"]))
            answer = {
                **part,
                "on_hand": on_hand,
                "inbound_in_horizon": inbound[part_id],
                "late_inbound": late[part_id],
                "usable_in_horizon": usable,
                "available_builds": int(limiting_builds),
                "constraint_path": [part_id] + limiting["constraint_path"],
                "supply_confidence": min(row[1]["supply_confidence"] for row in candidate),
            }
        visiting.remove(part_id)
        memo[part_id] = answer
        return answer

    root = "VEHICLE" if "VEHICLE" in parts else next(iter(parts))
    root_result = solve(root)

    demand: Dict[str, int] = {part_id: 0 for part_id in parts}
    demand[root] = target

    def propagate(parent_id: str, units: int) -> None:
        for child in children.get(parent_id, []):
            child_units = units * int(child["qty"])
            demand[child["part_id"]] += child_units
            propagate(child["part_id"], child_units)

    propagate(root, target)
    constraints: List[Dict[str, Any]] = []
    for part_id, required in demand.items():
        if required <= 0 or part_id in children:
            continue
        part = memo[part_id]
        gap = max(0, required - part["usable_in_horizon"])
        if gap == 0:
            continue
        per_build = required / target if target else required
        build_gap = int(math.ceil(gap / per_build)) if per_build else 0
        lateness = 1 if part["late_inbound"] else 0
        lead_factor = min(float(part.get("lead_time_days", 0)) / max(horizon, 1), 2)
        confidence_penalty = 1 - float(part["supply_confidence"])
        risk_score = round(50 * build_gap + 20 * lateness + 15 * lead_factor + 15 * confidence_penalty, 1)
        constraints.append({
            **part,
            "required_for_target": required,
            "shortage_units": gap,
            "build_gap": build_gap,
            "risk_score": risk_score,
            "recovery_action": _action(part, gap, horizon),
        })
    constraints.sort(key=lambda row: (-row["risk_score"], row["id"]))

    values = list(memo.values())
    return {
        "meta": data["meta"],
        "summary": {
            "target_builds": target,
            "ready_builds": min(target, int(root_result["available_builds"])),
            "build_gap": max(0, target - int(root_result["available_builds"])),
            "constraints": len(constraints),
            "at_risk_value": int(sum(c["shortage_units"] * float(c.get("unit_cost", 0)) for c in constraints)),
            "horizon_days": horizon,
        },
        "root": root_result,
        "parts": values,
        "parts_by_id": memo,
        "constraints": constraints,
        "purchase_orders": data["purchase_orders"],
        "assumptions": [
            "All quantities, suppliers, lead times, costs, and build structure are synthetic.",
            "An inbound order counts only when its scheduled arrival is inside the planning horizon.",
            "No yield loss, substitutions, capacity constraints, or partial assembly credit are modeled.",
            "Risk score is a transparent prioritization heuristic, not a probability of failure."
        ],
    }


def _action(part: Dict[str, Any], shortage: int, horizon: int) -> str:
    if part["late_inbound"] >= shortage:
        return f"Evaluate expediting {shortage:,} units inside day {horizon}."
    if part.get("lead_time_days", 0) > horizon:
        return f"Open dual-source / substitute review for {shortage:,} units; normal lead time exceeds horizon."
    return f"Pull in or procure {shortage:,} units; validate supplier commit date."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = evaluate(load_scenario(args.scenario))
    payload = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)


if __name__ == "__main__":
    main()
