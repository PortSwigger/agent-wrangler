# Mapping-save CPU investigation

Whole-map saves amplify small mutations as history grows. A separate, avoidable
cost is eager prompt normalization while choosing history labels. The small fix
in [sessionLabel](../server/state-reader.js) computes that fallback only when
needed; it preserves label precedence and all persistence behavior. Neither the
spike nor the matched check reproduces the reported live CPU at the reported save
frequency. A persistence migration or durability change is not justified yet.

## Evidence and limits

The investigation uses three distinct sources, all percentages relative to one
CPU core. MB means decimal megabytes; CPU is parent-process CPU, excluding tmux
and ps child CPU.

| Source | What it establishes | What it does not establish |
| --- | --- | --- |
| Supplied live observations | 4,932 mappings, approximately 26 MB; writes every 1–2 s during bursts; 50–95% CPU versus approximately 0.3% idle | New measurements, caller attribution, or causation |
| Earlier isolated spike, baseline `4ce9d7b3` | 42 synthetic runs; 30 V8 profiles; 100/4,932/10,000 mappings, fixed 12 live sleep panes; real save, graph, analysis, refresh, coalescer, tmux and ps modules | Complete application startup, real agents, PR network timing, extensions or broadcast costs |
| Matched check below | Production save methods and archive scan/sort/label projection before/after the label fix, identical harness and fixture recipe | Full rebuilds, live panes, discovery, transcript analysis, integrations or live-server attribution |

No live data was copied, rewritten or removed; no live server was inspected,
signalled or restarted. Fixtures contain generated ids, paths, prompts and PR
links. Raw profiles and datasets stay local; only aggregates belong in the repo.

### Earlier spike measurements

Node v26.13.1, macOS arm64; two sequential repeats per row, warmed synthetic ASCII
Claude transcripts, approximately 6–7.5 seconds each. Archive names are explicit
or cached, with approximately 4.6 KB prompts. Discovery is injected. The harness
has separate data directories, loopback ports and a named tmux socket, with hooks,
extensions, schedulers, PR actions and outbound integrations absent or blocked.
The sandbox-denied ps smoke run is excluded. This is a module-level profiling
server, not the full application server.

| Mappings / MB | Maintenance idle CPU % | Paced saves CPU % | Burst saves CPU % | Rebuild-heavy CPU % | Mixed CPU % |
| --- | --- | --- | --- | --- | --- |
| 100 / 0.54 | 2.18–2.22 | 1.69–1.86 | 2.84–3.09 | 7.30–8.57 | 4.12–4.94 |
| 4,932 / 26.68 | 5.02–5.13 | 4.10–5.04 | 24.23–24.27 | 30.30–30.67 | 30.21–30.46 |
| 10,000 / 54.11 | 6.64–6.97 | 5.59–5.71 | 49.50–59.92 | 41.64–43.00 | 60.04–61.23 |

Idle includes graph maintenance, so it is not comparable to a sleeping process or
the supplied live idle observation. Paced saves are 0.67/s. Burst and mixed runs
request 17 mutations every 1.5 seconds (11.33 saves/s); rebuild-only makes no saves.
Eight simultaneous rebuild requests exercise coalescing into a current and a
trailing build. Hardcoded schedules are not a replay of live arrivals.

At 4,932 entries the measured burst callers, ranked by count over both repeats:

| Caller / synthetic trigger | Saves | Rate / s |
| --- | --- | --- |
| `updateLinkStatus`: unchanged passing checks, refreshed freshness stamp | 120 | 8.00 |
| `rename`: board action | 30 | 2.00 |
| `setWorkflowPhase`: workflow stamp | 20 | 1.33 |

At 26.68 MB each save takes a weighted mean 19.91 ms wall / 18.95 ms CPU;
save CPU is 88.6% of burst process CPU. V8 attributes 95.5–95.8% of non-idle burst
sample time to save stacks. These are different denominators, not interchangeable
CPU percentages.

| Save phase | Wall ms/save | CPU ms/save |
| --- | --- | --- |
| `Object.fromEntries` | 0.77 | 0.82 |
| JSON stringify | 13.32 | 13.56 |
| UTF-8 encode | 1.18 | 1.20 |
| Sync write | 3.50 | 2.71 |
| Rename | 1.08 | 0.61 |

Explicit Buffer encoding separates encode/write in the spike and differs from
the production string-write path. At 4,932 entries, mean burst CPU is 23.23% with
source instrumentation and V8 off, 22.48% with counters, 24.25% with V8; rebuild
CPU is respectively 25.33%, 28.30%, 30.48%. Shared subprocess/graph counters remain
in the off mode. Two nonrandomized repeats do not establish precise overhead or
confidence intervals; host load and filesystem cache are uncontrolled.

| Rebuild phase, 4,932 mappings | Wall ms/call | Parent CPU ms/call |
| --- | --- | --- |
| Reproduced rebuild core | 334.38 | 101.05 |
| `refreshAlive` | 10.54 | 5.96 |
| `buildGraph` | 323.83 | 95.08 |
| History projection, including scan/sort | 72.21 | 76.28 |
| Archive scan/sort alone | 2.38 | 2.78 |
| Warmed `analyze`, per active card | 0.13 | 0.15 |
| tmux subprocess, per call | 9.51 | 1.11 |
| ps subprocess, per call | 133.11 | 4.19 |

Inclusive phases overlap; do not add them. Async CPU deltas include other parent
work during awaits. Subprocess wall times include scheduling/IPC, not just child
execution. V8 graph stacks occupy 88.4–89.0% of non-idle rebuild samples, with
prompt normalization prominent. Full contributors, notification runners and state
serialization/broadcast are omitted. Warm caches, short fixed transcripts, one
adapter and 12 active cards limit extrapolation.

## Matched reproduction and small fix

[The retained harness](../scripts/profile-mappings.mjs) creates fresh synthetic
`AW_DATA_DIR` and child provider/home directories before importing production
modules. It never starts `index.js`, calls discovery, launches panes or fetches PRs.
It acquires the real instance lock and requires a second writer to be refused.
No TCP server or tmux server is needed. Only its own generated fixtures are removed
after successful trials. It records native string-write saves without splitting
encode/write; a post-save stat adds small common measurement overhead.

With dependencies installed and Node >=26 on PATH, run from a disposable checkout:

```sh
node --version
node scripts/profile-mappings.mjs 4932 /tmp/aw-mapping-profile
cat /tmp/aw-mapping-profile/results.json
env -u AW_DEFAULT_MODEL AW_BROWSER_TESTS=0 npm test -- server/state-reader.test.js server/atomic-json.test.js server/instance-lock.test.js
env -u AW_DEFAULT_MODEL AW_BROWSER_TESTS=0 npm test
npm run docs:check
```

Use a fresh output directory per run; raw `.cpuprofile` files contain setup and
warm-up as well as the timed window. Inspect them locally with a V8 profile viewer.
To compare revisions, use disposable baseline (`4ce9d7b3`) and fixed checkouts,
carry the identical harness into baseline `scripts/`, and run the command in each
with separate output directories. Sizes 100 and 10,000 exercise scaling. Do not
point any experiment at a real data directory or start the application against
copied live mappings. A future full-server experiment also needs unique ports and
sockets and explicit isolation of all discovery, hooks and external actions.

Matched Node v26.13.1 runs use 4,932 entries / 25.80 MB, 12 on-board records,
zero live panes, two sequential repeats of approximately six seconds each. Each
history run makes 24 scan/sort/label projections; it omits the rest of `buildGraph`.
All archive records have human names; Unicode and fallback behavior are covered
by regression tests, not by this ASCII performance fixture.

| Workload | Before CPU % | After CPU % | Saves/run, before = after | Bytes written/run, before = after | Relevant wall cost, before → after |
| --- | --- | --- | --- | --- | --- |
| Paced, 0.67 saves/s | 3.37–3.89 | 2.61–3.65 | 4 | 103,181,060 | Save 23.05 → 24.11 ms/save |
| Burst, 11.34 saves/s | 21.13–21.48 | 22.31–22.86 | 68 | 1,754,125,193 | Save 17.72 → 18.43 ms/save |
| History portion of rebuild, 4/s | 29.22–30.33 | 4.47–7.09 | 0 | 0 | Projection 67.57 → 8.13 ms/build |

V8 profiles accompany all twelve matched trials locally. Timing and bytes exclude
fixture setup and warm-up. This supports removing unnecessary prompt work when a
higher-priority label wins; it does not show improved save performance. The
before/after CPU ranges include host noise and are not confidence intervals.
Whole-process inclusive `sessionLabel` sampled time in the two history profiles is
1,798/1,867 ms before and 45/65 ms after; these samples include setup/warm-up and
are not CPU accounting.

The fix memoizes normalization within each label call, including an empty result.
Human names, Claude live/cached titles and AI titles can return first; summary-first
adapters still compare cached names to the normalized prompt and retain summary
precedence and shortening. No persisted fields, flush timing, locking, filesystem
operations or acknowledgement semantics change.

Validation: 125 focused tests pass, including label precedence/fallbacks for all
four adapters, process kills during a partial temp write, before rename and after
rename, replacement after recovery, duplicate-writer refusal and stale-lock
reclamation. The repository suite passes 6,078 tests with 11 skips (browser tests
disabled). It needs a runtime that permits filesystem watches; sandbox watch
restrictions caused an initial `EMFILE` failure. Unsetting `AW_DEFAULT_MODEL`
avoids an inherited override of the registry test's expected built-in default.
These checks do not simulate power failure or establish live CPU attribution.

## Findings and ranked persistence options

Supported mechanisms: synchronous `Object.fromEntries` plus whole-map stringify
and replacement on each mutation; eager normalization of long intents during
history projection. Periodic rebuilds need not save: rebuild-only trials saved
zero times. Scan/sort and warmed analysis are small in this fixture. Live CPU
attribution remains uncertain: actual caller mix, active population, prompt
content, extension work and broadcasts are unmeasured. Linear scaling of the
measured 18.95 CPU ms/save predicts roughly 0.95–1.90 percentage points at 0.5–1
save/s, far below 50–95%; this is an inference, not a live measurement.

Safety/effort order below prioritizes preserving synchronous persistence. Every
option requires the one-writer protocol and schema/recovery tests before shipping.

| Rank / option | Effort | Process-crash loss window / safety | Stale-snapshot and durability risks |
| --- | --- | --- | --- |
| 1. Exact dirty/no-op checks at mutation sites | Low–medium audit | No added window for genuinely identical persisted values | `checkStatusFetchedAt` really changes even when checks pass unchanged. Dropping it changes behavior. Whole-snapshot equality still pays stringify; incomplete field checks can discard mutations. |
| 2. Explicit batching, then bounded debounce/coalescing if arrivals justify it | Low–medium | Known synchronous groups can flush before return, including partial changes on error. Timed 100–250 ms debounce adds that crash-loss window only with a maximum-wait bound and appropriate forced flushes. Unbounded debounce can lose an entire busy period. | Snapshot at flush, serialize writes, track generations and post-snapshot dirtiness. Never let an older async completion replace a newer snapshot. Flush critical lifecycle/error/shutdown boundaries; a hard kill bypasses shutdown. 1–2 s arrivals may not coalesce at all. |
| 3. Per-session files or logs | Medium–high | Synchronous atomic replacement per card need add no time window; multi-card/store operations need a transaction manifest or generations | Startup/index overhead; partial multi-file commits and stale indices; retain the instance lock and order publication/replay. |
| 4. Append-only journal plus compaction | High | Synchronous append with sequence/checksum and torn-tail recovery can bound process-crash loss to an incomplete record; group commit adds its interval | Replay order, checkpoint/segment generations, compaction races. Do not discard old segments before safe checkpoint publication. fsync policy defines power-loss window and latency. |
| 5. Cold archive | High; behavior/storage migration | No intentional process-crash window only with atomic generation publication and recoverable cross-store moves | Resume/search must restore before mutation; shared references, old readers, mixed generations and rollback need explicit protocols. Age alone is insufficient. |

The spike's synchronous batch probe reduced 68 mutations to four saves, but it
hardcoded grouping. The real [PR observer](../server/pr-observations.js) awaits
network results sequentially and [the sweep](../server/index.js) persists each
owner's freshness update. Batching the sweep would delay persistence across those
awaits. Neither that probe nor unchanged check status proves a safe save fix.

[Atomic JSON replacement](../server/atomic-json.js) writes a same-directory temp
file then synchronously renames it: process-crash readers see the old or new
complete snapshot on a filesystem with atomic rename. There is no file fsync or
parent-directory fsync; power-loss durability is not established. The
[instance lock](../server/instance-lock.js) refuses a live holder, preventing a
second startup snapshot from overwriting newer state, and probes/reclaims stale
sockets. It currently warns and permits an unlocked start on other bind errors;
the guarantee depends on successful lock acquisition. This fix changes none of
these conditions and introduces no asynchronous writer.

## Retention design only

No retention, cleanup, archival migration or backup of live state is implemented
or executed here. A future policy must first define explicit eligibility; archived
cards are resumable and cannot be removed just because `archivedAt` is old.

Build a reference inventory from mappings, [mailbox](../server/mailbox-store.js),
[tasks](../server/task-store.js), [memory](../server/extensions/builtin/task-memory/memory-store.js),
hierarchy and [PR observations](../server/pr-observations.js):

- Include mail senders, recipients, replies, pending delivery and notification
  state; task assignments, `sessionOrder`, archived task bindings and snapshots.
- Include `memory/tasks`, `memory/scratch` and `memory/by-session` symlink identity
  and targets; parent/spawned-by/fork relationships, live/prior conversation ids,
  billed runs, runtime/location ids and scheduled or extension-owned references.
- Include worktree path/branch/claim ownership, shared repositories, PR URLs,
  observation transition baselines and pending actions. Inventory unknown stores
  or fields as protected until their reference semantics are known.

Protect active/live, dormant resumable, suspended, pinned/held, in-flight
launch/resume/wake, unread/pending mail, active tasks, required hierarchy and
conversation ids, ongoing PR actions and dirty/unmerged/claimed worktrees.
Unknown resumability or pin state means protected. Compute closure to a fixed
point, including shared targets and reverse owners: no surviving object may
reference a removed one. Cycles and cross-task ownership must remain intact.
Do not follow arbitrary symlinks into external trees for deletion.

| Classification | Eligibility rule |
| --- | --- |
| Authoritative session/task/mail/memory state | Explicit abandonment policy or verified restorable cold representation; never age alone |
| Shared referenced state | Retain while any protected or surviving owner needs it |
| Rebuildable indices/caches | Candidate only after proving reconstruction has no resume, billing, transition-notification or action consequences; PR observations are not automatically disposable |
| Temporary files/stale locks | Candidate only after ownership/liveness checks under the maintenance protocol; never unlink a live lock |
| Unreferenced abandoned payloads | Quarantine after closure/revalidation; missing map ownership does not authorize deleting transcripts, worktrees or repositories |

Before mutation, take a consistent backup of all authoritative stores and their
reference closure at one generation. Its manifest records schema/application
version, time, source generations, relative paths, lstat type/mode, symlink
targets, byte sizes, SHA256 checksums, external dependencies and excluded/protected
roots with reasons. Preserve shared-target identity and permissions; do not
silently copy or follow arbitrary external trees. Keep the manifest and raw data
private. Verify every checksum and restore into a fresh isolated data directory;
check bindings, resume prerequisites and graph integrity without launching agents
or external actions. An external transcript dependency must be available or the
backup cannot be claimed to restore resumability.

Stage a new generation and publish its manifest atomically. Quarantine candidates
for a defined rollback period; retain the previous complete generation. Restore
or rollback under the same writer protocol, restoring the whole generation and
bindings together. Reconcile any later mutations before rollback, or preserve
them separately; never overlay old individual files onto a newer running snapshot.

Online inventory is tentative. Online mutation requires an in-process mutation
barrier, a consistent snapshot across *all* participating stores, reference/pin
revalidation at commit, generation-aware readers and leases/tombstones before
reclamation. The existing instance lock alone supplies none of that multi-store
transactionality. Without those mechanisms, future execution requires all writers
offline, an exclusive maintenance lock, fresh inventory and backup, then restore
validation before restart. Do not invoke purge/archive hooks as a deletion
shortcut: they can notify or mutate other systems. No such maintenance operation
is part of this investigation.
