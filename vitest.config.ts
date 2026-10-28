import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Decorator transform for @callable()
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests never hit real Workers AI; AI calls are mocked per test
      remoteBindings: false
    })
  ],
  test: {
    include: ["test/**/*.test.ts"]
  }
});
