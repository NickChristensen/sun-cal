# CPU performance evidence

## Interrogate correction, November 1, 2026

The read-only review found one P2 issue. The baseline accepts finite longitudes such as `1e300`, `-1e300`, `1e308`, `-1e308`, and the maximum finite number. It returns HTTP 200 with 720 solar events. The reviewed head could return HTTP 502 when direct solar-anchor arithmetic produced an invalid date. The follow-up fix keeps the fast arithmetic for valid dates and uses the original Luxon calendar-day calculation when the fast result is invalid. This restores accepted API behavior.

The CPU measurements in this file predate this fix. The accepted source used in the historical CPU comparisons is `5947624`. CPU on the fixed source has not been measured on Cloudflare Workers. No CPU gain is claimed for the fix. Final review and checks are required before release.

## Current fold-search result, November 1, 2026

The binary fold-transition search did not produce a repeatable Worker CPU win. The fold-search experiment is rejected. The candidate remains outside the tracked application source. The recovered checkpoint is `181bf13`, and its accepted application code remains `5947624`.

The saved local proof completed 396,125 transition probes across 344 zones and 37,432 serialized fold endpoints across 9,358 rollback transitions. The 43 existing tests, type check, and 40-request paired local smoke passed. Algorithm comparison counts fell from 33,845,044 to 2,573,172. Cloudflare Worker event CPU supplies the performance evidence.

Each ratio is paired candidate CPU divided by baseline CPU, so values below 1 favor the candidate. The 95% intervals use 5,000 bootstrap samples of the median log ratio.

| Cohort | Generation pairs | Baseline median CPU | Candidate median CPU | Candidate/baseline ratio | 95% interval | Coverage |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| First run, four locations | 64 | 28.5 ms | 26 ms | 0.9877296 | 0.942857 to 1.055556 | Complete |
| Crossed run, four-location diagnostic | 59 | 34 ms | 34 ms | 1.0384615 | 0.945946 to 1.125000 | Incomplete and unbalanced |
| Both runs, three named zones | 96 | 34 ms | 34 ms | 0.9735169 | 0.942857 to 1.049022 | Complete |

The first run passed all 336 response checks and joined CPU for all 304 measured requests. The crossed run passed its response checks and joined CPU for 294 of 304 measured requests. Its four-location result is an incomplete and unbalanced diagnostic. The confidence intervals include 1 for all three cohorts.

The complete named-zone cohort contains 384 measured CPU records and 192 matching response-digest pairs. Its warm solar-hit medians are 6 ms for both sources. All observed candidate generation CPU records exceed 10 ms.

The crossed run reversed source assignment at the same QA endpoint. The saved normalized source labels identify the accepted source and fold-search candidate. The original driver labels remain in `driverSource`, and the raw crossed driver file remains at `../qa/fold-search-r2-crossed-raw.json`.

The crossed run has ten missing measured CPU records and three missing warmup records. All ten measured gaps belong to fixed-offset generation or solar-hit requests. The first logging bucket reports `sampleInterval=1.6206896551724137`. A separate audit found 216 named-zone records, with 108 records per driver label and `sampleInterval=1`. This supports the complete three-zone cohort. The four-location crossed cohort remains incomplete. The CSV joins Worker events to measured driver rows by `benchId`; driver status, Ray ID, event count, counters, and digest stay populated when an event is missing.

The named-zone result uses the accepted `5947624` source as baseline and the fold-search source as candidate. The October 29 original-versus-accepted series is a separate experiment. Keep its 49.5 ms to 41 ms result in the historical section below.

Cloudflare Worker event CPU is the source for the CPU result. The CSV `wall_ms` column stores Worker event `wallMs`. Driver `httpWallMs` includes network time and response transfer. Driver wall time is excluded from the CPU analysis.

The [resumed QA resource budget](cpu-resource-budget.md) records the November 1 request and upload totals, query scans, missing-event reserve, and cost cap. The production Worker remains at version `6c22597d-ae1a-4863-9ac6-52c87039998b`.

## UV timestamp result, November 1, 2026

The UV timestamp candidate was rejected and remains outside the tracked application source. It precomputed validated UV timestamps and used those millisecond values during event construction. The accepted application code remains `5947624`. The candidate source hash was `38962f71de2f5f3e8ec6c41ef2a160c404fdaffea0e9599011c5c5c1e60b6362`.

The predeclared primary cohort tested warm solar-hit requests with 32 pairs. Baseline and candidate median Worker CPU were both 9 ms. The paired candidate-to-baseline ratio was 0.95346, with a 95% bootstrap interval of 0.80000 to 1.16667. The interval includes 1. Only one unswapped batch ran, so it did not establish a CPU win.

The 64-pair generation cohort is secondary context. Baseline median Worker CPU was 51.5 ms and candidate median was 53 ms. The paired ratio was 1.04313, with a 95% interval of 0.95290 to 1.09375. This interval includes 1. All 64 candidate generation samples exceeded 10 ms, so the 10 ms target remains unmet.

Each ratio is paired candidate CPU divided by baseline CPU. The intervals use 5,000 bootstrap samples of the median log ratio.

| State or error case | n per source | Baseline median / p95 / max CPU | Baseline >10 ms | Candidate median / p95 / max CPU | Candidate >10 ms |
| --- | ---: | --- | ---: | --- | ---: |
| Cold | 32 | 63.5 / 121.05 / 145 ms | 32 | 63 / 103.8 / 125 ms | 32 |
| UV-hit | 32 | 45.5 / 71.8 / 80 ms | 32 | 46.5 / 78.35 / 82 ms | 32 |
| Solar-hit | 32 | 9 / 14.45 / 15 ms | 9 | 9 / 18.05 / 33 ms | 6 |
| Stale fallback | 32 | 10 / 22.05 / 29 ms | 15 | 10 / 15.45 / 27 ms | 11 |
| Not found, HTTP 404 | 8 | 1.5 / 2 / 2 ms | 0 | 1.5 / 2 / 2 ms | 0 |
| Validation, HTTP 400 | 8 | 1.5 / 3.95 / 5 ms | 0 | 1 / 2 / 2 ms | 0 |
| Sentry error, HTTP 500 | 8 | 3 / 7.9 / 10 ms | 0 | 2 / 4.65 / 5 ms | 0 |

The table uses Cloudflare event CPU. Each source has 32 records per calendar state and eight records per error case. The p95 values use linear interpolation. The CSV stores Worker event `wallMs` in `wall_ms`. Driver `httpWallMs` includes network and response time and is not Worker CPU.

The run sent 336 requests, including 32 warmups. All 336 event records matched QA version `3cc07232-bdda-45d5-801c-74f53892a3da`. The 304 measured requests matched CPU records and passed their status checks. All 144 calendar digest pairs passed, including warmups. The 128 measured calendar digest pairs passed. The saved candidate test log records 43 of 43 tests passing. A later repeat stopped while `test/worker.test.mjs` remained pending, so it adds no test result.

The uploaded QA run produced 10,196 ms of observed event CPU, including warmups. The dense telemetry query scanned 2,153,143 log rows and 594,312,158 bytes. This exceeded the predeclared 512 MiB per-query stop of 536,870,912 bytes. No more QA requests, uploads, or telemetry queries ran.

The [QA resource ledger](cpu-resource-budget.md) records the cumulative CPU reserve, known scan totals, query count, and cost bound. The [resumed measurements CSV](cpu-measurements.csv) adds 304 measured rows and retains all earlier rows and blanks. The October 29 49.5 ms to 41 ms result remains a separate historical comparison.

## Local format and endpoint probes, November 1

Two timestamp-format candidates failed local semantic checks. Both remain off branch. Neither has remote Worker CPU data, and no remote traffic ran for these probes.

The first used `fromMillis(date.valueOf() + offset * 3600000, { zone: "UTC" })`. At accepted timezone input `1e308`, the existing Luxon path returns its current-time fallback after overflow, while the proposed expression gives `Invalid DateTime`. The saved fixed-format probe records 2,304 differences across 5,472 comparisons.

The second used `DateTime.fromJSDate(date, { zone: "UTC" })` and preserved plus signs. The one-line UTC candidate passed the 43 existing tests. Its fixed-zone probe records 116 differences across 5,472 formatter comparisons. An 81-comparison endpoint probe found six digest changes for inputs accepted by current numeric validation. The accepted extreme longitudes were `36007408080` and `-35992462320`. The affected default zones were `America/Los_Angeles` and `Pacific/Kiritimati`, with display timezone `0` or `-6`. Both response variants returned HTTP 200. One baseline `Invalid DateTime` description changed to a formatted time. The current Worker has no latitude or longitude range bounds.

The saved probes are `work/recovery.nosync/qa/fixed-format-probes.json`, `work/recovery.nosync/qa/fixed-zone-probes.json`, and `work/recovery.nosync/qa/endpoint-bounds-probe.json`. No guard or API validation change was made. Both source patches remain outside the branch. The raw fixture collector is local and under review. The UV timestamp candidate was measured and rejected. The pending UTC-construction phase in its preflight did not run, and its limits are excluded from the UV ledger.

## Historical result: October 29 same-endpoint A/B and A/A

The same-endpoint A/B run was the primary result for the October 29 original-versus-accepted comparison. It passed all 336 response checks and joined CPU for all 304 measured requests. Across 64 paired cold and UV-hit requests, baseline median CPU was 49.5 ms and candidate median CPU was 41 ms. The paired candidate-to-baseline median ratio was 0.758, with a 95% bootstrap interval of 0.6875 to 0.8462. The candidate used less CPU in 53 pairs; the baseline used less CPU in 11 pairs.

Every candidate cold and UV-hit sample was above 10 ms. The 10 ms ordinary-request target remains unmet. Warm solar-hit medians were 7 ms for both variants. Their paired ratio was 1.108, with a 95% interval of 1.000 to 1.200. This result shows no warm-path improvement.

The same-endpoint A/A control passed all 336 response checks and joined CPU for all 304 measured requests. It compared two identical copies of the original source. Across 64 generation pairs, baseline and candidate medians were 49.5 ms and 49 ms. The paired ratio was 1.070, with a 95% interval of 0.964 to 1.179. The warm solar-hit ratio was 1.000, with a 95% interval of 0.857 to 1.143. These results found no measurable difference between identical copies and support the one-endpoint method. They do not establish hardware independence.

| Experiment | QA requests | Measured rows | Primary pairs | Baseline median CPU | Candidate median CPU | Candidate/baseline median ratio | 95% interval | Candidate wins |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| Same-endpoint A/B, original versus `5947624` | 336 | 304 | 64 | 49.5 ms | 41 ms | 0.758 | 0.6875 to 0.8462 | 53 of 64 |
| Same-endpoint A/A control | 336 | 304 | 64 | 49.5 ms | 49 ms | 1.070 | 0.964 to 1.179 | 25 of 64 |
| Iteration 1 plus repeat | 558 | 494 | 104 | 84.5 ms | 60 ms | 0.795 | 0.677 to 0.848 | 76 of 104 |
| First-change crossover | 336 | 304 | 64 | 55 ms | 37 ms | 0.719 | 0.600 to 0.758 | 57 of 64 |
| Dual-worker combined versus original | 336 | 304 | 64 | 47 ms | 86 ms | 1.915 | 1.603 to 2.087 | 10 of 64 |

The same-endpoint A/B comparison uses cold and UV-hit states across four locations. Each state and location has eight measured pairs. It compares the original source with the combined source at `5947624`, which includes the first change and direct pinned-offset helper.

Both same-endpoint runs sent source labels to one QA endpoint. The `x-bench-variant` header and `bench_variant` query value select the source copy for each request. The A/A source trees had the same hash, `2800ec622d4dd0f078e1259e8410a471ff525e6b149671926852dc153bfd4a90`. The A/A control found no measurable difference between identical source copies. The same-endpoint design removes the fixed Worker-name assignment confound seen in earlier runs. It does not guarantee hardware independence.

The earlier dual-worker combined run assigned each variant to a different QA Worker name and alternated request order. It reported 47 ms baseline and 86 ms candidate medians. Its warm solar-hit controls moved from 6 ms to 12 ms across 31 pairs, and stale-fallback controls moved from 7 ms to 12 ms across 31 pairs. Keep that result as history. Within the October 29 series, the same-endpoint A/B run was the primary comparison.

The A/A and A/B comparison plan has 672 requests. One request immediately after publication returned 404 and stopped its driver run. A readiness request then returned a valid calendar. Those two requests sit outside the comparison plan, which sets the phase bound at 674 requests. The [CPU resource budget](cpu-resource-budget.md) records the request loop bounds, storage audit, and log collection limits.

The paired QA Worker had an empty binding list. Actual D1 row reads and writes, R2 operations, Durable Object storage, native Cache API operations, OpenUV calls, and Sentry calls were zero. The wrapper used an in-memory cache and synthetic provider and Sentry responses. QA code uploads and invocation log records are real platform operations.

## Combined-versus-original details

Each primary row has eight pairs. `>10` counts samples above 10 ms. The four location inputs are Austin at fixed -6, Chicago, Kathmandu, and Lord Howe Island.

| Location | State | n | Baseline median | Baseline p95 | Baseline max | Baseline >10 | Candidate median | Candidate p95 | Candidate max | Candidate >10 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Austin, fixed -6 | cold | 8 | 38 | 57.65 | 58 | 8 | 72 | 133.75 | 139 | 8 |
| Austin, fixed -6 | UV hit | 8 | 28 | 38.45 | 43 | 8 | 58 | 78.05 | 84 | 8 |
| America/Chicago | cold | 8 | 59 | 93.15 | 97 | 8 | 95.5 | 215.35 | 250 | 8 |
| America/Chicago | UV hit | 8 | 57 | 82.2 | 85 | 8 | 96.5 | 143.5 | 154 | 8 |
| Asia/Kathmandu | cold | 8 | 52.5 | 108.1 | 120 | 8 | 74 | 136.15 | 140 | 8 |
| Asia/Kathmandu | UV hit | 8 | 60.5 | 110.65 | 132 | 8 | 86.5 | 124.95 | 126 | 8 |
| Australia/Lord_Howe | cold | 8 | 50 | 72.95 | 81 | 8 | 122.5 | 179 | 200 | 8 |
| Australia/Lord_Howe | UV hit | 8 | 45 | 96.35 | 117 | 8 | 102 | 157.25 | 159 | 8 |

The warm solar-hit comparison had 31 CPU-matched pairs. Baseline and candidate medians were 6 ms and 12 ms. Its paired ratio was 1.857, with a 95% interval of 1.222 to 2.286. The stale-fallback comparison also had 31 pairs. Its medians were 7 ms and 12 ms, with a paired ratio of 1.714 and a 95% interval of 1.375 to 2.000. The three error cases had 24 pairs, with medians of 1 ms and 2.5 ms.

| Error case | n | Baseline median | Baseline p95 | Baseline max | Baseline >10 | Candidate median | Candidate p95 | Candidate max | Candidate >10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| not-found | 8 | 1 | 1 | 1 | 0 | 2 | 5.6 | 7 | 0 |
| validation | 8 | 1 | 1.65 | 2 | 0 | 1.5 | 3 | 3 | 0 |
| sentry-error | 8 | 2 | 5.6 | 7 | 0 | 3 | 15.45 | 20 | 1 |

Two candidate fixed-offset control events have no CPU record: `combined-vs-original-mvtvmytl-bf3d0390-0044` for solar-hit and `combined-vs-original-mvtvmytl-bf3d0390-0058` for stale-fallback. These gaps reduce the warm and stale comparisons from 32 to 31 pairs. Both requests passed their response checks.

The earlier first-change crossover reduced median Worker CPU from 55 ms to 37 ms across 64 paired cold and UV-hit requests. Its paired candidate-to-baseline median ratio was 0.719, with a 95% bootstrap interval of 0.600 to 0.758. The candidate used less CPU in 57 pairs and more CPU in 7 pairs. All 64 candidate cold and UV-hit samples stayed above 10 ms.

The direct pinned-offset helper is a separate source change. Its first named-zone sample reduced median CPU from 57 ms to 49 ms across 48 pairs. The median paired ratio was 0.908, with a 95% bootstrap interval of 0.814 to 0.972. Its placement crossover reduced median CPU from 53.5 ms to 45.5 ms across 48 pairs. The paired ratio was 0.777, with a 95% interval of 0.734 to 0.975.

| Direct-offset run | Named-zone pairs | Baseline median CPU | Candidate median CPU | Paired ratio | 95% interval | Candidate wins |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| `iteration-3` | 48 | 57 ms | 49 ms | 0.908 | 0.814 to 0.972 | 32 of 48 |
| `iteration-3-crossover` | 48 | 53.5 ms | 45.5 ms | 0.777 | 0.734 to 0.975 | 32 of 48, 1 tie |

The direct-offset crossover records candidate on Worker A and baseline on Worker B. Its source labels reflect that assignment.

Iteration 2 is rejected. Its fixed-offset primary mix had a candidate-to-baseline median ratio of 2.20 across 16 pairs. Its control cases also ran slower. The run has 336 requests and 304 measured CPU rows. It remains in the CSV so the rejection is auditable.

The first-change runs contain 894 QA requests and 798 measured rows. Every measured row has one CPU event. Its crossover log lacks one unmeasured warmup event. The two direct-offset runs add 672 QA requests and 608 measured rows. One fixed-offset cold control row in `iteration-3` has no CPU event. The missing row is `iteration-3-mvtvcz68-1a3a2335-0014`, source `baseline`, round 6. All named-zone target pairs in both direct-offset runs have CPU events. The combined run adds 336 requests and 304 measured rows. It has CPU events for 302 measured requests; all 64 primary pairs have complete CPU data. The A/A control adds 336 requests and 304 measured rows, with CPU events for every measured request. The same-endpoint A/B run adds another 336 requests and 304 measured rows, also with complete CPU coverage.

| Source file | QA requests | Measured rows | Measured rows with CPU | Coverage note |
| --- | ---: | ---: | ---: | --- |
| `../qa/iteration-1.json` | 222 | 190 | 190 | Complete |
| `../qa/iteration-1-repeat.json` | 336 | 304 | 304 | Complete |
| `../qa/iteration-2.json`, rejected | 336 | 304 | 304 | Complete |
| `../qa/first-change-crossover.json` | 336 | 304 | 304 | One unmeasured warmup event is missing |
| `../qa/iteration-3.json` | 336 | 304 | 303 | One fixed-offset cold control event is missing |
| `../qa/iteration-3-crossover.json` | 336 | 304 | 304 | Complete |
| `../qa/combined-vs-original.json` | 336 | 304 | 302 | Two candidate fixed-offset control events are missing |
| `../qa/paired-aa-control-ready.json` | 336 | 304 | 304 | Same-endpoint identical-source control, complete |
| `../qa/paired-ab-combined.json` | 336 | 304 | 304 | Same-endpoint original versus current source, complete |

## First-change crossover by case

CPU values use integer milliseconds. Each row has eight samples per variant. The p95 uses linear interpolation. The `>10` column counts values above 10 ms.

### Cold

| Location | n | Baseline median | Baseline p95 | Baseline max | Baseline >10 | Candidate median | Candidate p95 | Candidate max | Candidate >10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Austin, fixed -6 | 8 | 44.5 | 75.80 | 80 | 8 | 29.5 | 41.60 | 43 | 8 |
| America/Chicago | 8 | 67 | 129.05 | 149 | 8 | 51.5 | 71.70 | 78 | 8 |
| Asia/Kathmandu | 8 | 78.5 | 136.55 | 139 | 8 | 70.5 | 144.15 | 155 | 8 |
| Australia/Lord_Howe | 8 | 58 | 118.35 | 132 | 8 | 50 | 81.70 | 95 | 8 |

### UV hit, solar miss

| Location | n | Baseline median | Baseline p95 | Baseline max | Baseline >10 | Candidate median | Candidate p95 | Candidate max | Candidate >10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Austin, fixed -6 | 8 | 32.5 | 79.65 | 87 | 8 | 23.5 | 30.55 | 33 | 8 |
| America/Chicago | 8 | 42 | 236.20 | 316 | 8 | 32 | 52.80 | 57 | 8 |
| Asia/Kathmandu | 8 | 66.5 | 100.55 | 103 | 8 | 35.5 | 43.95 | 45 | 8 |
| Australia/Lord_Howe | 8 | 67 | 85.95 | 87 | 8 | 34 | 44.85 | 48 | 8 |

### Warm solar hit

| Location | n | Baseline median | Baseline p95 | Baseline max | Baseline >10 | Candidate median | Candidate p95 | Candidate max | Candidate >10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Austin, fixed -6 | 8 | 6 | 7.30 | 8 | 0 | 6.5 | 11.30 | 12 | 1 |
| America/Chicago | 8 | 8 | 13.55 | 16 | 1 | 6 | 11.60 | 13 | 1 |
| Asia/Kathmandu | 8 | 6 | 9.60 | 11 | 1 | 6 | 10.55 | 13 | 1 |
| Australia/Lord_Howe | 8 | 7 | 10 | 10 | 0 | 7 | 9.30 | 10 | 0 |

### Stale UV fallback

| Location | n | Baseline median | Baseline p95 | Baseline max | Baseline >10 | Candidate median | Candidate p95 | Candidate max | Candidate >10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Austin, fixed -6 | 8 | 6 | 8.30 | 9 | 0 | 6.5 | 9 | 9 | 0 |
| America/Chicago | 8 | 8 | 12.30 | 13 | 2 | 11 | 20.55 | 23 | 5 |
| Asia/Kathmandu | 8 | 7 | 9.30 | 10 | 0 | 8 | 20.05 | 26 | 1 |
| Australia/Lord_Howe | 8 | 8 | 10.30 | 11 | 1 | 7.5 | 9.95 | 11 | 1 |

### Error responses

These requests used the cold state. Each row has eight samples per variant.

| Case | n | Baseline median | Baseline p95 | Baseline max | Baseline >10 | Candidate median | Candidate p95 | Candidate max | Candidate >10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| not-found | 8 | 1 | 1.65 | 2 | 0 | 1 | 1.65 | 2 | 0 |
| validation | 8 | 1 | 1.65 | 2 | 0 | 1 | 1.65 | 2 | 0 |
| sentry-error | 8 | 2 | 6.25 | 8 | 0 | 2 | 6.25 | 8 | 0 |

### Direct-offset crossover on named zones

This crossover has eight samples per variant for each named zone and state. The fixed -6 control is outside this 48-pair primary mix.

| Location | State | n | Baseline median | Baseline p95 | Baseline max | Baseline >10 | Candidate median | Candidate p95 | Candidate max | Candidate >10 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| America/Chicago | cold | 8 | 53 | 79.40 | 85 | 8 | 42 | 80.45 | 92 | 8 |
| America/Chicago | uv-hit | 8 | 40.5 | 56.50 | 60 | 8 | 43 | 60.25 | 62 | 8 |
| Asia/Kathmandu | cold | 8 | 75.5 | 115.35 | 122 | 8 | 56 | 102.55 | 119 | 8 |
| Asia/Kathmandu | uv-hit | 8 | 55 | 104.70 | 111 | 8 | 37.5 | 104.55 | 121 | 8 |
| Australia/Lord_Howe | cold | 8 | 75 | 124.85 | 128 | 8 | 60.5 | 122.70 | 143 | 8 |
| Australia/Lord_Howe | uv-hit | 8 | 41 | 88.75 | 94 | 8 | 66 | 105.45 | 110 | 8 |

## Workload and checks

The calendar used a frozen time of 2026-10-16 12:00 UTC and a synthetic 24-hour UV forecast. The API takes height in feet. The four locations were Austin at 30.48, -97.65 and 800 ft; Chicago at 41.88, -87.63 and 600 ft; Kathmandu at 27.7172, 85.324 and 4500 ft; and Lord Howe Island at -31.55, 159.08 and 30 ft.

The cold case missed both caches and made one mocked OpenUV request. The UV-hit case used the synthetic UV cache and generated the solar calendar. The solar-hit case used both cached entries. The stale-fallback case used a cached solar calendar and stale UV data, then made two mocked 503 retries.

The QA driver checked status, response body, calendar content type, `max-age=1800`, operation counters, Cloudflare Ray ID, event counts, and normalized A/B body digest. Successful calendar responses had 720 solar events and one UV event. Error cases checked 404 `Not found`, 400 `Missing required query params: latitude, longitude, height`, and 500 `Server misconfigured`.

CPU values came from Cloudflare Worker events. They are integer milliseconds with 1 ms resolution. The QA wrapper and its counters are included in these values. Cloudflare Cache API transport, OpenUV, and Sentry network calls were mocked. The candidate and baseline used the same immutable solar fixture.

The primary interval uses 5,000 bootstrap samples of the median log candidate-to-baseline ratio, with seed 1592594996. The 95% interval uses percentile bounds. Measurements were sequential and alternated A/B order by measured round. Cloudflare isolate placement can vary across requests. These results describe the measured runs.

The direct-offset helper passed 396,125 timestamp-and-zone probes across all 344 canonical zones in the bundled data. Each probe compared the direct pinned-table UTC offset with Moment's existing converted value. The probes covered monthly dates, offset transitions at one millisecond before, exactly at, and one millisecond after the transition, and coverage edges. The coverage end still rejects. These checks show equivalence to the current pinned Moment behavior. The IANA database itself remains outside this equivalence check.

The [CSV](cpu-measurements.csv) contains 3,534 measured request rows from twelve runs. Warmup rows are excluded. Thirteen measured rows keep their response status, Ray ID, event count, counters, and digest while CPU, Worker wall time, and script version stay blank. Three gaps are historical control events. Ten gaps are fixed-offset measured rows from the crossed fold-search run. That run also has three missing warmup events; warmups are outside the CSV. The A/A rows use the `paired-aa-control` experiment label and keep their `baseline` and `candidate` source labels. New `fold-search-r2-crossed` rows use source labels normalized from the reversed bundle assignment. The `uv-timestamp-r1` rows join measured events by `benchId`. The `cpu_ms` and `wall_ms` columns use Cloudflare Worker event metrics. The CSV also records response status, Ray ID, event count, cache and Sentry counters, and normalized body digest. It contains no request URLs, request headers, or IP data.

## Production context and validation

An earlier user-provided 24-hour production snapshot reported CPU p50 29.9 ms and p99 206.3 ms. These values come from uncontrolled traffic and serve as context only. The previous profiling attempt returned API error 404 code 10393 after earlier requests succeeded. The profile was unavailable. The solar-generation cost question remains open.

The repository has 43 passing tests. CI passed for `b7c8105` and `5947624`, with deployment skipped. The direct-offset helper is commit `5947624`, which has been pushed. Both changes are in [PR #3](https://github.com/NickChristensen/sun-cal/pull/3).

A check at 18:27 reported production tag `d7863b11615a4fdc8f778b40fce638f1` and `modified_at` `2026-10-20T20:18:50.412993Z`. Build triggers and deploy hooks were both zero. The deployment workflow runs from `master` only. This work made no production deployment.

## Source and reproduction record

The baseline source is `98d6208`. The first accepted change is `b7c8105`. The direct-offset helper is `5947624`. The benchmark harness is `e12f7ef`. Production dependencies remained locked at the same versions. The Worker compatibility date is `2024-09-23` with `nodejs_compat`.

| Artifact | SHA-256 |
| --- | --- |
| `scripts/cpu-benchmark.mjs` | `cf1eafb20fe1f1d3a242a1f951ef7ff000e45dd567423ac8e85df8ffa3e726b3` |
| `scripts/cpu-qa.mjs` | `ae30454fe0c9f1c3b5de1deafa84b65bd73f90857ad8aa85c41dfed67e29e1e7` |
| `test/fixtures/cpu-solar-cache.json` | `a680fa0764e5f7792d9ad2b1900c400aed14c13fc75ee88f1cb81b889641dae6` |
| A/A bundle `../qa/paired-aa.js` | `515e6fbb514ada20b3ef52a155bc19317dc58f37c6d9323be9bd4d02c05efb30` |
| A/A QA Worker version | `cac9bee8-6770-4a62-9d17-e8ff63f903e1` |

From the repository root, prepare the original and comparison source trees and install the locked dependencies. The paired bundle reads the frozen location fixture from the tracked `test/fixtures/cpu-solar-cache.json`; verify its hash before building.

```sh
mkdir -p ../baseline-src ../aa-peer-src ../iteration-3-accepted-src ../qa
git archive 98d6208 src | tar -x -C ../baseline-src
git archive 98d6208 src | tar -x -C ../aa-peer-src
git archive 5947624 src | tar -x -C ../iteration-3-accepted-src
npm ci
shasum -a 256 test/fixtures/cpu-solar-cache.json
node scripts/cpu-benchmark.mjs build --baseline ../baseline-src --candidate ../aa-peer-src --out ../qa/paired-aa.js
node scripts/cpu-benchmark.mjs build --baseline ../baseline-src --candidate ../iteration-3-accepted-src --out ../qa/paired-ab.js
```

Configure the same QA Worker endpoint with each paired bundle before its run. The QA driver sends both source labels to one endpoint. It adds one warmup per calendar scenario, then alternates the baseline and candidate source labels for each measured round. Eight rounds produce 336 sequential requests, including the three error cases.

```sh
node scripts/cpu-qa.mjs --rounds 8 --run-id paired-aa-control --out ../qa/paired-aa-control.json
node scripts/cpu-qa.mjs --rounds 8 --run-id paired-ab --out ../qa/paired-ab.json
```

The QA Worker names and endpoints belong to this task. Run the QA driver first without `--cpu-events`. After it finishes, query the persisted `cloudflare-workers` dataset by its `benchRun` value. Retrieve every page until the API returns no next cursor. Save only the QA rows with `benchRun`, `benchId`, `cpuTimeMs`, `wallTimeMs`, `scriptVersion`, `ray`, `outcome`, and `eventTimestamp`.

Map the persisted records into the Wrangler event shape and call the exported helper after collection. The sample uses the benchmark ID to find each response status. It creates a sanitized URL with only `bench_run` and `bench_id` query values.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { summarizeCpuEvents } from './scripts/cpu-qa.mjs';
const [runPath, eventsPath, outPath] = process.argv.slice(2);
const run = JSON.parse(await readFile(runPath, 'utf8'));
const rows = JSON.parse(await readFile(eventsPath, 'utf8'));
const byId = new Map(run.measurements.map(row => [row.benchId, row]));
const events = rows.map(row => {
  const measurement = byId.get(row.benchId);
  if (!measurement || row.benchRun !== run.benchRun) throw new Error('Unexpected Worker event');
  const query = new URLSearchParams({ bench_run: row.benchRun, bench_id: row.benchId });
  return {
    cpuTime: row.cpuTimeMs,
    wallTime: row.wallTimeMs,
    scriptVersion: { id: row.scriptVersion },
    eventTimestamp: row.eventTimestamp,
    outcome: row.outcome,
    event: {
      request: {
        url: `https://cpu-qa.invalid/sun-cal.ics?${query}`,
        headers: { 'cf-ray': row.ray },
      },
      response: { status: measurement.status },
    },
  };
});
run.cpu = summarizeCpuEvents(events, run.measurements);
await writeFile(outPath, JSON.stringify(run, null, 2) + '\n');
```

The helper requires one Worker event for each measured request. It reports missing CPU values separately and rejects duplicate benchmark IDs. A request with no Worker event remains a coverage gap. The CSV keeps all thirteen measured gaps with blank CPU, Worker wall-time, and script-version values. The three missing warmup events from the crossed run stay outside the measured-row CSV. Local Miniflare reports local request wall time and checks response digests and operation counts. Cloudflare CPU values come from persisted Worker events. This procedure ends with QA data collection.


## Same-endpoint A/B distributions

Each row has eight measured requests per variant. CPU values are milliseconds; `>10` counts samples above the target.

| Case and cache state | Before median | Before p95 | Before max | Before >10 | After median | After p95 | After max | After >10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| America/Chicago/cold | 49 | 75.7 | 82 | 8 | 43 | 65.9 | 75 | 8 |
| America/Chicago/solar-hit | 6.5 | 16.95 | 18 | 2 | 7 | 15.5 | 19 | 1 |
| America/Chicago/stale-fallback | 8 | 10.3 | 11 | 1 | 10 | 13.6 | 15 | 3 |
| America/Chicago/uv-hit | 59 | 105.7 | 112 | 8 | 38 | 49.45 | 54 | 8 |
| Asia/Kathmandu/cold | 46.5 | 120.45 | 153 | 8 | 50.5 | 91.1 | 103 | 8 |
| Asia/Kathmandu/solar-hit | 7.5 | 13.95 | 15 | 3 | 9 | 16.95 | 18 | 3 |
| Asia/Kathmandu/stale-fallback | 6 | 14.65 | 15 | 2 | 9.5 | 14.9 | 17 | 2 |
| Asia/Kathmandu/uv-hit | 66 | 170.25 | 179 | 8 | 41 | 96.15 | 107 | 8 |
| Australia/Lord_Howe/cold | 48.5 | 64.5 | 68 | 8 | 35.5 | 68.25 | 77 | 8 |
| Australia/Lord_Howe/solar-hit | 6.5 | 11.55 | 14 | 1 | 7 | 13.65 | 14 | 2 |
| Australia/Lord_Howe/stale-fallback | 10.5 | 18.25 | 20 | 4 | 9 | 11.3 | 12 | 1 |
| Australia/Lord_Howe/uv-hit | 57 | 116.6 | 139 | 8 | 45 | 80.5 | 91 | 8 |
| fixed-minus-6/cold | 41 | 85.65 | 86 | 8 | 31 | 60.3 | 61 | 8 |
| fixed-minus-6/solar-hit | 7 | 14.25 | 16 | 2 | 7 | 11.65 | 12 | 2 |
| fixed-minus-6/stale-fallback | 7 | 13.55 | 16 | 1 | 6.5 | 11.65 | 12 | 2 |
| fixed-minus-6/uv-hit | 39 | 74.7 | 81 | 8 | 37.5 | 81.25 | 97 | 8 |
| not-found/cold | 1 | 1.65 | 2 | 0 | 1 | 1.65 | 2 | 0 |
| sentry-error/cold | 1.5 | 6.9 | 9 | 0 | 2 | 2.65 | 3 | 0 |
| validation/cold | 1 | 2.65 | 3 | 0 | 1 | 1 | 1 | 0 |
