import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
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
