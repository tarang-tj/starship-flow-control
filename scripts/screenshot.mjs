// Captures the README screenshot of the live demo, so the image can be re-shot
// whenever the page changes instead of going stale.
// Run: node scripts/screenshot.mjs [url]   (default: the GitHub Pages demo)
import { chromium } from "playwright";

const url = process.argv[2] ?? "https://tarang-tj.github.io/starship-flow-control/";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "load" });
  // The baseline renders on load; wait for the readout the boot probe also checks.
  await page.waitForFunction(() => document.querySelector("#readyBuilds")?.textContent.trim() === "3", null, { timeout: 30000 });
  await page.waitForTimeout(2500); // let the vehicle view settle
  await page.screenshot({ path: "docs/img/demo.png" });
  console.log(`wrote docs/img/demo.png from ${url}`);
} finally {
  await browser.close();
}
