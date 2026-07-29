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
  console.log("boot contract: desktop/mobile scenarios, console, and responsive layout passed");
} finally {
  await browser?.close();
  server.close();
}
