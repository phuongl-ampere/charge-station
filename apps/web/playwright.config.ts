import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command:
      "NODE_OPTIONS=--localstorage-file=/tmp/charge-station-playwright.localstorage NEXT_PUBLIC_API_URL=http://localhost:4000 NEXT_PUBLIC_MOCK_SOCKET=1 pnpm build && NODE_OPTIONS=--localstorage-file=/tmp/charge-station-playwright.localstorage NEXT_PUBLIC_API_URL=http://localhost:4000 NEXT_PUBLIC_MOCK_SOCKET=1 pnpm start --hostname 127.0.0.1 --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
  },
});
