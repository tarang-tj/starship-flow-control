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

test("scenario presets are explicit, immutable decision inputs", () => {
  assert.match(app, /Object\.freeze\(\{\s*baseline:\s*Object\.freeze\(\{\s*day:\s*34,\s*engines:\s*25\s*\}\)/s);
  assert.match(app, /recover:\s*Object\.freeze\(\{\s*day:\s*9,\s*engines:\s*25\s*\}\)/s);
  assert.match(app, /switch:\s*Object\.freeze\(\{\s*day:\s*9,\s*engines:\s*22\s*\}\)/s);
  assert.match(app, /structuredClone\(baseline\)/);
});

test("slider previews are frame-throttled and announce a decision narrative", () => {
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /cancelAnimationFrame/);
  assert.match(app, /before.*after|beforeAfter/is);
  assert.match(app, /recommend/i);
  assert.match(app, /aria-live/);
});

test("optional 3D scene and future narrative elements cannot break the core view", () => {
  assert.match(app, /window\.FlowScene/);
  assert.match(app, /\?\.(?:render|update|setScenario)/);
  assert.match(app, /selectedNodeDetail/);
  assert.match(app, /statusAnnouncement/);
  assert.match(app, /if\s*\(.*\).*textContent/s);
});

test("dynamic fixture rendering uses DOM text APIs instead of HTML interpolation", () => {
  assert.doesNotMatch(app, /\.innerHTML\s*=\s*r\.(?:constraints|orders|root)/);
  assert.match(app, /createElement/);
  assert.match(app, /textContent/);
});

test("README carries the rehearsal story, digital thread, performance boundary, and exact gate", () => {
  return readFile(new URL("../README.md", import.meta.url), "utf8").then((readme) => {
    assert.match(readme, /60-second demo/i);
    assert.match(readme, /3D digital thread/i);
    assert.match(readme, /on-demand render/i);
    assert.match(readme, /npm run gate/);
    assert.match(readme, /closed.*prohibited interview|prohibited interview.*closed/is);
  });
});
