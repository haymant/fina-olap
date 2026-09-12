import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "..", "data", "sample.parquet");
const PORT = 3100;
const API = 8787;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `uv --directory .. run uvicorn fina_olap.server:app --host 127.0.0.1 --port ${API}`,
      url: `http://127.0.0.1:${API}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { FINA_OLAP_FIXTURE: fixture },
    },
    {
      command: `npx next dev -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});