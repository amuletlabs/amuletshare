import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm db:migrate:local && pnpm dev",
    url: "http://127.0.0.1:8787/health",
    reuseExistingServer: true,
    timeout: 60_000,
    env: { WRANGLER_LOG_PATH: "/tmp/share-playwright-wrangler.log" },
  },
});
