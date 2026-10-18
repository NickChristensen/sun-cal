import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  types: {
    generate: false,
  },
  // This opt-in builds local maps for review. Production deployments remain
  // source-map-free unless an operator explicitly sets this variable.
  uploadSourceMaps: process.env.SENTRY_LOCAL_SOURCEMAPS === "1",
});
