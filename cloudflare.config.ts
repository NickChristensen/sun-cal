import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "sun-cal",
    workersDev: true,
    compatibilityDate: "2024-06-01",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    env: {
      OPENUV_API_KEY: bindings.secret(),
    },
  },
});
