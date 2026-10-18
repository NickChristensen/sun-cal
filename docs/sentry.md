# Sentry error reporting

Tracked by [TODO-89](https://linear.app/finely-crafted/issue/TODO-89/wire-up-sentry-error-monitoring-for-suncal). The Worker uses the official `@sentry/cloudflare` `withSentry` integration. Error events use service `sun-cal` and environment `production`. Tracing, log export, metrics, and alerts are outside this setup.

## Capture and privacy

The Worker reports its missing upstream configuration, its existing calendar-build errors, and solar cache read/write failures. Rejected UV cache writes are reported while retaining the original rejected background promise. Synchronous UV failures reach the existing calendar-build handler. Client validation failures, unknown routes, and unsupported methods do not produce events. Existing responses, retry limits, cache contents, and TTLs stay intact.

The SDK requires Cloudflare Node compatibility mode v2, enabled by the `2024-09-23` compatibility date and `nodejs_compat` flag. The solar cache namespace advances to `v4` for this runtime change, following the repository's cache-version rule. Existing entries expire naturally; each location needs one initial cache fill in the new namespace.

Each event contains a fixed diagnostic category and bounded stack locations from known application files. The transport filter reconstructs the event from an allowlist. It removes raw exception messages and names, causes, arbitrary error objects, request/response bodies, URL query values, headers, cookies, user information, breadcrumbs, attachments, arbitrary tags and contexts, and incoming trace baggage. This is necessary because the query contains location data and upstream errors can contain private data. Never add the upstream URL, calendar body, forecast, API key, or raw exception to telemetry context.

The existing HTTP error response can contain the upstream error message. This change preserves that response behavior; Sentry receives a fixed diagnostic category.

## Production configuration and exact-build source maps

The Sentry project is **sun-cal** (ID **4512279041212416**) in organization **nick-3u**, owned by the existing **#nick** team: [project events](https://nick-3u.sentry.io/issues/?project=4512279041212416). The project uses JavaScript error monitoring. Alert configuration and automatic Linear tickets are maintained separately.

Configure these GitHub Actions values before merging:

| Name | Storage | Purpose |
| --- | --- | --- |
| `SENTRY_PROJECT` | Repository variable | Must equal `sun-cal`; the helper refuses another service's project. |
| `SENTRY_DSN` | Repository variable | The approved public SDK ingestion DSN, validated against the exact organization host and project ID. It grants ingestion only, not privileged Sentry API access. |
| `SENTRY_AUTH_TOKEN` | Repository secret | Owner-provisioned CI upload credential. Approved scope is `org:ci` for source-map uploads, release creation, and code mappings across `nick-3u`. Never expose it to the Worker, repository files, logs, or pull-request validation. |

GitHub Actions installs the DSN as the Worker's **`SENTRY_DSN` secret binding** with the same production code deployment. It generates a Git-ignored mode-600 `.sentry-build/runtime-secrets.json` and supplies `--secrets-file` to the deploy command. Existing Worker secrets are preserved. This avoids a separate `secret put`, which would immediately deploy a configuration-only Worker version before the production gates were satisfied. A staged repository variable is not evidence that the binding is live; verify the active version after deployment. Do not print DSN values in task output.

`node scripts/sentry-release.mjs configure` validates the approved organization and project mapping without printing the DSN. The production job runs it before the final build. `prepare` builds the production bundle and private source map once, validates map completeness, and hashes the build output, static assets, and staged runtime configuration. Pull-request validation runs `prepare` without credentials or uploads.

The production-only `upload` step uses pinned `@sentry/cli@3.8.0`, fixed organization `nick-3u`, the selected project, the exact runtime release, and canonical bundle URI `app:///index.js`. It validates the maps, fails on upload errors, and waits for Sentry processing. It does not inject debug IDs or modify the deployed bundle. Source maps contain repository and dependency source code; their upload to Sentry and the private map modules sent to Cloudflare require owner approval.

After upload, `verify` checks all artifact/runtime hashes again. GitHub Actions rechecks the production branch head, then deploys the prepared output without rebuilding (`cf deploy --prebuilt`, or a generated Wrangler configuration with the custom build command removed). Missing configuration, an upload failure, or changed artifacts prevents deployment. A newer production head skips deployment. The upload token is available only in the upload step.

For credential-free local review, run `node scripts/sentry-release.mjs prepare` and `node scripts/sentry-release.mjs verify` under Node 22. Generated manifests, maps, prebuilt configuration, and runtime-secret files remain ignored by Git. Do not add the privileged upload token to local test fixtures.

After deployment, correlate the GitHub production commit/release with the active Cloudflare version, verify `SENTRY_DSN` exists on that version, and use bounded non-mutating smoke checks. Confirm ingestion and readable original file/line/function frames with safe sanitized synthetic data only where feasible. Do not add a public test route, transmit user payloads, induce user-visible failures, or change business behavior. Builds, upload completion, and local intercepted fixtures alone do not prove live ingestion or server-side symbolication.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run deploy:dry-run`. The Sentry tests execute the real Worker and SDK against a local transport with inert credentials. They inspect complete envelopes for routing, environment, release, one report per failure, and removal of private test markers. They also check existing response behavior and disabled capture without configuration. Network destinations are blocked or handled by local fixtures; the suite does not send an event to Sentry.

After configuration and deployment, exercise a controlled failure in a separate test environment through the same Worker entry point. Use synthetic data and verify the project, `production` environment, commit release, redaction, and readable stack in Sentry before recording the issue link. Do not add a public production test route. This task does not claim live-event verification or completion of the production setup portion of TODO-89.
