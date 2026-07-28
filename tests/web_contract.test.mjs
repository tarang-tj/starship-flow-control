import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

const requiredIds = [
  "main", "horizonLabel", "tileArrival", "engineStock", "runBtn", "resetBtn",
  "readyBuilds", "targetBuilds", "buildGap", "constraintCount", "riskValue",
  "constraintList", "criticalPath", "ordersBody", "methodDialog"
];
const boundIds = requiredIds.filter((id) => id !== "main");

test("the operating view preserves every required interaction contract", () => {
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const id of boundIds) {
    assert.match(app, new RegExp(`\\$\\(['\"]${id}['\"]\\)`), `app does not bind #${id}`);
  }
});

test("the public interface states synthetic data and non-affiliation", () => {
  assert.match(html, /synthetic/i);
  assert.match(html, /Not affiliated with or endorsed by SpaceX/i);
});

test("the app fails visibly when scenario loading fails", () => {
  assert.match(app, /MODEL LOAD FAILED/);
  assert.match(app, /console\.error/);
});
