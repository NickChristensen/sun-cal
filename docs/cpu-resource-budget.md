# QA resource budget

This budget applies to the synthetic CPU experiments. The ordinary production Worker is unchanged. Its production bindings are never attached to a QA Worker.

## Completed phase

The first phase sent 2,458 controlled HTTP requests: two smoke requests, one 107-request exploratory run that stopped on a harness assertion, one 111-request baseline, one 222-request comparison, and six 336-request comparisons or crossovers. Local Miniflare requests are separate and make no remote calls.

All application data operations in that phase were synthetic. Actual D1 row reads and writes were zero. Actual R2 operations, Durable Object storage operations, native Cache API reads and writes, OpenUV calls, and Sentry calls were also zero. The harness replaced the Cache API with a bounded in-memory map and replaced global fetch with fixed synthetic responses. It threw on every unknown fetch destination. Sentry 11.6.0 calls `(options.fetch ?? fetch)` when it sends an envelope; the app supplies no transport fetch override, so the synthetic port receives that call too. Local workerd also rejects any escaped outbound request.

The completed phase created 16 isolated QA code versions. Those uploads and deployment metadata writes are real account operations, separate from application data storage. Managed invocation logging also creates telemetry records. The experiment did not create a D1 database, R2 bucket, Durable Object namespace, queue, or cron trigger.

## One-Worker control phase

The next phase has two runs. An A/A run imports two byte-identical copies of the original source. An A/B run imports the original and the current candidate. Both labels use the same QA Worker endpoint. Each run uses four locations, four cache states, two variants, one warmup per variant and case, eight measured rounds, and three error cases.

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

## Pause checkpoint

At the pause, the completed phases total 3,132 controlled HTTP requests and 18 QA code uploads. This includes exploratory runs, both publication/readiness requests, warmups, and the same-endpoint A/A and A/B comparisons. The completed control phase used its full 674-request bound. Actual application D1, R2, Durable Object storage, native Cache API, OpenUV, and Sentry operations remain zero. All three QA Workers are preserved. No QA resource cleanup was executed. No new benchmark traffic is authorized until an explicit resume.
