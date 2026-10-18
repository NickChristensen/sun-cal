import { bindings, defineConfig } from "cf/config";

const release = process.env.SENTRY_RELEASE;
if (release !== undefined && !/^[\da-f]{40}$/i.test(release)) {
  throw new Error("SENTRY_RELEASE must be a full Git commit SHA");
}

export default defineConfig({
  worker: {
    name: "sun-cal",
    workersDev: true,
    compatibilityDate: "2024-09-23",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "src/index.ts",
    env: {
      OPENUV_API_KEY: bindings.secret(),
      SENTRY_DSN: bindings.secret(),
      ...(release ? { SENTRY_RELEASE: bindings.text(release.toLowerCase()) } : {}),
    },
  },
});
