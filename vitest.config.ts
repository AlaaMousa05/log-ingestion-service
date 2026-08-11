import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Repository and HTTP tests deliberately share the integration database.
    fileParallelism: false,
  },
});
