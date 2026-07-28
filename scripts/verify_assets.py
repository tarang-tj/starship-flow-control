#!/usr/bin/env python3
"""Repository-native deterministic and static asset verification."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"ASSET CONTRACT FAILED: {message}")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        generated = Path(tmp) / "result.json"
        subprocess.run(
            ["python3", "engine.py", "data/baseline.json", "--output", str(generated)],
            cwd=ROOT,
            check=True,
        )
        expected = json.loads((ROOT / "web/result.json").read_text(encoding="utf-8"))
        actual = json.loads(generated.read_text(encoding="utf-8"))
        require(actual == expected, "web/result.json is stale; regenerate it with engine.py")
        require(actual["summary"]["ready_builds"] == 3, "baseline readiness must remain 3")
        require(actual["summary"]["target_builds"] == 4, "baseline target must remain 4")
        require(actual["root"]["constraint_path"][-1] == "TPS-TILE", "baseline constraint must end at TPS-TILE")

    root_html = (ROOT / "index.html").read_text(encoding="utf-8")
    page = (ROOT / "web/index.html").read_text(encoding="utf-8")
    require("web/" in root_html, "root entry point must route to web/")
    require("../data/baseline.json" in (ROOT / "web/app.js").read_text(encoding="utf-8"), "browser scenario source missing")
    require("Not affiliated with or endorsed by SpaceX" in page, "non-affiliation disclosure missing")
    print("asset contract: deterministic output, baseline assertions, entry point, and disclosures passed")


if __name__ == "__main__":
    main()
