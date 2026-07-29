import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
    const path = normalize(join(root, pathname));
    assert.ok(path.startsWith(root), "request escaped repository root");
    const body = await readFile(path);
    response.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404); response.end("not found");
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;

// Fraction of the vehicle column that must come back brighter than BRIGHT for
// the launch vehicle to count as rasterised. Measured in this headless
// Chromium: 12% (desktop) and 24% (mobile) with the mesh drawn, 0.5% and 1.1%
// with the mesh draw call removed, so the bar sits an order of magnitude clear
// of a dead renderer and half an order below a live one.
const BRIGHT = 0.30;
const MIN_PAINTED = 0.05;
// The vehicle occupies the left of the canvas; the right is the callout column,
// which still paints when the mesh does not.
const VEHICLE_COLUMN = 0.62;

// Reads the drawing buffer from inside a rAF callback queued AFTER the
// renderer's own, so the sample is taken before the frame is composited (the
// context is not preserveDrawingBuffer, so a later read would come back blank).
// A separation transition is started first, which guarantees the renderer has a
// frame in flight and keeps re-scheduling itself for the frames sampled here.
function samplePaint({ bright, column, frames }) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.querySelector("#sceneCanvas");
      if (!canvas) throw new Error("#sceneCanvas is missing");
      window.FlowScene.setExplode(0.85);
      const off = document.createElement("canvas");
      off.width = canvas.width;
      off.height = canvas.height;
      const ctx = off.getContext("2d");
      if (!ctx) throw new Error("no 2d context for the pixel readback");
      let best = { painted: 0, mean: 0 };
      let left = frames;
      const sample = () => {
        try {
          const width = Math.max(1, Math.round(canvas.width * column));
          ctx.clearRect(0, 0, off.width, off.height);
          ctx.drawImage(canvas, 0, 0);
          const { data } = ctx.getImageData(0, 0, width, canvas.height);
          let painted = 0;
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) {
            const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
            sum += lum;
            if (lum >= bright) painted += 1;
          }
          const total = data.length / 4;
          const frame = { painted: painted / total, mean: sum / total, width, height: canvas.height };
          if (frame.painted > best.painted) best = frame;
          left -= 1;
          if (left > 0) requestAnimationFrame(sample);
          else resolve(best);
        } catch (error) { reject(error); }
      };
      requestAnimationFrame(sample);
    } catch (error) { reject(error); }
  });
}

// Waits for renderer-owned state to reach `predicate`, and reports what the
// renderer actually held when it does not, so a dead seam names itself instead
// of failing as a bare timeout.
async function settle(page, predicate, message, timeout = 5000) {
  try {
    await page.waitForFunction(predicate, null, { timeout });
  } catch {
    const state = await page.evaluate(() => window.FlowScene?.getVehicleState?.());
    assert.fail(`${message} (renderer state: ${JSON.stringify(state)})`);
  }
}

let browser;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({ headless: true, executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/web/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("#readyBuilds")?.textContent === "3");
    await page.locator('[data-preset="recover"]').click();
    assert.equal(await page.locator("#readyBuilds").textContent(), "4");
    await page.locator('[data-preset="switch"]').click();
    assert.match(await page.locator("#criticalPath").textContent(), /engine/i);

    // Integration ground truth. Every assertion below reads state the RENDERER
    // owns, or the pixels it produced: a seam that reports its own arguments
    // back, or a renderer that never rasterises, has to fail here.
    const label = `${viewport.width}x${viewport.height}`;
    await page.evaluate(() => {
      window.__layoutEvents = [];
      window.FlowScene.onVehicleChange((layout) => window.__layoutEvents.push(layout));
    });
    const replay = await page.evaluate(() => window.__layoutEvents[0]);
    assert.ok(replay, `${label}: onVehicleChange did not replay the current layout on registration`);
    assert.deepEqual(
      Object.keys(replay).sort(), ["exploded", "explodeAmount", "selectedId"].sort(),
      `${label}: onVehicleChange payload shape changed`,
    );

    const boot = await page.evaluate(() => window.FlowScene?.getVehicleState?.());
    assert.ok(boot?.available, `${label}: the renderer never came up`);
    assert.equal(boot.renderer, "webgl", `${label}: expected the WebGL renderer, got ${boot.renderer}`);

    // The launch vehicle must actually reach the framebuffer.
    const paint = await page.evaluate(samplePaint, { bright: BRIGHT, column: VEHICLE_COLUMN, frames: 4 });
    assert.ok(
      paint.painted >= MIN_PAINTED,
      `${label}: the vehicle did not rasterise; only ${(paint.painted * 100).toFixed(2)}% of the `
      + `${paint.width}x${paint.height} vehicle column is lit (mean luminance ${paint.mean.toFixed(3)}, floor ${MIN_PAINTED * 100}%)`,
    );

    // The shell's exploded control must move renderer-owned state, not just its
    // own aria attributes, and the eased transition must land on the target.
    await page.evaluate(() => window.FlowScene.setLayout({ mode: "integrated" }));
    await settle(
      page, () => window.FlowScene.getVehicleState().explodeAmount === 0,
      `${label}: setLayout({ mode: "integrated" }) never reached the renderer`,
    );
    // Only events raised by the control itself count as proof it reached the renderer.
    await page.evaluate(() => { window.__layoutEvents = []; });
    await page.locator('[data-scene-layout="exploded"]').click();
    await settle(
      page, () => window.FlowScene.getVehicleState().explodeTarget > 0.5,
      `${label}: the exploded control never set a separation target on the renderer`,
    );
    await settle(
      page, () => window.FlowScene.getVehicleState().explodeAmount > 0.5,
      `${label}: the renderer never animated out to the separation target`,
    );
    const separated = await page.evaluate(() => window.FlowScene.getVehicleState());
    assert.equal(separated.exploded, true, `${label}: the exploded control did not reach the renderer`);
    assert.ok(separated.explodeAmount > 0.5, `${label}: the renderer never separated the stack`);
    assert.ok(
      (await page.evaluate(() => window.__layoutEvents)).some((event) => event.explodeAmount > 0.5),
      `${label}: the renderer did not announce the exploded layout`,
    );

    // Selection has to propagate into the renderer and back out to the readout.
    const before = await page.locator("#selectedNodeDetail").textContent();
    await page.locator('[data-scene-node="PROP-MODULE"]').click();
    const after = await page.locator("#selectedNodeDetail").textContent();
    assert.notEqual(after, before, "selecting a subsystem did not update the readout");
    assert.equal(
      await page.evaluate(() => window.FlowScene.getVehicleState().selectedId), "PROP-MODULE",
      `${label}: the renderer did not take the selection`,
    );
    assert.equal(
      await page.evaluate(() => window.__layoutEvents.at(-1).selectedId), "PROP-MODULE",
      `${label}: the renderer did not announce the selection`,
    );

    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
      scene: document.querySelector("#sceneCanvas")?.getBoundingClientRect().width,
      inlineWidth: document.querySelector("#sceneCanvas")?.style.width,
    }));
    assert.equal(errors.length, 0, errors.join("\n"));
    assert.ok(layout.scroll <= layout.viewport, `horizontal overflow: ${layout.scroll} > ${layout.viewport}`);
    assert.ok(layout.scene <= layout.viewport, `scene overflow: ${layout.scene} > ${layout.viewport}`);
    assert.equal(layout.inlineWidth, "", "scene canvas width must remain responsive");
    await page.close();
  }
  console.log("boot contract: desktop/mobile scenarios, live webgl renderer, painted vehicle, renderer-owned layout state, console, and responsive layout passed");
} finally {
  await browser?.close();
  server.close();
}
