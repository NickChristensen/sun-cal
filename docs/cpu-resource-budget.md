# QA resource budget

This budget applies to the synthetic CPU experiments. The production Worker remains unchanged. Its production bindings are never attached to a QA Worker.

## Resumed fold-search phase, November 1, 2026

Two same-endpoint runs used 672 HTTP requests and two QA code uploads. The preflight cap was 674 requests, so two requests remain unused. Each run sent 336 requests and passed its response checks. QA Workers used the configured 500 ms CPU cap, empty bindings, and empty schedules. The uploaded versions were `299dc967-bd50-46e9-9a7f-93ff12330ed1` and `02d06f98-2ce6-45b2-a43d-aa608abbd3c4`.

| Operation | Per run | Two-run phase |
| --- | ---: | ---: |
| Synthetic cache matches | 576 | 1,152 |
| Synthetic cache puts | 216 | 432 |
| Mocked OpenUV calls | 216 | 432 |
| Mocked Sentry sends | 16 | 32 |
| Actual D1 reads or writes | 0 | 0 |
| Actual R2 operations | 0 | 0 |
| Actual Durable Object storage operations | 0 | 0 |
| Actual native Cache API operations | 0 | 0 |
| Actual OpenUV calls | 0 | 0 |
| Actual Sentry calls | 0 | 0 |

The saved Worker events contain 5,560 ms CPU in the first run and 6,201 ms in the crossed run. These sums include returned warmup events. Thirteen event records are missing across the two runs: ten measured requests and three warmups. The configured cap reserves 6,500 ms for those gaps. The observed CPU sum plus that reserve is 18,261 ms.

The 22 log queries used so far count toward the 80-query preflight limit. The named-zone sampling audit scanned 2,202,948 log rows and 154,697,888 bytes. The scoped diagnostic scanned 1,172,035 log rows and 97,781,139 bytes. The earlier 20 compact query responses did not retain scan statistics, so cumulative scanned rows and bytes are unknown. These are Workers Observability scans, not D1 reads. No further broad query ran. A denser collector is in development and did not run in this phase.

The November 1 cumulative ceiling remains $0.02. The executed phase uses the conservative 16-log-events-per-request allowance in the saved [UTC-construction preflight](../../../../outputs/sun-cal-utc-construction-preflight.md). Its Standard overage-equivalent bound is $0.00701802: $0.0002016 for requests, $0.00036522 for CPU, and $0.0064512 for generated logs. The bound assumes no included allowance and does not give the account's billed amount.

The [Workers Logs pricing page](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing) applies its event-write meter through November 30, 2026, with a published Paid overage of $0.60 per million written events and seven-day retention. [Observability datasets pricing](https://developers.cloudflare.com/observability/logs/datasets/#pricing) and [Observability pricing](https://developers.cloudflare.com/observability/pricing/) list queries, dashboards, alerts, and analytics without an additional charge. The December 1 ingestion and storage change is outside the November 1 estimate. Log query scans do not create new ingested bytes. The pending UTC-construction phase in the linked preflight did not run; its request, CPU, and log reservations are excluded from this ledger. The account invoice was not queried.

## UV timestamp phase, November 1, 2026

The UV timestamp trial used 336 HTTP requests, one QA code upload, and one dense Workers Observability query. November 1 now has 23 telemetry queries. It left 336 requests, one upload, and one query unused from the phase allowance. Each request used synthetic fixtures and a QA Worker with a 500 ms CPU cap, empty bindings, and empty schedules. The uploaded QA version was 3cc07232-bdda-45d5-801c-74f53892a3da.

| Operation | Trial total |
| --- | ---: |
| Synthetic cache matches | 576 |
| Synthetic cache puts | 216 |
| Mocked OpenUV calls | 216 |
| Mocked Sentry sends | 16 |
| Actual D1 reads or writes | 0 |
| Actual R2 operations | 0 |
| Actual Durable Object storage operations | 0 |
| Actual native Cache API operations | 0 |
| Actual OpenUV calls | 0 |
| Actual Sentry calls | 0 |

The 336 event records contain 10,196 ms of observed Worker CPU, including warmups. They match the uploaded QA version. The run sent 336 HTTP requests. No application data operations reached external services.

The dense query scanned 2,153,143 log rows and 594,312,158 bytes. This exceeded the predeclared 512 MiB query stop of 536,870,912 bytes. No further requests, uploads, or telemetry queries ran. The remaining allowance stays unused.

The two prior queries with retained scan statistics recorded 3,374,983 scanned rows and 252,479,027 bytes. Known scan totals are now 5,528,126 rows and 846,791,185 bytes. The earlier 20 compact queries did not retain scan statistics, so the full cumulative scan remains unknown. These counts describe Workers Observability scans, not D1 reads.

The prior CPU account was 11,761 observed ms plus 6,500 ms reserved for 13 missing records, for an 18,261 ms bound. The UV trial adds 10,196 observed ms. The cumulative account is 21,957 observed ms across 995 event records, plus the unchanged 6,500 ms reserve for 13 gaps, for a 28,457 ms bound.

The previous conservative cost bound was $0.00701802. The UV trial adds $0.00191752: $0.00010080 for requests, $0.00020392 for CPU, and $0.00161280 for the eight-log-events-per-request allowance. The November 1 cumulative bound is $0.00893554 under the $0.02 ceiling. This estimate uses the [Workers Logs pricing page](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing) event-write price through November 30 and the listed Paid rate of $0.60 per million events. The [Observability datasets pricing](https://developers.cloudflare.com/observability/logs/datasets/#pricing) and [Observability pricing](https://developers.cloudflare.com/observability/pricing/) pages list query and analytics features without an additional charge. The December 1 ingestion and storage change is outside this estimate. The account invoice was not queried.

New November 1 traffic totals 1,008 requests and three uploads. Cumulative project totals are 4,140 requests and 21 uploads. The production Worker remains at version `6c22597d-ae1a-4863-9ac6-52c87039998b`. The prior one-worker phase and pause checkpoint are retained below as history.

## Historical synthetic phase before November 1

The first phase sent 2,458 controlled HTTP requests: two smoke requests, one 107-request exploratory run that stopped on a harness assertion, one 111-request baseline, one 222-request comparison, and six 336-request comparisons or crossovers. Local Miniflare requests are separate and make no remote calls.

All application data operations in that phase were synthetic. Actual D1 row reads and writes were zero. Actual R2 operations, Durable Object storage operations, native Cache API reads and writes, OpenUV calls, and Sentry calls were also zero. The harness replaced the Cache API with a bounded in-memory map and replaced global fetch with fixed synthetic responses. It threw on every unknown fetch destination. Sentry 11.6.0 calls `(options.fetch ?? fetch)` when it sends an envelope; the app supplies no transport fetch override, so the synthetic port receives that call too. Local workerd also rejects any escaped outbound request.

The completed phase created 16 isolated QA code versions. Those uploads and deployment metadata writes are real account operations, separate from application data storage. Managed invocation logging also creates telemetry records. The experiment did not create a D1 database, R2 bucket, Durable Object namespace, queue, or cron trigger.

## Historical one-worker control phase, October 29

The October 29 phase had two runs. An A/A run imports two byte-identical copies of the original source. An A/B run imports the original and the then-current candidate. Both labels use the same QA Worker endpoint. Each run uses four locations, four cache states, two variants, one warmup per variant and case, eight measured rounds, and three error cases.

`4 × 4 × 2 × (1 + 8) + 3 × 2 × 8 = 336 HTTP requests per run`.

The comparison plan has 672 HTTP requests. The first request immediately after publishing the new QA route returned 404 and stopped the driver. One readiness probe then returned a valid calendar with zero cache puts and zero upstream calls. The total phase bound is therefore 674 HTTP requests, including those two publication/readiness requests. The live QA settings confirm an empty binding list. Crossovers add zero requests in this phase because each request selects its implementation at the same endpoint. The driver has no HTTP retries and a 15-second request timeout. Each invocation keeps the app's maximum of two refresh attempts. Those attempts use the synthetic OpenUV port.

| Operation | Per request | Per 336-request run | Per 672-request phase |
| --- | --- | ---: | ---: |
| Actual D1 rows read or written | 0 | 0 | 0 |
| Actual R2 reads or writes | 0 | 0 | 0 |
| Actual Durable Object storage operations | 0 | 0 | 0 |
| Actual native Cache API reads or writes | 0 | 0 | 0 |
| Actual OpenUV calls | 0 | 0 | 0 |
| Actual Sentry calls | 0 | 0 | 0 |
| Synthetic cache matches | 2 per calendar, 0 per error | 576 | 1,152 |
| Synthetic cache puts | cold 2, UV-hit 1, other cases 0 | 216 | 432 |
| Synthetic OpenUV calls | cold 1, stale fallback 2, other cases 0 | 216 | 432 |
| Synthetic Sentry envelope sends | 1 per Sentry error, otherwise 0 | 16 | 32 |
| Solar calculations | 360 per solar miss, otherwise 0 | 51,840 | 103,680 |
| Solar events serialized | 720 per solar miss, otherwise 0 | 103,680 | 207,360 |
| Successful calendar responses | 1 per calendar request | 288 | 576 |
| Managed invocation log records | one logical invocation record per request | at most 336 | at most 672 |

The two planned QA uploads each contain one bounded code bundle. The A/A bundle is 9.2 MiB before compression and about 545 KiB compressed. The A/B bundle must remain within the platform's upload limit. The QA configuration has no application bindings and enables invocation logs. Code uploads, log ingestion, log queries, and inbound HTTP traffic are real platform operations; they are not D1, R2, or Durable Object operations.

## Input and loop bounds

The forecast contains exactly 24 fixed items and occupies 1,127 bytes as JSON. Each successful feed contains 720 solar events and one UV event. The largest cached solar fixture is 206,101 bytes. The app caps each UV bar at 100 characters. With these fixed inputs, the response budget is 256 KiB per request, or at most 84 MiB per 336-request run and 168.5 MiB including the two publication/readiness requests. This bound includes error requests even though their bodies are much smaller.

The four locations, elevations, timezone values, date, and `min-uv` are fixed by the driver and wrapper. The solar loop has 360 iterations. Each forecast pass has 24 items. Chicago has the longest transition table in these cases, with 1,161 intervals; Lord Howe has 1,040 and Kathmandu has three. The existing fold scan can run at most 1,161 comparisons per endpoint. Two endpoints across 720 events therefore have a conservative bound of 1,671,840 comparisons per named solar rebuild. The local-day scan is also bounded by the pinned transition table. No loop depends on rows from a database or on an unbounded provider response.

The mutable in-memory cache retains at most the small forecast envelope and one solar response during these sequential cases. Cold requests clear it. UV-hit requests remove prior solar entries. The larger solar fixtures are immutable bundle data. No persistent cache or provider quota is used to make CPU measurements smaller.

CPU-log queries use the recorded run ID, bounded time windows, pages of at most 50 events, and a finite page limit. Missing records remain explicit evidence gaps. A missing metric never counts as a fast request.

## Historical pause checkpoint, October 29

At the pause, the completed phases total 3,132 controlled HTTP requests and 18 QA code uploads. This includes exploratory runs, both publication/readiness requests, warmups, and the same-endpoint A/A and A/B comparisons. The completed control phase used its full 674-request bound. Actual application D1, R2, Durable Object storage, native Cache API, OpenUV, and Sentry operations remain zero. All three QA Workers are preserved. No QA resource cleanup was executed. No new benchmark traffic had been authorized at that checkpoint. The November 1 resumed phase is recorded above.
