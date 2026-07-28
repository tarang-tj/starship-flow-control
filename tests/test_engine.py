import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine import evaluate, load_scenario  # noqa: E402


class ConstraintEngineTests(unittest.TestCase):
    def setUp(self):
        self.baseline = load_scenario(ROOT / "data" / "baseline.json")

    def test_engine_propagates_leaf_shortage_to_parent_builds(self):
        result = evaluate(self.baseline)
        heat_shield = result["parts_by_id"]["HEAT-SHIELD"]
        vehicle = result["parts_by_id"]["VEHICLE"]
        self.assertLess(heat_shield["available_builds"], 4)
        self.assertEqual(vehicle["available_builds"], heat_shield["available_builds"])
        self.assertIn("TPS-TILE", vehicle["constraint_path"])

    def test_arrivals_inside_horizon_count_but_late_arrivals_do_not(self):
        result = evaluate(self.baseline)
        valves = result["parts_by_id"]["METHANE-VALVE"]
        tiles = result["parts_by_id"]["TPS-TILE"]
        self.assertGreater(valves["usable_in_horizon"], valves["on_hand"])
        self.assertEqual(tiles["usable_in_horizon"], tiles["on_hand"])

    def test_expediting_constraint_improves_readiness_without_mutating_input(self):
        baseline_copy = json.loads(json.dumps(self.baseline))
        base_result = evaluate(self.baseline)
        scenario = json.loads(json.dumps(self.baseline))
        for order in scenario["purchase_orders"]:
            if order["part_id"] == "TPS-TILE":
                order["arrival_day"] = 9
        improved = evaluate(scenario)
        self.assertGreater(improved["summary"]["ready_builds"], base_result["summary"]["ready_builds"])
        self.assertEqual(self.baseline, baseline_copy)

    def test_risk_score_prioritizes_build_impact_and_recovery_gap(self):
        scenario = json.loads(json.dumps(self.baseline))
        next(part for part in scenario["parts"] if part["id"] == "ENGINE")["on_hand"] = 22
        result = evaluate(scenario)
        ranked = result["constraints"]
        self.assertGreaterEqual(len(ranked), 2)
        self.assertGreaterEqual(ranked[0]["risk_score"], ranked[1]["risk_score"])
        self.assertTrue(all(row["build_gap"] > 0 for row in ranked))

    def test_unknown_bom_reference_fails_loud(self):
        broken = json.loads(json.dumps(self.baseline))
        broken["bom"][0]["children"].append({"part_id": "MISSING", "qty": 1})
        with self.assertRaisesRegex(ValueError, "Unknown part"):
            evaluate(broken)

    def test_cycle_in_bom_fails_loud(self):
        broken = json.loads(json.dumps(self.baseline))
        broken["bom"].append({"parent_id": "TPS-TILE", "children": [{"part_id": "VEHICLE", "qty": 1}]})
        with self.assertRaisesRegex(ValueError, "cycle"):
            evaluate(broken)


if __name__ == "__main__":
    unittest.main()
