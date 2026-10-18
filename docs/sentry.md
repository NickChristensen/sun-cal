# Sentry error reporting

Tracked by [TODO-89](https://linear.app/finely-crafted/issue/TODO-89/wire-up-sentry-error-monitoring-for-suncal). The Worker uses the official `@sentry/cloudflare` `withSentry` integration. Error events use service `sun-cal` and environment `production`. Tracing, log export, metrics, and alerts are outside this setup.

## Capture and privacy

The Worker reports its missing upstream configuration, its existing calendar-build errors, and solar cache read/write failures. Rejected UV cache writes are reported while retaining the original rejected background promise. Synchronous UV failures reach the existing calendar-build handler. Client validation failures, unknown routes, and unsupported methods do not produce events. Existing responses, retry limits, cache contents, and TTLs stay intact.

The SDK requires Cloudflare Node compatibility mode v2, enabled by the `2024-09-23` compatibility date and `nodejs_compat` flag. The solar cache namespace advances to `v4` for this runtime change, following the repository's cache-version rule. Existing entries expire naturally; each location needs one initial cache fill in the new namespace.

Each event contains a fixed diagnostic category and bounded stack locations from known application files. The transport filter reconstructs the event from an allowlist. It removes raw exception messages and names, causes, arbitrary error objects, request/response bodies, URL query values, headers, cookies, user information, breadcrumbs, attachments, arbitrary tags and contexts, and incoming trace baggage. This is necessary because the query contains location data and upstream errors can contain private data. Never add the upstream URL, calendar body, forecast, API key, or raw exception to telemetry context.

The existing HTTP error response can contain the upstream error message. This change preserves that response behavior; Sentry receives a fixed diagnostic category.

## Required production configuration

| Name | Location | Purpose |
| --- | --- | --- |
| `SENTRY_DSN` | Cloudflare Worker secret | Routes errors to the approved SunCal Sentry project. Missing configuration leaves the Worker usable without sending events. |
| `SENTRY_RELEASE` | Build/deploy environment, passed to the Worker as a nonsecret binding | Full 40-character Git commit SHA. GitHub Actions provides the exact production commit. |
| `SENTRY_LOCAL_SOURCEMAPS` | Local build environment | Set to `1` with `deploy:dry-run` to generate source maps for local review and a later approved upload. |
| `OPENUV_API_KEY` | Existing Cloudflare Worker secret | Existing upstream access; this value is never sent to Sentry. |

The matching Sentry project and DSN were not available in the supplied project inventory. Project creation and credential setup require a separate approved handoff. Record the verified project URL here after setup. No project URL or credential value is embedded in the repository.

After approval, an operator must select or create the matching SunCal project, verify its organization and project ID, and provision its DSN through the existing Cloudflare secret-management process. A DSN from another service must not be used. Do not print secret values in terminal transcripts, GitHub Actions logs, this document, or Linear.

For manual releases, set `SENTRY_RELEASE` to the full SHA of the reviewed commit used for the build. A production merge or push runs the existing deployment workflow. Merging and deploying require a separate decision; this instrumentation PR does not perform them.

## Stack traces and source maps

The filter retains known application filenames and bounded line/column positions, so stack locations remain available without exception payloads. Generated bundle frames use `app:///index.js`; already named application source frames retain their source filename. Source-map artifacts must match the exact release and retained bundle filename. Artifact upload is a separate setup step that requires approval for Sentry access.

From a clean checkout of the reviewed release commit, build local artifacts without deployment:

```sh
export SENTRY_RELEASE="$(git rev-parse HEAD)"
SENTRY_LOCAL_SOURCEMAPS=1 npm run deploy:dry-run
```

The bundle and map are `.cloudflare/output/v0/workers/default/bundle/index.js` and `index.js.map`. Both are ignored by Git. A normal build leaves source-map upload disabled. Setting `SENTRY_LOCAL_SOURCEMAPS=1` on a real deployment would also enable Cloudflare's source-map upload, so use the flag with the dry-run command until that upload is approved.

Required upload configuration names are `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_RELEASE`. The token belongs in the approved upload environment and must never become a Worker binding. Confirm the correct project and review access scope before provisioning ongoing credentials. No source maps are uploaded by the PR validation job or this task.

This configuration uses Sentry's supported [release-based artifact matching](https://docs.sentry.io/platforms/javascript/sourcemaps/troubleshooting_js/legacy-uploading-methods/) because it does not inject debug IDs into the deployed bundle. After approval, create or verify the release in the selected project and use the Sentry CLI in the approved environment to upload the artifacts from that exact build with matching release and prefix:

```sh
sentry-cli releases new "$SENTRY_RELEASE" \
  --org "$SENTRY_ORG" --project "$SENTRY_PROJECT"
sentry-cli sourcemaps upload \
  --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" \
  --release "$SENTRY_RELEASE" --url-prefix 'app:///' \
  .cloudflare/output/v0/workers/default/bundle
```

Verify a controlled event resolves to the original application file and line after upload. A local review of this change exercised the generated Worker through a blocked outbound transport and mapped its retained bundle positions back to `src/index.ts` with the generated map. This verifies local build compatibility; external upload and Sentry symbolication remain unverified.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run deploy:dry-run`. The Sentry tests execute the real Worker and SDK against a local transport with inert credentials. They inspect complete envelopes for routing, environment, release, one report per failure, and removal of private test markers. They also check existing response behavior and disabled capture without configuration. Network destinations are blocked or handled by local fixtures; the suite does not send an event to Sentry.

After the approved setup and deployment, exercise a controlled failure in a separate test environment through the same Worker entry point. Use synthetic data and verify the project, `production` environment, commit release, redaction, and readable stack in Sentry before recording the issue link. Do not add a public production test route. This task does not claim live-event verification or completion of the production setup portion of TODO-89.
