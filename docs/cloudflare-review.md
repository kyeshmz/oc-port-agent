# Cloudflare GitHub App: early independent Phase 1 review

- **Date:** 2026-10-09
- **Reviewer:** GPT-6.1 Sol
- **Disposition:** This bounded review is complete; the implementation is not approved for release. Nine must-fix findings remain, including four high-severity findings. No implementation repairs were authorized or made.

## Scope and limitations

Reviewed the completed `apps/cloudflare/src/contracts.ts`, `apps/cloudflare/src/policy.ts`, `apps/cloudflare/src/core.ts`, `apps/cloudflare/test/core.test.ts`, and Phase 1 `apps/cloudflare/package.json` / `package-lock.json`. Read `.plans/cloudflare-github-app.md` and loaded `handoff-contract`. Read the original CLI's `src/config.ts`, `src/agent.ts`, `src/sync.ts`, and `src/upstream.ts` only for semantic comparison.

**Explicitly excluded:** concurrent Phase 2/3 source and tests, runtime/package integration, Worker/DO/SDK/sandbox implementations, generated bindings, runtime packaging, and Phase 4 integration/documentation. These were not inspected. Contract findings below describe the completed Phase 1 interfaces, not claims about unseen adapters. Full Phase 5 review, repair, and re-review remain outstanding; its completion boxes must remain unchecked.

Preserved pre-existing changes, including the public-repository harness and unrelated `.plans/public-repository-tests.md`. No source, tests, package, lockfile, or original CLI files were edited. No deployment, App registration, publication, credentials changes, remote calls, or paid model calls were performed. No commit was made.

## Independent verification

### Required commands

Exact command: `npx vitest run test/core.test.ts`, with shell working directory `/Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare`.

```text
RUN  v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
Test Files  1 passed (1)
     Tests  21 passed (21)
Start at  10:50:17
Duration  182ms (transform 58%, tests 28%, import 11%, worker 3%)
Exit code: 0
```

Exact command: `git diff --check`, from the repository root.

```text
(no output)
Exit code: 0
```

The tracked diff check does not inspect untracked files. It is formatting hygiene, not a security or behavioral proof.

Also ran `git diff --no-index --check /dev/null docs/cloudflare-review.md` to check the untracked review file itself. It produced no whitespace diagnostics and exited 1 because the new file differs from `/dev/null`; this is not one of the two required command results.

### Additional offline evidence

Ran repository-root `node --input-type=module` stdin probes using Node `v22.21.0`. Transpiled only the reviewed TypeScript files with the locally installed TypeScript package and imported them through in-memory data URLs; reused the completed test fixtures. No probe files or implementation edits were created. All substantive observations below came from corrected, successfully completed probe runs. An initial probe-loader attempt failed because TypeScript removed imports unused in the fixture-only portion; retaining imports corrected the review harness, not the implementation.

Observed outputs:

```text
unsynced-relevance: first=ready-to-publish, second=ready-to-publish;
  second source=[src/other.ts], second edits=[lib/other.ts];
  original target parser still=false; newer checkpoint activation=true.
time-budget-retry: thrown=job-time-limit; persisted=running/agent,
  attempt=2, failure=null; repeated delivery=in-progress.
candidate-cas-rewrite: originalAccepted=false; rewrittenExpectedAccepted=true.
deletion-context-amplification: status=no-op; deletedPaths=300,
  maxFiles=200; agent request JSON=913171 bytes, maxContextBytes=250000.
serialized-response-limit: status=ready-to-publish;
  agent output JSON=18250 bytes, maxResponseBytes=10000.
invalid-unicode-path: safePath=true; status=ready-to-publish;
  UTF-8 path round-trip equality=false.
sensitive-paths: nested/.ssh/id_ed25519 and .aws/credentials selected;
  .ssh/id_ed25519 ignored.
sensitive-target-read: status=no-op;
  nested/.ssh/id_ed25519 content "fake-private-key" reached the agent.
deletion-before-content: status=no-op;
  source.files=[], source.deletedPaths=[src/parser.ts], no before content.
verification-materialization-input: runner target files=[lib/parser.ts];
  verification command=npm test -- --runInBand.
changed-target-sticky-terminal: failed on both deliveries; same job ID;
  agentCalls=1, old pinned target=C, new discovered target=E.
```

Positive Unicode probes: a BOM-prefixed staged file reached `ready-to-publish`; staged contents containing a lone high surrogate, lone low surrogate, or NUL each failed before a runner call. This proves portable string/content checks only, not GitHub byte decoding or live sandbox behavior.

Direct dependency pins matched all eight lockfile entries. The lock pins SDK/plugin `2.0.26`, sandbox `0.13.0-next.776.1`, Wrangler `4.149.0`, and Vitest `5.0.3`. Runtime exports/bundling were intentionally not tested. The plan's prior dependency-audit warning remains unassessed here; no new registry audit was run. Prior root-test/typecheck results in the plan are inherited evidence, not independently rerun results in this dispatch.

## Must-fix findings

### R1 — High: checked progress discards unsynchronized relevant work

**Location:** `apps/cloudflare/src/core.ts:200-205`, `:756-760`, `:864-867`, `:898-902`; `apps/cloudflare/src/contracts.ts:24-25`, `:325-326`.

`validateDiscoveredPlan` requires `fromCommit === lastCheckedCommit`. A verified but unmerged proposal advances `lastCheckedCommit`; subsequent relevance and source selection consider only changes after that checked point. `lastSyncedCommit` remains older, but does not determine the cumulative work included in the next proposal. Merely storing two checkpoint fields does not preserve this backlog.

**Reproduction:** Start with checked/synced at A and target parser=false. A→B changes `src/parser.ts`; produce a verified proposal setting target parser=true, but never publish/merge it. B→E changes only `src/other.ts`; discover from B, supply the unchanged target base with parser=false, and propose only `lib/other.ts`. The core accepts both proposals. A valid mocked merge observation for the second proposal activates synced=E although parser work from A→B never reached the target. The second agent received only `src/other.ts`. Closing/abandoning the first draft or advancing through unrelated commits leaves the same omission risk. Also, unchanged upstream can return `up-to-date` with relevant unmerged work outstanding.

**Minimal fix:** Use the checked marker only to avoid redundant polling. Before creating a replacement proposal, build and validate a cumulative selected comparison from the active synchronized checkpoint to the desired upstream head, or explicitly retain/reconcile all outstanding relevant work. Distinguish the checked CAS origin from the proposal's synchronized comparison origin in the contract. Do not activate a checkpoint past omitted work, or treat an unmerged/abandoned proposal as synchronized. Preserve cheap model-free polling and fail-closed backlog limits.

**Required regression:** Multiple polls with a relevant unmerged proposal, an intervening irrelevant update, and another relevant update. Abandon the first proposal; the later proposal must include both relevant selections or stop safely. Verify target content and synced checkpoint, not just status fields. Also cover unchanged upstream with an outstanding proposal and skipped-only checked progress.

### R2 — High: the verification contract supplies only editable scope, not a complete test workspace

**Location:** `apps/cloudflare/src/contracts.ts:89-97`, `:241-250`, `:334-341`; `apps/cloudflare/src/core.ts:403-405`, `:419-436`, `:800-807`, `:879-888`; fixture at `apps/cloudflare/test/core.test.ts:46-48`, `:53`, `:293-299`.

The core requests and validates target files only within selected edit scopes. `RunnerRequest.target` is that same limited snapshot. The shared GitHub/runner contracts do not explicitly provide a separately bounded complete verification snapshot or trusted materialization capability. Supplying extra read-only test/build files in this snapshot is rejected as out of scope.

**Reproduction:** The existing parser policy permits `lib/**` edits and runs `npm test`. The actual runner request contains only `lib/parser.ts`, not `package.json`, a lockfile, tests, or other implementation dependencies. A runner materializing only its contracted snapshot cannot execute this ordinary target test suite. FakeRunner returns preconstructed passing evidence without materializing anything, so the 21 tests conceal this gap.

**Minimal fix:** Define an explicit trusted-host verification materialization contract pinned to `targetBaseCommit`, separate from the agent's narrow readable/editable snapshot. Include bounded file/tree/byte/mode handling, sensitive/internal exclusions, and complete inventory/post-test comparison. A trusted runner may perform additional reads, but that capability and its bounds must be specified rather than assumed; credentials must never reach its sandbox. Keep arbitrary read-only verification files inaccessible to agent editing.

**Required regression:** A policy editing only `lib/**` with `package.json`, lockfile, tests, and read-only helpers outside that scope. Verify all required files exist in the isolated workspace at the pinned base, actual tests run, and mutations outside the staged edit set are rejected. This is a Phase 1 contract blocker, not a claim that unseen Phase 3 code currently fails.

### R3 — Medium: deleted/modified upstream content has no pinned before representation

**Location:** `apps/cloudflare/src/contracts.ts:81-87`, `:327-333`; `apps/cloudflare/src/core.ts:372-399`, `:793-799`.

`SourceSnapshot` has content at `toCommit` plus deleted path names, but no before files or bounded diff. Validation rejects any additional before/diff field. The agent has no network tool for reconstructing deleted behavior. This differs from the CLI's pinned `before`, `after`, and selected diff (`src/upstream.ts:8-18`, `:101-109`).

**Reproduction:** Delete selected `src/parser.ts` upstream. A conforming snapshot contains `files: []` and `deletedPaths: ['src/parser.ts']`. The accepted agent request contains no deleted implementation, signature, or diff. Two different removed implementations at that path require different target adaptations, but the agent cannot inspect either through this interface. The offline probe accepted a skipped/no-op report with only that path name.

**Minimal fix:** Add bounded source-before content at the pinned comparison origin and after content at the pinned head, or an independently constructed bounded diff plus adequate before data. Cover additions, modifications, deletions, and rename-as-delete/add consistently. Validate modes, UTF-8, completeness, and total budgets for both versions. Coordinate with R1's comparison origin.

**Required regression:** Delete a selected upstream API with target functionality using a different path/language; assert the agent receives the exact previous implementation. Reject wrong-commit, missing-before, invalid-mode, and oversized-before snapshots. Test modified files where the behavioral change cannot be inferred from the after file alone.

### R4 — High: glob matching permits catastrophic regex backtracking

**Location:** `apps/cloudflare/src/policy.ts:127-134`, `:260-285`, `:309-332`; `apps/cloudflare/src/core.ts:222-223`, `:785`.

The permitted glob grammar is compiled to JavaScript regexes containing repeated overlapping `.*` groups. Pattern length and path count limits do not bound regex execution. Filtering occurs before the core starts its job-time clock, and a synchronous regex cannot be interrupted by that clock anyway.

**Reproduction:** Use an operator-approved upstream pattern `'src/' + '**/'.repeat(8) + 'wanted.ts'` and an upstream path `'src/' + 'a/'.repeat(30) + 'not.ts'`. One negative `matches` call took **842.289875 ms** locally. With 12 recursive segments and 40 path segments, one call exceeded an independently enforced **1500 ms** subprocess timeout and was terminated (`ETIMEDOUT`, `SIGTERM`). Both patterns/paths satisfy the parser's grammar and length checks. An attacker needs control only over compared repository paths once such a pattern is approved; the attacker does not control executable policy.

**Minimal fix:** Replace backtracking regex matching with a bounded-complexity glob matcher, cache/precompile validated patterns, and enforce a total matching-work bound. Normalize redundant recursive segments where semantics permit, but do not rely on normalization alone for patterns with overlapping recursive segments separated by literals. Do not simply raise CPU/time limits or weaken filtering.

**Required regression:** Repeated recursive segments, overlapping literal/recursive segments, long negative paths, and the maximum allowed pattern/path work. Use deterministic work limits or a subprocess timeout rather than a fragile microbenchmark assertion. Preserve existing `*`, `**`, `?`, and zero-directory `**/` semantics.

### R5 — High: standard nested private-key paths reach the agent

**Location:** `apps/cloudflare/src/policy.ts:48-51`, `:288-299`; `apps/cloudflare/src/core.ts:419-425`.

The sensitive denylist protects root `.ssh/**`, but not `**/.ssh/**`. Its RSA suffix rule does not catch an Ed25519 private key. It also omits standard AWS credential locations. Scope checks therefore permit these conventional sensitive files under a broad approved read/edit scope.

**Reproduction:** With target scope `**`, provide an otherwise valid pinned target snapshot containing `nested/.ssh/id_ed25519` with stand-in content `fake-private-key`. The core sends that file and content to the agent and returns no-op for a skipped report. `filterChangedPaths` likewise selects `nested/.ssh/id_ed25519` and `.aws/credentials`, while correctly ignoring root `.ssh/id_ed25519`. No real key was accessed during this review.

**Minimal fix:** Protect nested SSH directories and conventional private-key/credential paths consistently before content reads, in agent tools, and in edit gates. At minimum add `**/.ssh/**` and root/nested AWS credential/config paths; decide and document the supported sensitive-path policy centrally. Retain operator-added exclusions. Do not claim that a path denylist detects every arbitrary secret embedded in ordinary source.

**Required regression:** Root/nested SSH RSA and Ed25519 keys, root/nested AWS credentials, and existing environment/npmrc/PEM exclusions with broad source/target scopes. Assert the GitHub adapter is not asked to read excluded content and no agent input/edit can include it.

### R6 — Medium: a job-time failure can escape without a terminal durable transition

**Location:** `apps/cloudflare/src/core.ts:720-723`, `:825-826`, `:916-923`, `:580-582`.

The loop-entry `requireTimeBudget` is outside the error handlers that call `failJob`. A budget exhausted between the previous stage's check and the next loop entry throws but leaves durable state running. The existing time test (`apps/cloudflare/test/core.test.ts:526-539`) tests an adapter-reported duration, not this transition.

**Reproduction:** Use `maxJobSeconds: 1`, a valid first agent result, and a retryable command failure. After persisting stage=agent/attempt=2, advance the injected monotonic clock to 1001 ms. `runJob` throws `job-time-limit`; storage remains `running/agent`, attempt=2, no failure category. A repeated delivery returns `in-progress` without a new agent call. The same uncovered gap exists between successful snapshot completion and first agent-loop entry.

**Minimal fix:** Handle every post-creation budget check through a durable failed/terminal transition before returning. Do not retry a time-limit failure or label it successful. Durable cross-eviction leases/deadlines remain a separate Phase 3 obligation.

**Required regression:** Exhaust the clock before the first loop entry and between verification-failure persistence and retry entry. Assert terminal state, bounded failure category, unchanged checkpoints, no second model call, and non-hanging duplicate-delivery results.

### R7 — Medium: callers can rewrite a persisted candidate's checkpoint CAS origin

**Location:** `apps/cloudflare/src/core.ts:940-950`, `:957-962`; `apps/cloudflare/src/contracts.ts:150-158`, `:287-292`.

Activation compares the caller's `expectedLastSyncedCommit` with the current registration, but never compares it with the persisted proposal's expected checkpoint. Other candidate fields are compared individually, leaving this field outside the persisted-candidate identity check.

**Reproduction:** Persist a verified candidate with expected checkpoint D. Change the active checkpoint to E, representing another successful activation. The original candidate is rejected. Resubmit the same candidate with only `expectedLastSyncedCommit: E`; with the same matching mocked merge observation, activation succeeds and sets synced=B. Storage CAS succeeds because it receives the caller's rewritten E, not the original proposal's D. This is a verified internal gate bypass; no unauthenticated HTTP exploit is claimed because those routes were out of scope.

**Minimal fix:** Validate the complete candidate against the immutable persisted candidate, including expected checkpoint, job ID/key, and tracking ID; use the persisted candidate for confirmation and activation. Preserve store-side CAS and verified-base merge checks. Resolve obsolete candidates explicitly rather than silently rebasing their CAS expectation.

**Required regression:** Create two candidates sharing an original checkpoint, activate one, then attempt to activate the other with both its original expectation and a caller-rewritten expectation. Both stale requests must fail without changing state; the rewritten request should fail before the GitHub confirmation call.

### R8 — Medium: file/context/response budgets do not cover complete serialized data

**Location:** `apps/cloudflare/src/core.ts:278-279`, `:290-322`, `:325-329`, `:379-399`, `:813-816`, `:628-660`; `apps/cloudflare/src/policy.ts:53-64`.

Snapshot budgets sum file contents and count present files only. Deleted paths and plan/path metadata can dominate the model request while consuming none of those limits. Edit response accounting adds raw content/path bytes and a fixed overhead, not JSON-escaped response bytes.

**Reproduction A:** Use 300 deleted selected paths of approximately 1000 characters, no source files, and the ordinary small target snapshot. Default `maxFiles=200`, `maxContextBytes=250000`. The core calls the agent with all 300 deletions; the request serializes to **913171 bytes** and returns no-op. All paths individually satisfy `safePath`.

**Reproduction B:** Set `maxFileBytes=maxResponseBytes=10000`, stage `content='\n'.repeat(9000)`, and return matching verification evidence. The core reaches ready-to-publish although the agent output JSON is **18250 bytes**. JSON escaping exceeds the bound that raw-content accounting accepts.

**Minimal fix:** Define what each budget covers, count complete source entries including deletions, and bound the exact serialized selected model packet and agent response (including escaping, reports, repair context, and metadata) before model calls/persistence. Avoid forwarding irrelevant changed-path metadata to the model; retain separately bounded host evidence if needed. Keep per-file bounds and enforce combined bounds before accepting snapshots or edits. Bound transport/SDK response parsing as well; post-hoc core validation cannot undo an already unbounded allocation.

**Required regression:** Many long deleted paths; many ignored long paths; metadata-dominated requests; escaping-heavy newlines/control characters/quotes/backslashes; multibyte content; retries including prior edits. Assert no model/runner calls on exceeded budgets and unchanged checkpoints. Do not silently truncate context or decisions.

### R9 — Medium: malformed Unicode is rejected in contents, but accepted in paths

**Location:** `apps/cloudflare/src/policy.ts:120-125`; `apps/cloudflare/src/core.ts:297-301`, `:315-316`, `:524-531`.

`safePath` accepts lone UTF-16 surrogate code units. Content validation rejects them, but new edit paths and verification evidence paths do not. Such a path cannot round-trip through UTF-8 unchanged, undermining exact path identity between model output, workspace evidence, and publication.

**Reproduction:** Stage a new file at `lib/\ud800.ts` with ordinary valid content and matching runner path/hash/mode evidence. `safePath` returns true and the core returns ready-to-publish. `TextDecoder.decode(TextEncoder.encode(path)) !== path`. Different lone surrogates can encode to the same replacement character. No claim is made that a live GitHub API accepts this malformed path; the portable gate accepts an unrepresentable path before reaching that boundary.

**Minimal fix:** Reject unpaired surrogates in all path/pattern identity validation before hashing, reading, staging, evidence validation, or publication. Require fatal UTF-8 decoding in the GitHub adapter; do not reject legitimate replacement characters or strip BOMs as a substitute for detecting invalid bytes.

**Required regression:** Lone high/low surrogates in new edit paths, source paths, target inventories, patterns, and workspace evidence; valid astral Unicode paths must remain accepted. Assert exact UTF-8 path round trips and no collisions introduced by encoding. Keep the existing strict content checks and preserve legitimate BOM content.

## Follow-ups and evidence gaps

### F1 — Medium: terminal/stale jobs need an explicit recovery policy

**Location:** `apps/cloudflare/src/core.ts:169-181`, `:580-587`, `:770-781`.

Identity includes installation, repository, base branch, policy, and upstream head, but not target base SHA or a recovery generation. A failed job pinned at target C is reused unchanged after discovery observes target E; a probe returned failed twice with the same ID and only one agent call. Similarly, a stale ready proposal can continue referring to its original target head. This is safe failure rather than demonstrated unsafe publication, so it is a follow-up, not permission to bypass retry limits.

**Proposed follow-up:** Specify operator-authorized recovery and stale-base reconciliation while preserving deduplication, per-target serialization, and publication idempotency. If identity/generation changes are necessary, separate logical publication identity from a bounded verification generation. Test stale-base recovery and duplicate deliveries without creating duplicate drafts or automatically rerunning malicious/terminal failures. Phase 3 recovery/publication implementation was not inspected.

### F2 — Low: package engine declaration permits unsupported tooling versions

**Location:** `apps/cloudflare/package.json:6-7`; `apps/cloudflare/package-lock.json:8413-8415`.

The app declares Node `>=22`, but pinned Vitest requires `^22.12.0 || ^24.0.0 || >=26.0.0`. Node 22.0–22.11 and Node 23/25 therefore satisfy the app's advertised range but not its test toolchain. The reviewed Node 22.21.0 satisfies both; no local test failure is claimed.

**Proposed follow-up:** Align the advertised development engine range with the installed toolchain in Phase 4 and document a supported Node release. Keep exact dependency pins and the local lockfile.

### F3 — Low: several combined tests do not prove each named guard independently

**Location:** `apps/cloudflare/test/core.test.ts:448-467`, `:573-589`, `:591-617`.

The duplicate-decision case exceeds expected decision count and fails before the uniqueness branch. The workspace-drift test combines wrong hash, mode drift, and an extra file, so the first hash mismatch prevents exercising the latter checks. The retry test title promises persistence-before-retry, but assertions inspect final stored evidence rather than the record at the second agent call.

**Proposed follow-up:** Add isolated regressions for uniqueness at the correct total count (multiple selections), mode-only drift, extra-file-only drift, missing/deleted evidence, and durable state as observed inside the next adapter call. Preserve all existing assertions. These test gaps do not imply the corresponding implemented guards are absent.

## Gates that are already present

- GitHub-only HTTPS policy URLs reject credentials, queries, fragments, arbitrary hosts, and non-default ports.
- Safe-path checks reject traversal, absolute/Windows paths, backslashes, controls, and malformed separators; R9 concerns Unicode identity, not those checks.
- Protection checks precede snapshot reads; target snapshots, reports, edits, and verification evidence use strict field allowlists. R5 narrows the incomplete sensitive denylist.
- Reports require complete selected decisions; writes must actually change content; applied decisions need edits; skipped scopes cannot overlap edits; blocked decisions stop verification.
- Staged edits and attempt/step state are persisted before runner/retry effects. Only command failures are retryable, and the portable attempt/step caps are enforced in ordinary paths.
- Passing verification requires all configured commands with zero exit codes, bounded evidence, and a complete diff exactly matching staged content hashes and modes. These checks trust a host runner's measurements, not model claims; the host implementation still needs separate review.
- No publication occurs inside `runJob`; synced activation requires persisted verification and a matching trusted merge observation. R1/R7 concern the checkpoint coverage/CAS identity, not absence of these checks.
- Thrown adapter messages are reduced to bounded failure categories; process stdout/stderr are not accepted as durable verification evidence.

## Planner handoff

Resolve R1/R2/R3 contract semantics before downstream integration relies on the current interfaces. Dispatch bounded repairs to the Phase 1 owner for R1–R9 and regression tests; concurrent Phase 2/3 agents must not independently edit these shared files. No repair is included in this read-only review.

After repairs, independently rerun the focused tests and adversarial regressions. Final Phase 5 must still review the completed control plane, tenant/store boundaries, publisher recovery, DO/SDK recovery, tool identity/permissions, complete Linux verification, dependency/runtime packaging, integration evidence, and build. A passing offline core suite does not establish Workerd viability, real container correctness, exactly-once publication, live GitHub authorization, provider limits, or production readiness.

## Bounded re-review: repair unit A — 2026-10-09

### Updated disposition

This section supersedes the initial unresolved-count disposition for the reviewed subset only. **R4–R9's original portable-core failure scenarios and F3 are resolved.** One additional medium-severity deadline gap, **R10**, was independently reproduced and remains must-fix. **R1, R2, and R3 remain outstanding and reserved for coordinated integration repairs.** Therefore four must-fix findings remain in this review record: R1/R2 (high), R3/R10 (medium). F1/F2 remain follow-ups. No whole-app, runtime, or release approval is given.

R6 resolution is deliberately narrow: both previously identified loop-entry failures now persist terminal state. R10 concerns a different deadline edge after asynchronous evidence validation; the original repair does not close it. R10 is newly verified in this re-review, not proven to have been introduced by unit A.

Read only the earlier review and completed unit A changes in `apps/cloudflare/src/core.ts`, `apps/cloudflare/src/policy.ts`, and `apps/cloudflare/test/core.test.ts`. Contracts were not re-inspected or changed; their reserved repairs were not assessed. Concurrent control-plane/runtime source and tests, whole-app typecheck, package integration, and live service behavior were excluded. No implementation/test edits, plan-checkbox changes, commits, remote calls, credential access, or paid inference occurred. Only this appended documentation section was written.

### Independent required checks

Exact command: `npx vitest run test/core.test.ts`, shell working directory `/Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare`.

```text
RUN  v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
Test Files  1 passed (1)
     Tests  37 passed (37)
Start at  11:23:42
Duration  262ms (transform 46%, tests 44%, import 8%, worker 2%)
Exit code: 0
```

Exact command: `git diff --check`, repository-root working directory.

```text
(no output)
Exit code: 0
```

The core suite retains the earlier safety cases and adds isolated assertions; no weakened gate/assertion was identified in these reviewed files. The diff check is hygiene only and does not include untracked files. Whole-app typecheck was intentionally not run against other agents' in-progress files.

### Resolution evidence and bounds

| Finding | Bounded disposition | Completed code and isolated regression evidence |
| --- | --- | --- |
| R4: regex backtracking | Resolved in reviewed portable matcher/core | `policy.ts:299-417` replaces regex matching with anchored DP and bounded LRU compilation; `policy.ts:440-467` shares aggregate work; `core.ts:793`, `:803`, `:857`, `:910` carries one budget through filtering, inventory, and edit checks. `core.test.ts:413-437` tests recursive patterns, per-match and aggregate exhaustion. |
| R5: credential paths | Resolved for reported conventional locations | Central root/nested exclusions at `policy.ts:48-62`; filtering/edit gates use them, and target requests carry them. `core.test.ts:460-477`, `:774-786` independently test source filtering before reads and rejection of an excluded target snapshot before agent exposure. No universal arbitrary-secret detection claim is made. |
| R6: loop-entry timeout persistence | Original scenarios resolved; R10 separately open | `core.ts:872-879` catches exhausted entry budget and persists terminal failure. `core.test.ts:718-752` separately tests first entry, retry entry, unchanged checked progress, and duplicate delivery returning failed. |
| R7: candidate CAS origin | Resolved | `core.ts:1002-1037` captures exact own string-valued data fields without invoking getters; `:1043-1065` compares every persisted candidate field, including CAS origin, then confirms/activates the stored candidate. `core.test.ts:1015-1062` tests competing candidates and rejects rewritten CAS before confirmation. |
| R8: serialized/count bounds | Original portable scenarios resolved | `core.ts:244-246` bounds discovery path metadata, `:402-435` counts deletions, `:860-863` enforces combined entries, `:685-687` omits unrelated model path metadata, `:658` bounds the exact response, and `:898`, `:944-951` bound agent/runner packets and runner response. `core.test.ts:631-700` isolates counts, metadata, escaping, and repair-packet amplification. Actual adapter transport/SDK parsing bounds remain a final integration review obligation. |
| R9: Unicode path identity | Resolved in portable path/content checks | `policy.ts:144-174` rejects unpaired surrogates in paths/patterns; all reviewed inventory/edit/evidence checks use `safePath`. `core.test.ts:386-403`, `:799-848` test malformed source/target/edit/evidence paths and positive astral paths. Fatal GitHub byte decoding is not proven by these string-level tests. |
| F3: combined test gaps | Resolved for the reported gaps | Correct-count duplicate decisions at `core.test.ts:554-573`; mode-only, extra-only, and missing workspace evidence at `:868-912`; durable failure/attempt evidence inspected inside the next agent call at `:914-958`. Additional independent probes distinguish exact deletion from operation-mismatched evidence. |

All file references in this table are within `apps/cloudflare/src/` or `apps/cloudflare/test/` as appropriate. Earlier finding citations above remain historical and have not been rewritten.

**Complexity assessment:** Matching has O(token count × path length) work, O(path length) live DP state, and no recursive/backtracking search. The explicit charge occurs before DP array allocation and accumulates across the reviewed core job. The 20,000,000-unit ceiling bounds matching work, not literal elapsed CPU milliseconds. Tokenization, bounded LRU maintenance, and path validation are additional bounded work. Global compiled-pattern retention is capped by both 4,096 entries and 256,000 pattern characters. These limits are fail-closed: legitimate but excessively large policies/path sets may be rejected. Workerd CPU/memory calibration and other adapters' use of shared budgets remain excluded; exported helpers with default budgets do not automatically aggregate a caller's separate operations.

### Independent adversarial replay outputs

Ran two successful repository-root `node --input-type=module` stdin probes. Imported reviewed source and fixture helpers through in-memory TypeScript-transpiled data URLs, with strict assertions; wrote no probe/source files. For cache measurements only, appended an in-memory read-only statistics export accessing the existing private cache. Monotonic clock and crypto instrumentation were process-local and restored afterward.

```text
R4 recursive negative match, 8 recursive / 30 path segments:
  false, work=4118, observed duration=0.389250 ms.
R4 recursive negative match, 12 recursive / 40 path segments:
  false, work=6734, observed duration=0.090917 ms.
R4 recursive negative match, 12 recursive / 60 path segments:
  false, work=9694, observed duration=0.091583 ms.
R4 small-grammar parity with prior regex semantics:
  11040 comparisons, 0 mismatches (non-exponential inputs only).
R4 aggregate amplification:
  PolicyValidationError at used=19998444, ceiling=20000000.
R4 cache churn:
  5000 short patterns -> 4096 entries / 69536 characters;
  additional 600 long patterns -> 255 entries / 255255 characters.

R5 conventional source credential locations:
  14 excluded paths, irrelevant, sourceCalls=0.
R5 nested SSH target stand-in:
  blocked, agentCalls=0; request carries nested-SSH exclusion.
R5 nested AWS credential edit:
  blocked/protected-edit, runnerCalls=0.

R6 first-loop deadline:
  failed/terminal/job-time-limit, agentCalls=0.
R6 retry-loop deadline:
  failed/terminal/job-time-limit, agentCalls=1;
  repeated delivery=failed.
R7 candidate identity:
  rewritten CAS rejected, 7 field mutations rejected;
  candidate getter rejected without invocation, valid original accepted.

R8 original 300 long deletions:
  snapshot-limit before job creation, agentCalls=0.
R8 201 short deletions with maxFiles=200:
  blocked/invalid-snapshot, agentCalls=0.
R8 50 deleted paths, serialized path array=5641 bytes,
  maxContextBytes=10000:
  complete selected packet rejected with context-limit, agentCalls=0.
R8 escaping-heavy original response:
  failed/response-limit, runnerCalls=0.
R8 repair packet:
  failed/context-limit, agentCalls=1, runnerCalls=1; no second model call.
R8 exact serialized response boundary:
  10000 bytes accepted; 10001 bytes rejected with response-limit.
R8 exact serialized context boundary under a fixed monotonic clock:
  1918-byte request accepted at limit=1918;
  rejected before agent call at limit=1917.

R9 lone high/low surrogate edit paths:
  safePath=false, failed before verification.
R9 astral and legitimate replacement-character paths:
  safePath=true, ready-to-publish.
R9 BOM-prefixed content: ready-to-publish.
F3 exact delete evidence: ready-to-publish;
  write-for-delete and delete-for-write: blocked/forbidden-mutation.
```

Timing figures are observations, not regression thresholds or deployment proof. Passing positive Unicode/BOM cases also preserves legitimate content rather than repairing invalid identity by replacement.

### R10 — Medium, must-fix: deadline is not rechecked after asynchronous evidence validation

**Location:** `apps/cloudflare/src/core.ts:587-591`, `:952-955`, `:961-965`.

The runner-completion deadline check occurs before `await parseVerificationResult(...)`. That parser awaits host SHA-256 validation for each staged write. If this validation consumes the remaining time, the success path does not check the monotonic deadline again before persisting ready-to-publish and advancing the checked marker.

**Reproduction:** Configure `maxJobSeconds=1`. Use a monotonic clock initially at 0 and valid agent/runner outputs. Let runner return while the clock remains within budget. Instrument the subsequent awaited host evidence digest to finish at 1001 ms. The core accepts exact content/mode evidence and returns:

```text
status=ready-to-publish
stage=ready-to-publish
elapsedMs=1001
maxJobMs=1000
checkedAdvanced=true
```

This is not a fabricated adapter duration or a forged verification report: the delayed operation is the core's own awaited evidence hash. The probe makes that deadline edge deterministic; near-deadline hashing or host scheduling can cross it in ordinary execution. Synced activation was not performed, and no actual publication occurred.

**Minimal fix:** Recheck the same end-to-end deadline after asynchronous evidence validation and immediately before accepting a successful terminal outcome. A detected expiry must persist failed/terminal `job-time-limit`, leave checkpoints unchanged, and stop publication eligibility; do not raise the time limit or relabel expiry as passing. Audit the skipped-only success path for the equivalent validation-to-success boundary. Keep checks inside handlers that persist failure. This does not require reserved R1/R2/R3 contract changes.

**Required isolated regression:** Delay only the evidence hash so a passing runner result is still on time but hash completion crosses the deadline. Assert failed/terminal state, bounded `job-time-limit`, unchanged checked and synced markers, no ready/publish result, no retry, and duplicate delivery returning failed. Keep a companion within-budget hash case passing. Add a validation-expiry case for skipped-only outcomes if that path can accept results after its deadline.

### Remaining scope and handoff

Request a bounded unit A follow-up for R10 in `apps/cloudflare/src/core.ts` and `apps/cloudflare/test/core.test.ts`; no implementation repair was made during re-review. Preserve the completed R4–R9/F3 regressions. R1/R2/R3 and F1/F2 were not cleared by these results. Full final Phase 5 checks, control-plane/runtime review, complete workspace proof, real byte decoding, provider/transport bounds, and human live-environment approval remain outstanding. No whole-Phase-5 checkbox should be ticked from this bounded result.

## Completed Phase 2 review and R10 repair check — 2026-10-09

### Latest bounded disposition

**R10 is resolved for the reported hash/validation deadline scenarios.** R4–R9/F3 retain their prior bounded resolutions. **Six new grouped Phase 2 must-fix findings remain:** R11–R14 (high), R15–R16 (medium). **R1/R2/R3 remain reserved integration findings**, not newly reported defects here. This leaves nine must-fix findings in this review record: six high and three medium; no critical finding was verified in this dispatch. Earlier sections and dispositions remain historical evidence, not the latest unresolved count.

Read the updated plan, prior review, completed `apps/cloudflare/src/github.ts`, `store.ts`, `worker.ts`, `env.d.ts`, `migrations/0001_initial.sql`, `test/github.test.ts`, `test/control-plane.test.ts`, and the repaired core/test deadline paths. Loaded Workers review guidance. **Excluded:** in-progress `job.ts`, `opencode.ts`, `sandbox.ts`, their tests, Phase 3 packages/platform declarations, final runtime/build/deployment integration, and whole-app signoff. No implementation, contracts, tests, plan checkboxes, credentials, or remote state changed; no commit or paid inference. Only this review section was appended.

### Independent required checks

Exact command: `npx vitest run test/core.test.ts test/github.test.ts test/control-plane.test.ts`, with shell working directory `/Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare`.

```text
RUN  v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
(node:34575) ExperimentalWarning: SQLite is an experimental feature and might change at any time
Test Files  3 passed (3)
     Tests  60 passed (60)
Start at  11:52:12
Duration  331ms (transform 51%, tests 41%, import 7%, worker 1%)
Exit code: 0
```

Exact command: `git diff --check`, from the repository root.

```text
(no output)
Exit code: 0
```

The 60 tests are the requested completed-unit subset, including 40 core tests. The plan's full-app 75-test report and interim typecheck blocker are inherited reports, not independently rerun evidence here. No whole-app typecheck was run against concurrent Phase 3 work. Native SQLite exercises the actual reviewed SQL through a local D1-shaped adapter; it does not prove production D1 concurrency, routing consistency, or Workerd platform behavior.

### R10 closure evidence

`apps/cloudflare/src/core.ts:910-915` rechecks time after agent-output validation; `:962-967` rechecks after awaited verification evidence parsing and persists `failed/terminal/job-time-limit`; `:922-928` and `:973-979` check before checked progress after success persistence. `apps/cloudflare/test/core.test.ts:754-820` isolates delayed evidence hashing, within-budget acceptance, unchanged checkpoints/duplicate delivery, and skipped-only validation expiry.

Replayed the original hash-only probe independently: runner returned within a one-second budget, the subsequent host digest completed at 1001 ms, and the core returned **failed/terminal/job-time-limit**, with checked unchanged and duplicate delivery returning failed. These checks do not replace the still-unreviewed durable runtime's recovery/deadline obligations.

### R11 — High, must-fix: public upstream preflight succeeds, but content reads require installation membership

**Location:** `apps/cloudflare/src/github.ts:595-618`, `:639-644`, `:656-661`, `:908-918`; repository token construction at `:513-543`.

Registration/discovery supports an upstream outside the target installation by falling back to unauthenticated public GitHub reads when token minting returns 422. `readSourceSnapshot` instead unconditionally calls `tokenForRepository` for that upstream. A permitted public upstream therefore fails as soon as selected source content is required.

**Reproduction:** Installation 23 contains only `target-org/target`; `upstream-org/project` is public and not installed. Mock token minting for scopes containing `project` returns 422, while public repository/ref/compare reads succeed. The client returns `targetAccessible=true`, `targetWritable=true`, `upstreamReadable=true`, and successfully discovers the update. Selected `readSourceSnapshot` then fails with `github-api-failure`, status 422, before reading content.

A related name-scope case fails even earlier: public `upstream-org/target` and installed `target-org/target` share the same basename. The combined token request sends installation-relative names, receives the installed target repository, then throws `installation-token-scope-mismatch` rather than taking the public-upstream path. This prevents ordinary fork/canonical-upstream configurations with equal names. The exact returned-full-name check itself is correct and must remain.

**Minimal fix:** Use a consistent trusted upstream-read authorization resolver for preflight, refs/compare, and content/tree/blob reads. Prefer an installation token only for the exact accessible repository; support authenticated-target plus unauthenticated-public-upstream reads, and fail closed for private upstreams without installation access. Distinguish installation-relative repository names from cross-owner full names; do not weaken exact token-scope validation or fallback indiscriminately after unrelated errors. Allow the necessary read helpers to carry an optional token explicitly.

**Required regressions:** Public upstream outside the installation from registration through source snapshots; equal-basename fork/upstream; private inaccessible upstream refusal; private same-installation success; public-to-private transition/removal. Assert that publication tokens never enter snapshots and that public fallback cannot become arbitrary-host access.

### R12 — High, must-fix: publisher only checks the current job's PR, not other outstanding tracked PRs

**Location:** `apps/cloudflare/src/github.ts:1034-1042`, `:1071-1073`, `:1346-1365`.

Every PR query is filtered by the exact current deterministic branch. This correctly recovers the same job, but cannot detect an existing tracked PR for another job on the same target base. Fresh-base checks alone do not prevent overlapping verified proposals prepared against that base.

**Reproduction:** Seed an open draft on `main` with head `oc-port-agent-` followed by another valid 64-character job hash. Publish the current verified job against the same unchanged base. The adapter creates another draft; the mock API now has **two open tracked PRs**. Both observed queries include only the current `head=target-org:oc-port-agent-...` filter; no namespace-wide open-PR check is made.

**Minimal fix:** Keep exact-job recovery, and add a bounded/paginated configured-base open-PR safeguard for other tracked branches before new effects and again before PR creation. Fail closed on truncation/ambiguous matches. Do not block unrelated human PRs indiscriminately. DO serialization must complement this remote-state check, not substitute for it: existing remote PRs may predate local state or have survived an uncertain publication. Retain deterministic recovery and never force-update an unrelated branch.

**Required regressions:** Another job's open tracked draft/non-draft blocks a new publication; the matching job still recovers; unrelated human PR policy is explicit; pagination/truncation is fail-closed; a tracked PR appearing during publication prevents a second draft. Assert no new PR/ref publication effects in the pre-existing-conflict case. No claim is made about the unseen Phase 3 DO's current serialization implementation.

### R13 — High, must-fix: merge confirmation proves original-head contents and ancestry, not merged/base contents

**Location:** `apps/cloudflare/src/github.ts:1478-1508`, especially `:1480-1495` and `:1496-1498`.

Confirmation validates the immutable proposal against the PR's original head, then proves only that `mergeCommitSha` is on the current configured base. It never reads the merge result's tree or checks that the observed base retains the candidate's staged changes/checkpoint. A merge graph can contain the verified head while discarding its tree changes, such as an ours-style merge.

**Reproduction:** Publish the valid proposal/head H, then return a merged PR with merge M on `main`. M has parents C/H but an empty/base tree that omits the proposal's added `lib/parser.ts`. The original H still has exact verified contents and markers. Relationship M→M is identical. `confirmMergedCheckpoint` returns an observation successfully; it made **no merge-commit or merge-tree read**. All relevant refs/ancestry can be consistent with this graph; this is not evidence that a forged model report bypassed head validation.

**Minimal fix:** Independently verify the candidate's persisted publication/checkpoint identity and required edits against the actual merge result and the configured-base proof used for activation. Confirm writes/deletions and modes, not just markers or reachability. Where concurrent base changes or a merge strategy make exact verified-content proof ambiguous, stop for explicit reconciliation/manual review rather than activating. Define whether later base changes/reverts invalidate the observation, and do not use the original branch tree as proof of the current base's contents.

**Required regressions:** Original verified head merged with its edits discarded; merge-result write/mode drift; deletions not retained; unrelated merge/head/checkpoint metadata; merge/squash/rebase strategies the implementation explicitly supports. Include a valid merge retained on the configured base. Assert no synced activation for rejected merged content. Existing head/tree validation remains valuable and must not be weakened.

### R14 — High, must-fix: GitHub operations lack aggregate scan/work and end-to-end time bounds

**Location:** `apps/cloudflare/src/github.ts:37-38`, `:698-746`, `:876-905`, `:955-968`, `:987-1009`, and publication/recovery loops at `:1214-1237`, `:1322-1337`.

The repaired portable matcher has a shared work ceiling, but the GitHub tree loops call `matchesAny` with a new default budget for each call/entry. Thus full scans bypass operation-wide work accounting. The `maxJobSeconds` clock starts only inside blob materialization, after token/ref/tree reads and filtering; zero selected files return without any time check. The declared request ceiling is checked against materialization entry count, not all REST requests across an operation or repeated branch verification. Per-response/per-fetch caps are present, but do not establish aggregate operation bounds.

**Reproduction:** A complete, non-truncated tree contains 1800 excluded `.config/gcloud/key-N.json` blobs. Its JSON is only **229318 bytes**. The existing exclusions require **23603580** aggregate matching work units, above the portable **20000000** ceiling. `readTargetWorkspace(maxFiles=1, maxBytes=1000, maxJobSeconds=1)` nevertheless returns successfully with zero files. Separately instrument token/commit/tree reads to consume 300+300+600 ms; each individual read is below the per-request timeout, but the returned operation elapsed **1200 ms** despite the **1000 ms** budget. The empty materialization path never catches the expiry.

**Minimal fix:** Create an operation-scoped context at each public adapter entry containing a deadline, shared glob budget, and aggregate request/byte counters. Carry it through catalog reads, filtering, pagination, materialization, and publication/recovery rechecks; stop before starting another external read/effect when exhausted. Limit request timeout to remaining operation time and handle empty results through the same deadline checks. Include all scanned entries, not only selected files. Keep complete-data failure semantics, bounded caches, and exact scope checks; do not raise limits or silently truncate to conceal amplification.

**Required regressions:** Many excluded/unselected entries exceed shared work despite a small accepted file set; deadline consumed before blob reads; empty scan after expiry; aggregate requests during repeated recovery verification; no additional side effects once budgets are exhausted. Verify normal within-budget pagination/materialization remains accepted. This is a Phase 2 adapter gap, not reopening the repaired portable R4 matcher or asserting a particular Workerd CPU limit.

### R15 — Medium, must-fix: UTF-8 BOMs lose bytes, and empty text blobs are rejected

**Location:** `apps/cloudflare/src/github.ts:199-203`, `:420-425`, `:861-873`.

Fatal decoding correctly rejects invalid UTF-8, but default `TextDecoder` BOM handling strips a leading UTF-8 BOM. `readBlob` returns that stripped string with the original byte count; portable snapshot validation then sees inconsistent bytes. The publication round-trip check likewise strips BOM when decoding valid staged content and labels it invalid. Base64 decoding rejects an empty string even for a legitimate size-zero Git blob.

**Reproduction:** Reading a BOM-prefixed `normal text` blob reports **14 bytes** but the returned string re-encodes to **11 bytes** and is not the exact source content. Publishing a valid BOM-prefixed staged edit fails `invalid-file-utf8` before any API call. Reading a zero-byte regular text blob fails `invalid-github-base64`. Companion ASCII content round-trips correctly; invalid UTF-8 is rejected, and a selected symlink is rejected before a blob read.

**Minimal fix:** Preserve file BOM bytes using fatal decoding with `ignoreBOM: true` at file-content and exact round-trip boundaries. Support empty base64 specifically for validated empty blobs without allowing an empty private key. Continue rejecting malformed base64, size mismatches, NUL/binary content, and unsupported Git modes; do not replace invalid bytes or recompute sizes from already altered content.

**Required regressions:** BOM source/target/workspace reads and publication, zero-byte regular/executable blobs, valid astral and U+FFFD text, malformed UTF-8/base64, and modes. Assert exact content/hash/byte size and successful passage through portable snapshot validation. This is new adapter-level evidence, not reopening R9's passing portable BOM/Unicode tests or restating reserved R3 before-content support.

### R16 — Medium, must-fix: unsigned webhook headers can defeat replay guards or reinterpret a signed event

**Location:** `apps/cloudflare/src/worker.ts:209-234`, `:240-252`, `:255-268`; `apps/cloudflare/src/store.ts:224-242`, `:390-400`, `:403-436`; raw signature coverage at `apps/cloudflare/src/github.ts:1513-1525`.

The HMAC authenticates body bytes, not `X-GitHub-Delivery` or `X-GitHub-Event`. Replay claims use the former, while privileged lifecycle dispatch uses the latter with only minimal signed payload-shape checks. An observer possessing a previously valid signed body/signature pair can reuse it with new headers; no secret derivation or signature forgery is needed. This does not claim that an arbitrary unauthenticated caller can obtain a valid signature.

**Reproduction A — actual reviewed SQL:** Process a valid signed installation suspension, then a legitimate unsuspend and authenticated operator reactivation. Replay the old body/signature with its original delivery header: duplicate, registration remains eligible. Change only that unsigned delivery header: HTTP 202 `accepted=true`, and the legitimately reactivated registration becomes ineligible again. The D1 delivery claim treats it as fresh.

**Reproduction B — Worker with test-store boundary:** A signed `issue_comment` body with `action=deleted`, `installation.id`, and ordinary issue/comment fields is first processed as its original event without deactivation. Reuse identical body/signature but change event header to `installation` and delivery header to a new ID. The Worker accepts it as installation deletion and deactivates the registration. Current dispatch does not require the signed event-specific lifecycle shape or authoritative installation confirmation. Reachability of any particular optional event subscription is not asserted; the stale installation replay in A uses an explicitly supported event.

**Minimal fix:** Treat unsigned headers as routing/delivery hints, not sufficient lifecycle authority. Persist a bounded fingerprint of authenticated raw payloads alongside delivery IDs so relabeling cannot make an old payload fresh; account for legitimate identical payloads through explicit policy/authoritative reconciliation. Validate event-specific signed payload structure, and reconcile installation/repository lifecycle against current trusted GitHub state before treating stale/retyped hints as revocation or reactivation authority. Retention expiry must not make old lifecycle state authoritative again. Preserve exact raw HMAC, atomic replay/outbox transactions, and conservative handling of genuinely revoked access.

**Required regressions:** Same-header duplicate, changed-delivery replay after operator reactivation, unsigned event retyping, old created/unsuspend hints after deletion/suspension, and legitimate current lifecycle events. Assert no inappropriate lifecycle mutation or additional outbox work for stale/retyped inputs. Do not claim delivery-ID deduplication alone is cryptographic freshness.

### Independent probe record and positive gates

Ran four successful repository-root `node --input-type=module` stdin probe batches. Imported only reviewed source/tests through in-memory transpiled modules. Generated ephemeral test-only signing keys, used mocked GitHub fetch, and used the reviewed migration/SQL in memory; no saved credentials, source/probe files, or real HTTP publication were used. A first resource measurement with 1500 entries was below the aggregate ceiling (19584180); the documented threshold-crossing reproduction independently reran at 1800 entries, rather than claiming the first measurement exceeded it.

```text
R10 delayed host hash: failed/terminal/job-time-limit;
  checked unchanged; duplicate delivery failed.
R11 public upstream: preflight allowed and discovery succeeded;
  selected source read failed github-api-failure / 422.
R11 equal basename: installation-token-scope-mismatch.
R12 other tracked PR: existing #31 plus new #18; two open drafts;
  only exact-current-head queries observed.
R13 discarded merge edits: confirmation returned observation;
  mergeCommitRead=false, mergeTreeRead=false.
R14 aggregate scan: 1800 entries / 229318 response bytes;
  23603580 work units, 20000000 ceiling;
  elapsed=1200 ms, requested=1000 ms; zero files returned successfully.
R15 BOM read: reported=14 bytes, reencoded=11, exactContent=false;
  BOM publication invalid-file-utf8, API calls=0;
  empty blob invalid-github-base64.
R16 same-header replay: duplicate, still eligible;
  changed-header replay: accepted, no longer eligible;
  retyped signed comment: HTTP 202, registration deactivated.

Positive tampered existing PR-head gate:
  changed head with matching markers but wrong content rejected
  publication-branch-content-mismatch; no additional PR POST.
Positive mode/encoding gates:
  ASCII exact round trip; invalid UTF-8 rejected;
  selected symlink rejected before blob read.
Positive D1 tenant/revocation/outbox gates:
  missing/inactive installation registration denied;
  failed Queue.send retained pending work with attempt=1;
  old outbox row sent after removal, consumer rechecked eligibility,
  ack=1, retry=0, revoked DO RPC calls=0;
  queue keys only kind/trackingId/version/workId.
Positive atomic webhook/outbox recovery:
  injected SQL transaction failure left delivery=0 and outbox=0;
  retry accepted, exact duplicate rejected, outbox count=1.
```

The last SQL probe injected failure after both replay/outbox statements and proved local transaction rollback followed by loss-free retry. It did not emulate geographically concurrent D1 clients. The changed-head and merged-content probes are separate: rejection of a tampered original PR head does not prove retention of edits in a merge result.

Other present gates include authenticated admin-before-policy parsing, strict operator policy/hash validation, exact installation token repository scopes, private-repository preflight, raw bounded signature bytes, bounded REST bodies with fatal UTF-8 JSON decoding, fail-closed compare/tree truncation, explicit compare pagination/ancestry checks, fresh target-base checks, deterministic branch ownership/content/mode verification, no force updates, and durable identity-only scheduling/outbox. These are valuable but do not clear the specific gaps above.

### Follow-ups and remaining proof

- **F1/F2 remain inherited follow-ups:** stale/terminal job recovery and development engine compatibility. Reserved R1/R2/R3 integration must preserve prior repairs; the new workspace extension alone does not prove end-to-end full test materialization.
- **Outbox concurrency:** concurrent flushers can send the same pending identity before either marks it sent; this is compatible with at-least-once delivery, not exactly-once proof. Final DO recovery review must prove duplicate acceptance is harmless. Evaluate optional claim/lease/backpressure for amplification; no lost job was demonstrated in the reviewed atomic scheduler/outbox SQL.
- **Revocation boundary:** reviewed D1 enqueue and consumer checks prevent new eligible work after recorded revocation. A pre-existing outbox row can still reach Queues and be acknowledged without a DO call. Revocation between eligibility check/RPC or during an already-running job requires the excluded DO's own fresh checks before agent/verification/publication; no claim about its implementation is made here.
- **Evidence coverage:** add real D1/Workerd concurrency and durable handoff tests later. Verify queue retry/dead-letter/lifetime behavior against the final configuration; no deployment limits or live API guarantees are inferred from these mocks.

Planner should dispatch coherent Phase 2 repairs for R11–R16 in the reviewed GitHub/Worker/store/migration files and corresponding regressions, while preserving contracts until the reserved integration amendment. Re-review those repairs independently. Full Phase 5 checkboxes remain unchecked; runtime/package/build proof and human live authorization/approval remain outstanding.

## Completed Phase 3 correctness review — 2026-10-09

### Bounded disposition and scope

**This read-only Phase 3 review is complete, with six new grouped must-fix findings: R17–R18 (high), R19–R22 (medium).** No critical defect was demonstrated. These findings require a planner-owned repair dispatch and independent re-review; this is not whole-Phase-5 approval or a production-readiness claim. Earlier review sections are preserved. The concurrent R11–R16 repairs and reserved R1–R3 integration changes were not assessed or cleared here.

Read the plan, the entire earlier review, completed `apps/cloudflare/src/job.ts`, `src/opencode.ts`, `src/sandbox.ts`, `Dockerfile`, `container/verify.py`, and `test/job.test.ts`, `test/opencode.test.ts`, `test/sandbox.test.ts`. Read Phase 1 contracts, policy, and core for interface/gate context. Inspected installed OpenCode SDK/client/server declarations and relevant initialization/restart code, plus the installed sandbox preview declarations. Consulted the public OpenCode V2 SDK/Cloudflare/plugin documentation and Cloudflare alarm documentation.

**Excluded:** actively edited GitHub/Worker/store repairs, Phase 4 scaffold/config/generated bindings/runtime tests/docs, reserved contract repairs, and live environment behavior. No implementation/test/package/plan edit, checkbox, commit, deployment, credential access/change, model inference, or application-service interaction was performed. Only this review was appended. Public documentation retrieval was read-only. The unrelated public-repository plan and all other agents' work were preserved.

### Independent required verification

Exact command: `npx vitest run test/job.test.ts test/opencode.test.ts test/sandbox.test.ts`, shell working directory `/Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare`.

```text
RUN  v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
Test Files  3 passed (3)
     Tests  18 passed (18)
Start at  12:51:50
Duration  450ms (import 54%, transform 38%, tests 6%, worker 1%)
Exit code: 0
```

Exact command: `git diff --check`, repository-root working directory.

```text
(no output)
Exit code: 0
```

The diff check is formatting hygiene and does not inspect untracked files. All three reviewed test suites passed unchanged. Full-app typecheck/test/build, real Workerd smoke, Docker execution, and Phase 4 integration were intentionally not run against the other agents' in-progress work.

### R17 — High, must-fix: transport/cleanup waits can hang beyond the job deadline, and the alarm does not terminate them

**Locations:** `apps/cloudflare/src/opencode.ts:565-570`, `:648-658`, `:662-666`; `apps/cloudflare/src/sandbox.ts:513-525`, `:550-551`, `:638-655`; `apps/cloudflare/src/job.ts:535-539`, `:601-608`, `:795-798`.

The OpenCode timeout races prompt/wait/message reads, but the error path subsequently awaits `sessions.interrupt` without a deadline; the `finally` path clears the timer and awaits `sessions.remove` without one. Successful execution can also hang in removal. The runner bounds materialization calls, but directly awaits process-start RPCs in both command and helper execution, and directly awaits kills on error. Preview `exec`'s remote `timeout` bounds the launched process, not the wait for the process-start RPC to return. Local output-wait timeouts do not bound those preceding calls or a later kill RPC.

The DO watchdog cannot repair these hangs: whenever `currentRun` exists, `alarm()` merely schedules another alarm in 60 seconds, without checking a durable deadline, recording failure, or cancelling work. It repeats indefinitely while the same isolate stays alive. Durable terminal recovery happens only after losing the in-memory run, not when its time budget expires. `clearAlarmWhenIdle()` also returns while the run is present.

**Independent ordinary failure checks:** With an admitted fake prompt and a five-millisecond budget, delay only the cleanup interrupt: `agent.run` remains pending after 50 ms. Releasing that boundary yields the expected `agent-timeout`. Delay only a runner helper's process-start RPC with a 15 ms remaining budget: verification remains pending after 50 ms; active cancellation returns without destroying that sandbox. Releasing process start yields `runner-time-budget-exhausted`. Calling the actual DO alarm method with an unresolved current run schedules another minute instead of terminalizing it. These are deterministic mocked transport stalls, not a claim about a measured cloud outage or actual model spending.

**Required fix:** Give every external SDK operation, including start/interrupt/remove/kill, a bounded local wait and safe late-completion handling. Keep cleanup bounds separate but finite. Persist a wall-clock job deadline/lease and make the watchdog inspect it even when `currentRun` exists; expiry must prevent later publication/checkpoint progress and record a durable terminal failure, while job-owned cleanup remains recoverable. Do not simply wait for eviction, raise budgets, or mark hung work successful. Avoid holding `blockConcurrencyWhile` over these long operations.

**Regression recommendations:** Individually stall successful-session removal, timeout-path interruption, helper start, verification-command start, and process kill. Advance a fake clock to the watchdog deadline while the same DO instance remains alive. Assert bounded return, terminal durable state, unchanged checkpoints, no publication, safe handling of a late process handle, and eventual cleanup. The existing timeout test makes interrupt/remove resolve immediately and therefore does not cover this finding.

### R18 — High, must-fix: reconciliation bypasses the execution lock and publication retry schedule

**Locations:** `apps/cloudflare/src/job.ts:497-509`, `:513-521`, `:535-550`, `:645-653`, `:657-662`, `:712-731`, `:742`, `:788-792`.

Only `runTracking` claims `currentRun`. `reconcileTracking` checks that field but never claims it; alarm recovery likewise does not hold the same lock. DO events may interleave at external awaits. Two reconciliation RPCs can both load an already-`publishing` record, skip its ready-to-publishing CAS, increment the effect attempt counter, and call the publisher concurrently. A later job-version conflict occurs after those external calls and cannot serialize them retroactively. The same window exists between reconciliation/alarm work and a new `runTracking` invocation.

Additionally, the effect has no persisted next-attempt time. `recoverPublications` attempts immediately on every RPC regardless of the alarm backoff. Duplicate/repeated reconciliation deliveries can consume all five attempts during one brief downstream failure, terminalizing work before the intended recovery delay.

**Independent ordinary failure checks:** Invoke the actual `reconcileTracking` twice against one persisted publishing job, holding only the fake publisher response pending. Both calls reach the publisher: **two publisher calls, durable attempts=2**, followed by one fulfilled RPC and one `job-version-conflict`. Separately, let the publisher report an ordinary transient failure and invoke reconciliation five times sequentially: **five attempts in 6 ms**, ending in `failed/publication-retry-limit` despite scheduled backoff. The storage helper and DO methods were exercised with local boundaries; no remote duplicate PR was created or asserted.

**Required fix:** Serialize all target-mutating/recovery entrypoints through one short-acquired per-instance execution guard, and use a durable publication lease/claim for eviction recovery. Persist the retry due time and check it before claiming an attempt; duplicates before that time must neither publish nor consume the budget. Schedule the earliest durable outstanding obligation. Retain the publisher's remote idempotency/content checks and store CAS: a mutex complements, not replaces, those gates.

**Regression recommendations:** Interleave two reconcile RPCs, reconcile plus run, and alarm plus reconcile at an already-publishing record. Assert one external publisher invocation/attempt and no post-effect CAS race. Repeat delivery before the due time, advance to the due time, and recreate the DO to verify durable backoff. Keep genuine failure/attempt caps enforced.

### R19 — Medium, must-fix: ordinary teardown failures have no durable cleanup obligation

**Locations:** `apps/cloudflare/src/sandbox.ts:605-612`; `apps/cloudflare/src/job.ts:308-325`, `:616-640`, `:795-798`; corresponding core terminalization at `apps/cloudflare/src/core.ts:957-967`.

The runner removes its active entry before teardown. If final `destroy()` fails or times out, it throws `runner-cleanup-failed`; the core persists a failed terminal job. The DO cleanup table is populated only while converting queued/running interrupted jobs to terminal failure. On the next alarm this already-terminal job is not an interrupted candidate, so no cleanup retry is queued. A failed teardown can therefore leave its job-owned container running until platform lifecycle behavior stops it, with no durable application cleanup obligation.

The interrupted-job path also writes terminal state and only then inserts its cleanup request. Those are separate operations across an `await`, rather than an atomic terminal-state/outbox transition. Failure after the terminal write but before the request insert loses that cleanup obligation as well.

**Independent ordinary failure check:** Let the initial stale-container reset succeed, all fake verification/inventory work pass, and only the final teardown report an outage. The runner rejects `runner-cleanup-failed`. A later explicit `cancel(jobId)` successfully performs a third teardown attempt, demonstrating that cleanup is possible; the production lifecycle has no persisted request to trigger that later call. No actual leaked cloud container was observed.

**Required fix:** Durably register job-owned cleanup before container effects can occur and retain the obligation until confirmed destruction. Terminalizing a job must not discard pending cleanup. Make terminal-state/cleanup-request transitions atomic or order them so interruption cannot lose work. Bound retries and expose unresolved cleanup to the operator without weakening verification or reporting a false successful job.

**Regression recommendations:** Fail final destroy after both passing and failing commands; recreate the DO with the terminal record and pending cleanup, then verify alarm-driven retry and request removal only after success. Interrupt between terminal persistence and cleanup bookkeeping. Assert no model/verification/publication replay during cleanup.

### R20 — Medium, must-fix: accepted cancellation can be lost before an adapter becomes active

**Locations:** `apps/cloudflare/src/job.ts:524-532`, `:579-605`; `apps/cloudflare/src/opencode.ts:583-598`, `:662-664`; `apps/cloudflare/src/sandbox.ts:616-625`.

`cancelTracking` only signals the adapters for records currently marked running; it does not persist cancellation or communicate it to the core orchestration. During discovery there may be no record to cancel. During snapshotting the model has no in-flight session and the runner has no active process. In those states agent cancellation is a no-op, while runner cancellation only destroys an inactive job sandbox. Once pending discovery/snapshot reads finish, the existing run proceeds to create a fresh session/sandbox and can still publish. A similar gap exists while session creation is pending, before the agent's `inFlight` entry is installed.

This is a source-confirmed lifecycle error in the optional internal/operator RPC, not a claim that an unauthenticated cancellation route exists. The existing cancellation test starts cancellation only after a fake verification command is active; it does not test the earlier states.

**Required fix:** Persist cancellation for the current run/job generation and check it before subsequent agent, verification, publication, and checkpoint effects. Make cancellation visible while discovery/snapshot/session creation is pending, and clean up late-created resources. Return an honest result when no cancellable generation exists. Preserve verification gates and do not automatically rerun a cancelled generation on duplicate delivery.

**Regression recommendations:** Hold discovery, snapshot reads, and session creation individually; request cancellation, release the pending boundary, and assert no later model/verification/publication effect and a durable cancelled/failed terminal outcome. Recreate the DO and resend the original delivery. Retain the active-process cancellation regression.

### R21 — Medium, must-fix: retained unmerged publication records eventually stop reconciliation and new work

**Locations:** `apps/cloudflare/src/job.ts:299-305`, `:547-549`, `:751-785`; record/effect tables at `:193-215`.

Published records change status only after successful merge activation. A closed/abandoned unmerged draft remains `published` whenever merge confirmation returns no observation; there is no obsolete/closed terminal transition or pagination cursor. Alarm handling throws before any reconciliation when it sees more than 32 published records. Per-tracking reconciliation throws at 128 records before processing any, and `runTrackingInternal` calls that reconciliation before discovery. Repeated legitimate abandoned proposals can therefore permanently halt the target. Merely limiting a SELECT does not bound lifetime retained work.

**Independent check:** The actual alarm method with 33 retained published records rejects `too-many-published-jobs-to-reconcile` before processing any merge. The 128-record pre-discovery halt follows directly from the reviewed call graph. No live PR history or production storage limit was simulated.

**Required fix:** Define a safe lifecycle for closed, superseded, stale, and merged publications, and paginate bounded reconciliation rather than permanently refusing the complete retained history. Add retention/aggregate storage policy for job proposals, effects, and SDK session data, while preserving evidence required for checkpoint/publication recovery. Never activate an abandoned proposal or silently discard unresolved external effects to reduce the count.

**Regression recommendations:** Accumulate more than 32 and then 128 closed-unmerged publications over successive polls; verify bounded reconciliation progress, unchanged synchronized checkpoints, and continued eligibility for fresh work. Cover a still-open publication and a merged publication across page boundaries and eviction. Assert archival never causes duplicate publication or loss of required checkpoint evidence.

### R22 — Medium, must-fix: helper directory bounds are checked only after traversal/allocation

**Locations:** `apps/cloudflare/container/verify.py:102-117`, `:150-156`; helper invocation at `apps/cloudflare/src/sandbox.ts:332-337`, `:661-669`.

`walk_workspace` appends directory paths throughout traversal but checks the directory ceiling only after the entire walk. It also appends each non-root directory once from its parent's `dirnames` and again when visiting that directory, applying the ceiling before deduplication. A verification command that ordinarily generates many empty output/cache directories is not stopped at the advertised directory bound; the helper sorts and retains those entries until traversal completes or its remote timeout expires. Duplicate accounting can reject sufficiently deep valid bounded trees before the unique-directory limit is exceeded.

This is source-confirmed resource accounting, not an attack demonstration or a claim about measured container memory exhaustion. The helper file-byte/file-count checks are present, and the remote 15-second helper timeout is useful, but neither establishes an incremental directory/scan-work bound.

**Required fix:** Count unique directories exactly once and charge directory/entry traversal before retaining or descending into the next entry. Stop as soon as the bounded inventory/work ceiling is exceeded, including empty-directory cases. Keep strict path/mode/text checks and fail-closed incomplete inventories. Avoid buffering/sorting an arbitrarily large single directory before applying the work ceiling.

**Regression recommendations:** Use ordinary Python unit fixtures or a deterministic fake directory iterator for an over-limit empty-directory tree and a within-limit deep tree. Assert early rejection at the work limit, correct unique counts, bounded retained metadata, and preserved normal file/mode/hash evidence. No special filesystem manipulation or exploit fixture is needed.

### Present gates, API consistency, and remaining evidence gaps

- **Real API consistency:** Installed `@opencode/sdk`/client `2.0.26` supports the used session create/prompt/wait/interrupt/remove calls and ascending paginated `message.list`. Inspecting the final assistant's error/finish instead of equating prompt admission with success is correct. The preview sandbox `0.13.0-next.776.1` exposes argv `exec`, process handles, text `output` with byte/wait options, `kill`, `start`, and `destroy`; the Dockerfile uses the matching preview Python image. These checks substantiate API shape, not a deployed provider/container cycle.
- **Initialization/schema positives:** The DO extends the platform base class, initializes under `blockConcurrencyWhile`, retains one SDK host per lifetime, and does not wrap the long core job in that gate. Application table names are explicitly `ocpa_*`. Job versions use SQL CAS; publication status/attempts are recorded before the publisher call. Those mechanisms are valuable but do not close R17/R18.
- **Tool/evidence positives:** The plugin removes inherited tools/agents/MCP and restricts the dispatched tool list. Tools resolve SDK session identity through a host-local registry, enforce path/selection/protected edit gates, and do not receive GitHub credentials. The runner uses a deterministic job-owned sandbox, requests no egress, passes non-secret environment values, uses argv plus a non-root runner user, and independently compares pre/post file hashes, modes, directories, and expected staged edits. Raw process output is omitted from durable evidence. Scoped/full-workspace contract completeness remains reserved R2, not cleared here.
- **F4 — SDK restart policy still needs an actual runtime regression:** Installed `@opencode/sdk/dist/workerd.d.ts:17-19` explicitly promises suspended-session replay. `dist/chunks/logging-d9bx5h6j.js:39-40` forks the replay sweep during embedded host creation; `dist/chunks/logging-y51agw8v.js:19-36` registers supplied plugins afterward. The application constructs a fresh empty tool registry on boot and persists no job-to-session identity; after eviction `agent.cancel(jobId)` cannot find the previous session. Thus app-level terminalization does not itself prove that prior SDK execution/session data was stopped/removed before boot recovery. The context hook rejects unknown registered sessions once installed, which is a useful fail-closed gate. **No model request, tool execution, or permission bypass during this startup window was demonstrated.** Add a credential-free Workerd test with a suspended SDK turn, reconstruct the host, and prove the intended no-replay/terminal cleanup policy and hook-installation ordering. If reconstruction is required, use documented installed SDK instance configuration rather than assuming top-level registration precedes replay.
- **F5 — adapter byte/work claims need transport-level coverage:** Message byte/count limits in `opencode.ts:608-628` are checked after SDK pages have been parsed and session output persisted. Tool staging/report limits similarly operate after model tool inputs exist. Provider output-token metadata and post-hoc checks are not a demonstrated streaming byte ceiling matching every configured job response limit. Repeated tool/runner glob operations also create default matcher budgets rather than sharing one operation-wide counter. Profile and test these boundaries in the final runtime review; no actual Worker OOM, paid usage, or complete bound bypass was demonstrated here.
- **Test honesty:** `test/job.test.ts` never instantiates `TargetJobDO`; its fake SQL recognizes query strings rather than executing SQLite. Its publication test invokes effect-store helpers, not `publishJob` or concurrent RPCs. OpenCode tests use a fake runtime and manually invoke step/tool dispatch, not the bundled plugin factory. Sandbox tests synthesize inventories and command exit values; the output-bound test uses short output and does not trigger truncation/exhaustion, and the fixed-helper fixture is not executed. These are useful boundary tests, not SDK boot, full image execution, no-egress enforcement, actual acceptance-test behavior, or deployment proof. Phase 4's independently owned runtime/container checks were excluded rather than assumed missing or passing.

### Supplemental offline check method and handoff

Ran three successful repository-root `node --input-type=module` stdin checks, transpiling reviewed files and fixture definitions in memory with the installed TypeScript compiler. Added only in-memory fixture exports; wrote no probe/test/source files. Used fake transport/process boundaries, the completed fake SQL helper, and actual reviewed adapter/DO prototype methods with explicit injected state. GitHub/Worker/store implementations were stubbed rather than read or exercised while their repairs were in progress. The mocked probes establish the described local control-flow defects, not real Workerd event scheduling, remote GitHub idempotency, cloud container leakage, or deployment behavior.

After appending this review, reran repository-root `git diff --check`: no output, exit 0. Also ran `git diff --no-index --check /dev/null docs/cloudflare-review.md` for the untracked review file: no whitespace diagnostics, exit 1 because the new file differs from `/dev/null`. That expected no-index status is not a failed required verification command.

Planner should dispatch narrowly owned repairs for R17–R22 and their regressions, coordinating any deadline/cancellation/cleanup contract changes before editing shared files. Preserve existing gates and tests. Re-review all accepted repairs, then separately assess the excluded Phase 4 runtime/integration evidence and reserved R1–R3 work. No source repair, whole-Phase-5 approval checkbox, or commit is included in this dispatch.

## Bounded re-review: completed GitHub repair unit B — 2026-10-09

### Latest disposition for this unit

**R11–R15 are resolved for the reviewed original scenarios. R16's body-digest replay, signed-shape dispatch, and no-webhook-reactivation repairs address the original replay/retyping scenarios, but lifecycle correctness is not cleared:** three newly verified medium-severity findings, **R24–R26**, remain. No new critical/high defect was demonstrated in this dispatch. The new findings are normal webhook/API/concurrency correctness cases, not exploit demonstrations.

This updates the disposition of repair unit B only. Reserved R1–R3 integration remains outside this review. R17–R22/unit C repairs are in flight and were neither inspected nor cleared. R23's real SDK initialization blocker is known from the plan/Phase 4 report; it was not independently exercised here. **Whole release approval and all full-Phase-5 checkboxes remain withheld.**

Read the updated plan, previous R11–R16 findings/evidence, repaired `apps/cloudflare/src/github.ts`, `src/worker.ts`, `src/store.ts`, `migrations/0001_initial.sql`, `test/github.test.ts`, and `test/control-plane.test.ts`. Used the existing core/policy for local adapter/gate context and ran the required 40-test core suite as part of verification. Excluded active job/OpenCode/sandbox/helper source and tests, Phase 4 configuration/runtime evidence, and reserved contract work. Only this review was appended; no source/test/package/plan change, commit, credential access/change, remote application-service action, paid inference, or approval checkbox occurred. Public payload-schema/rate-limit documentation retrieval was read-only.

### Independent required checks

Exact command: `npx vitest run test/core.test.ts test/github.test.ts test/control-plane.test.ts`, shell working directory `/Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare`.

```text
RUN  v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
(node:73490) ExperimentalWarning: SQLite is an experimental feature and might change at any time
Test Files  3 passed (3)
     Tests  75 passed (75)
Start at  13:27:34
Duration  1.82s (tests 81%, transform 17%, import 2%)
Exit code: 0
```

Exact command: `git diff --check`, repository-root working directory.

```text
(no output)
Exit code: 0
```

These independently match unit B's reported 75 passing tests. Native in-memory SQLite runs the repaired migration and SQL through a D1-shaped adapter, not Cloudflare D1. Mocked REST requests establish local authorization/read/publication control flow, not live GitHub behavior or deployment viability. No full-app typecheck/build/runtime run was performed against in-flight unit C files. The tracked diff check does not include untracked files.

### Resolution evidence

All paths in this table are relative to `apps/cloudflare/`. Historical citations above remain unchanged.

| Finding | Bounded disposition | Code and regression evidence |
| --- | --- | --- |
| R11: public upstream / equal basename | Resolved | `src/github.ts:597-665` resolves exact installation full names to numeric repository IDs, validates the returned one-repository scope, and separates read/publish tokens. `:677-711` falls back only to an anonymously readable, exact-name, non-private upstream; `:799-836`, `:1126-1129` reuse that resolver. `test/github.test.ts:387-481` covers public preflight, references, discovery, BOM source reads, absent upstream Authorization headers, and privatization refusal; `:483-545` covers private equal-basename ID scopes and content reads. An independent public equal-basename check also passed through preflight and source materialization with five anonymous upstream reads. No credential-bearing snapshot was observed. |
| R12: overlapping tracked PRs | Resolved for new-publication guards and same-job recovery | `src/github.ts:1711-1747` scans up to ten complete configured-base open-PR pages without an exact-head filter, identifies other same-repository tracked branches regardless of draft status, and fails closed on the pagination ceiling. Calls at `:1277`, `:1308` guard new effects and final PR creation; exact-job recovery remains at `:1269-1274`, `:1309-1310`, `:1332-1334`. `test/github.test.ts:815-830`, `:858-910` retains ambiguous-effect recovery, independently blocks draft/non-draft conflicts, permits unrelated human PRs, rejects truncation, and catches a conflict arriving before PR creation. A separate tracked draft on page two was rejected before any ref/PR publication. |
| R13: actual merged/base contents | Resolved for original discarded-tree scenario and tested strategies | `src/github.ts:1632-1678` reads the actual merge commit, validates a supported parent shape, compares its full diff against the base parent, and requires the exact staged writes/deletions. `:1598-1628` checks actual text and evidence mode; `:1887-1893` additionally inspects the observed configured-base tree and proves merge ancestry. `test/github.test.ts:952-1055` covers valid two-parent merge, discarded edits, merge mode drift, later base revert, and a valid single-parent deletion strategy. Independent checks rejected changed merged content, a deletion discarded at merge, and a deletion restored on the later base. These tests support single-parent squash/rebase-style content proof, not every multi-commit merge/rebase shape; ambiguous or extra-diff shapes fail closed. |
| R14: aggregate operation bounds | Resolved for reported shared-work/deadline/request gaps | `src/github.ts:322-352` creates one operation deadline and glob budget; `:354-377` counts all response chunks against the operation-wide byte ceiling; `:538-559` charges requests and gives fetch only the remaining deadline. Context is propagated through catalog/ref/compare/tree/blob/publication/recovery paths. Scan loops and empty materialization check it at `:1009-1029`, `:1078-1111`, `:1176-1187`, `:1225-1238`. `test/github.test.ts:683-745` rejects the original 1,800-entry shared-glob case and expired empty materialization; `:747-771` starts timing before discovery ref resolution; `:912-949` rejects recovery at exactly 2,000 REST calls before PR creation. A small independent response test accepted the first 54-byte JSON response and rejected the second when the same context accumulated 108 bytes against a 100-byte ceiling. Byte rejection occurs when the boundary-crossing chunk arrives, not before network delivery or allocation of that chunk; no exact Worker CPU/memory calibration or deployment proof is inferred. |
| R15: BOM/empty UTF-8 files | Resolved | `src/github.ts:217-230` allows empty base64 only at an explicitly selected decode boundary; private-key decoding retains its nonempty default. `:464-469`, `:1059-1075` use fatal file decoding with `ignoreBOM: true` and retain original byte sizes. `test/github.test.ts:387-481`, `:630-681`, `:773-801`, `:832-843` covers BOM source/workspace/publication, empty executable workspace files and empty publication, and malformed UTF-8 rejection. Existing size/mode/NUL checks remain. No live Git blob acceptance was claimed. |
| R16: header-independent replay / lifecycle | Original replay/retyping scenarios repaired; lifecycle still open through R24–R26 | `src/worker.ts:255-259`, `:318-332` derives identity from exact authenticated raw bytes and ignores mismatched event hints; `src/store.ts:244-280` and `migrations/0001_initial.sql:64-79` key claims by installation/body digest. Lifecycle fingerprints have null expiry and survive pruning; ordinary events expire deliberately. Claim tokens gate lifecycle/outbox mutations within the batch. `src/store.ts:476-500`, `:516-542` does not reactivate registrations from created/added/unsuspend hints. `test/control-plane.test.ts:430-468`, `:538-621`, `:719-741`, `:771-890` covers changed headers, stale hints, event retyping, confirmed denial, no webhook reactivation, and actual SQL claim-gated effects. R24–R26 identify remaining normal-shape and fresh-evidence correctness errors not represented by those fixtures. |

No source or test change was made to obtain these results; the required suites were run as supplied. Returning an existing matching draft is recovery, not creation of a second proposal, so the R12 recovery fast path is not itself a new overlap defect.

### R24 — Medium, must-fix: normal installation-repositories payloads are silently ignored

**Locations:** `apps/cloudflare/src/worker.ts:236-241`, `:330-332`, `:362-384`; incomplete fixtures at `apps/cloudflare/test/control-plane.test.ts:574-600`.

The shape classifier accepts an `added` repository-selection event only when `repositories_removed` is absent, and a `removed` event only when `repositories_added` is absent. GitHub's normal event schemas require **both arrays**, with the non-applicable array empty. Therefore ordinary genuine repository additions/removals are classified `other`, acknowledged as ignored, and never reach fresh privilege reconciliation.

**Independent ordinary input check:** Send the existing test installation envelope with `action: removed`, `repositories_added: []`, one ordinary target entry in `repositories_removed`, `repository_selection`, requester, and sender. Configure current access as denied. The actual Worker returns **HTTP 202, ignored=true**, makes **zero** access-check calls, and leaves the registration active. The completed tests omit the opposite empty array, so their passing removal test does not represent the documented payload shape. This is not header retyping or signature forgery.

Schema references read during review:
- `https://raw.githubusercontent.com/octokit/webhooks/main/payload-schemas/api.github.com/installation_repositories/added.schema.json`
- `https://raw.githubusercontent.com/octokit/webhooks/main/payload-schemas/api.github.com/installation_repositories/removed.schema.json`

Both declare the two arrays required and bound the non-applicable array to zero items.

**Required fix:** Accept and validate both documented arrays, require the opposite array to be empty for the chosen action, and preserve the signed installation-envelope checks, bounded repository-list validation, body-digest replay identity, fresh access checks, and no-webhook-reactivation rule. Do not solve this by trusting the unsigned event header alone.

**Regression recommendations:** Realistic full `added` and `removed` envelopes containing both arrays. A current denied removal must deactivate only the approved affected registrations; an accessible stale removal must not. A valid addition must remain a hint, not reactivate. Reject malformed/opposite-nonempty arrays. Exercise both the Worker and the SQLite-backed lifecycle store.

### R25 — Medium, must-fix: an ordinary 403 rate limit is persisted as access revocation

**Locations:** `apps/cloudflare/src/github.ts:558-560`, `:751-767`; `apps/cloudflare/src/worker.ts:286-303`, `:344-355`; `apps/cloudflare/src/store.ts:493-500`.

The REST wrapper reduces non-success responses to a status-only `GitHubClientError`. `verifyTrackingAccessWithContext` then converts any token-mint 403/404/422 or target-repository 403/404 into `targetAccessible=false`. In webhook reconciliation that result is treated as confirmed privilege loss and durably deactivates the registration. GitHub documents that both primary and secondary rate limits can legitimately return 403, so a temporary API-limit condition is not access-revocation evidence.

**Independent ordinary failure check:** Let token minting and exact repository inventory succeed, then return a normal repository GET **403** with `x-ratelimit-remaining: 0`, a reset time, and a rate-limit message. The actual client returns `targetAccessible=false` rather than a retryable/indeterminate failure. Deliver a normal signed suspension hint to the actual Worker with this client: **HTTP 202**, and the registration becomes inactive. No permission was removed in the mock. The check uses ordinary API failure data, not an attack input.

Documentation: `https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit` explicitly describes 403/429 and primary/secondary rate-limit evidence.

**Required fix:** Preserve bounded safe HTTP error classification, including rate-limit/retry metadata, and distinguish authoritative inaccessible/insufficient-permission results from transient or indeterminate failure. Rate limits must defer reconciliation without permanently consuming its lifecycle claim or deactivating registrations. Retain fail-closed registration/publication checks while evidence is unavailable, but do not relabel unavailable evidence as confirmed revocation. Do not persist raw response bodies or credentials in failure records.

**Regression recommendations:** Primary 403 with remaining=0/reset, secondary 403 with retry-after, 429, network/5xx failure, and genuine removed/suspended access denial. Assert temporary conditions leave durable eligibility unchanged, allow subsequent authoritative reconciliation, and never activate checkpoints or publish without successful access gates. Keep genuine revocation promptly applied.

### R26 — Medium, must-fix: delayed lifecycle denial overwrites newer operator approval

**Locations:** `apps/cloudflare/src/worker.ts:262-303`, `:341-355`, `:370-383`; `apps/cloudflare/src/store.ts:62-78`, `:493-500`, `:527-542`.

Lifecycle reconciliation reads registration snapshots, awaits fresh API checks, and passes only tracking IDs to the store. Claim-gated deactivation checks the ID/installation/active flag, but not the registration revision that was checked. A delayed access-denial response can therefore deactivate a newer generation after an authenticated operator has paused/reapproved it with restored access. Body-digest deduplication prevents processing the same body again; it does not make an already-running reconciliation's older privilege observation current.

**Independent ordinary concurrency check using the actual Worker and repaired SQLite SQL:** Start a lifecycle check at active/revision=1 and hold only its denied API response. While pending, an authenticated operator pauses the registration (revision=2), then successfully reactivates it after a new allowed access preflight/reference check (revision=3). Release the older denial: the webhook returns **HTTP 202** and commits **inactive/revision=4**. The newer approved state was overwritten without a CAS conflict. No distributed D1 behavior or live operator action was simulated.

**Required fix:** Carry the checked registration revision/identity into the lifecycle mutation and enforce it atomically with the body-claim-gated update. Treat a changed generation as stale evidence: skip or re-evaluate it instead of applying the previous denial to newer operator-approved state. Repository membership mutation must likewise be scoped to the registration generation/repository evidence actually checked. Preserve atomic replay claims, operator CAS, and prompt handling of genuine current revocation.

**Regression recommendations:** Reproduce the interleaving at both installation suspension/deletion/permissions reconciliation and repository removal. Cover operator deactivate/reactivate and checkpoint-induced revision changes. Assert the old denial cannot overwrite newer approval, while unchanged-revision confirmed denial still deactivates and changed-delivery duplicates still produce no second effect.

### Supplemental ordinary-check evidence and handoff

Ran two successful repository-root `node --input-type=module` stdin checks. Transpiled only reviewed source and completed fixture definitions in memory with the installed TypeScript compiler; added only in-memory fixture/context exports. Used generated ephemeral test-only signing material, mocked REST/transport boundaries, and in-memory SQLite with the actual repaired migration. Wrote no probe/test/source files, accessed no saved credentials, and made no GitHub application API, Cloudflare runtime, or provider inference calls. Supplementary outputs:

```text
normal removal envelope: HTTP 202; ignored=true; fresh access calls=0;
  registration remains active=true
403 primary rate limit: access.targetAccessible=false; lifecycle HTTP 202;
  registration becomes active=false
lifecycle/operator interleave: approved active=true/revision=3;
  older denial then commits active=false/revision=4; lifecycle HTTP 202
R11 public equal-basename: preflight and source read passed;
  anonymous upstream reads=5
R12 tracked draft on page 2: rejected before ref/PR publication
R13 actual merged write content drift: merged-tree-content-mismatch
R13 deletion not merged / later base restoration: both rejected
R14 aggregate response accounting: first response=54 bytes;
  combined=108 against 100-byte ceiling;
  second request rejected github-operation-response-limit
```

The lifecycle race used SQLite-backed state; the normal-shape/rate-limit Worker checks used the completed memory-store boundary, with source-confirmed matching SQL mutation predicates. The aggregate-byte check exercised the actual REST reader with one shared context, not a full cloud request pipeline. Supplemental checks remain ordinary regression evidence, not deployment or exploit proof.

After appending this section, repository-root `git diff --check` again produced no output and exited 0. `git diff --no-index --check /dev/null docs/cloudflare-review.md` produced no whitespace diagnostics and exited 1 because the untracked review differs from `/dev/null`; that expected no-index status is not a failed required command.

Planner should dispatch scoped unit B follow-up repairs for R24–R26 in `src/github.ts`, `src/worker.ts`, `src/store.ts` and corresponding tests, preserving the completed R11–R15 gates and the original R16 replay/no-reactivation protections. No reserved contract or unit C edit is included. Re-review accepted repairs and final coordinated integration before any whole-release approval; known R1–R3/R23 and unreviewed unit C/runtime work are not cleared by this bounded result.

## FINAL independent stable-tree review — 2026-10-10

### Disposition

**The complete saved implementation was independently reviewed. No unresolved critical/high implementation defect or Worker build blocker was verified. Two new medium-severity correctness findings, R27 and R28, require bounded repairs and regressions.** The original R1–R26 scenarios are resolved within the evidence described below; R27 is a residual generation-accounting issue, not recurrence of R1's unsafe checkpoint omission. This approves the demonstrated local test/build scope only, not unattended deployment or the live full GitHub App. Phase 5's accepted-repairs checkbox remains unchecked pending the new findings.

Reviewed all `apps/cloudflare/src/` implementation files, the eight test files, `container/verify.py`, Dockerfile, migration, package/config/generated binding declarations, App manifest, `.github/workflows/cloudflare-ci.yml`, package README, `docs/cloudflare-github-app.md`, the updated plan, and the previous review. Inspected the installed SDK's restart/plugin-registration ordering and the new Worker bundle metafile. Implementation, tests, existing CLI/public harness, and `apps/cloudflare-smoke/` were read-only. Only this appended review and Phase 5 automated plan entries were edited. No commit, Docker command, deployment, secret access/change, provider request, real GitHub operation, or cloud mutation occurred. The unrelated `.plans/public-repository-tests.md` was not resumed or edited.

Current documentation was consulted read-only: [OpenCode V2 Workerd SDK](https://opencode.ai/v2/docs/build/sdk/cloudflare/) confirms one retained host per SQLite DO and the Workerd package condition; Context7 retrieved [Wrangler deployment option definitions](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/deploy/index.ts), confirming `--containers-rollout=none` skips image building/updating. Installed pins and actual runtime checks, rather than current documentation alone, establish the reviewed local API/build baseline.

### Independent command results

All commands ran from the repository root. These are fresh reviewer results, not inherited unit D reports.

```text
$ npm --prefix apps/cloudflare run typecheck
> @oc-port-agent/cloudflare@0.1.0 typecheck
> tsc --project tsconfig.json --noEmit
(no diagnostics)
Exit code: 0

$ npm --prefix apps/cloudflare test
> @oc-port-agent/cloudflare@0.1.0 test
> vitest run
RUN v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
Test Files 8 passed (8)
Tests 121 passed (121)
Start at 10:10:18
Duration 12.88s
Exit code: 0

$ npm --prefix apps/cloudflare run test:runtime
> @oc-port-agent/cloudflare@0.1.0 test:runtime
> vitest run --project workerd
RUN v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
Test Files 1 passed (1)
Tests 2 passed (2)
Start at 10:10:37
Duration 12.17s
Exit code: 0

$ npm --prefix apps/cloudflare run build:worker
> wrangler deploy --dry-run --containers-rollout=none --outdir .wrangler/worker-build --metafile .wrangler/worker-build-meta.json
wrangler 4.149.0
Total Upload: 23156.71 KiB / gzip: 3995.04 KiB
Bindings: TARGET_JOBS (TargetJobDO), SANDBOX (Sandbox), JOB_QUEUE,
  DB, GITHUB_APP_ID (placeholder), OPENCODE_MODEL
Configured container: oc-port-agent-cloudflare-sandbox (Dockerfile)
--dry-run: exiting now.
Exit code: 0

$ npm run typecheck
> oc-port-agent@0.1.0 typecheck
> tsc --noEmit
(no diagnostics)
Exit code: 0

$ npm test
> npm run build && node --test dist/test/*.test.js
> tsc
TAP: tests 37; pass 36; fail 0; cancelled 0; skipped 1; todo 0
The optional installed-OpenCode CLI discovery test was skipped.
Exit code: 0

$ git diff --check
(no output)
Exit code: 0
```

The app/runtime runs reported Node experimental SQLite and missing dependency sourcemap warnings; neither caused a failed test. They printed `Using secrets defined in process.env`; the inspected Vitest configuration replaces the credential binding names with synthetic invalid test values before configuring Workerd. No credential values were read. The Worker dry run listed the configured image but did not build/run Docker or upload a Worker. Root test output confirms the pre-existing public regex/BOM harness remains green.

`git diff --check` covers tracked differences, not the many untracked new app/report files. A separate whitespace check of the edited documentation is recorded below. No registry audit was rerun: the README's dependency advisories and transitive engine warning remain disclosed, not independently cleared.

### Original findings: current closure evidence

All references below are relative to `apps/cloudflare/`. Closure means the original reported local failure mechanism is repaired, not that a live environment has been proven.

| IDs | Current disposition and independently inspected evidence |
| --- | --- |
| R1 | Original unsafe cumulative omission/CAS scenario closed. `src/github.ts:861–929` compares from synchronized origin and separately obtains checked delta; `src/core.ts:245–357`, `:1013–1065`, `:922–963` binds cumulative identity and independent checked CAS. `test/core.test.ts:704–778` retains parser work through unchanged-head and irrelevant polling into the next relevant proposal without an intermediate model call. `:802–836` re-verifies changed bases and blocks a third generation for a fixed source range. R27 below shows that this generation limit is not stable across irrelevant head changes. |
| R2 | Original narrow-workspace contract gap closed. `src/contracts.ts:119–143`, `:288–301`, `:415–420` separates bounded host-only verification data; `src/core.ts:594–690`, `:1200–1237` validates the pinned complete inventory without exposing it to the agent. `src/github.ts:1316–1423` materializes permitted fixed files; `src/sandbox.ts:131–217`, `:499–543`, `:666–697` checks exact full pre/post inventories. `test/integration.test.ts:624–678` actually executes the BOM Node oracle, observes initial failure and repaired success, retains fixed tests/helpers outside agent scope, and rejects failed/out-of-scope adaptations. This is actual local Node execution, not production Linux/container proof. |
| R3 | Original absent-before-content gap closed. `src/github.ts:989–1015` normalizes renames; `:1218–1265` enforces add/modify/delete presence against both pinned trees. `src/core.ts:491–538` checks both commits, exact before/after/deleted completeness and combined bytes. `src/opencode.ts:246–249`, `:329–334`, `:473–480` exposes scoped prior content. `test/core.test.ts:780–800` checks exact removed contents; `test/github.test.ts:718–726` checks rename normalization. R28 below is a separate request-budget integration error. |
| R4–R5 | Original matcher and conventional credential-path failures remain closed. `src/policy.ts:40–62`, `:299–467` retains bounded DP/aggregate core matching and root/nested exclusions; core/GitHub reads and edit checks use those protections. The independently passing policy/core suite retains recursive-glob work and excluded-content regressions. No claim of universal arbitrary-secret detection. |
| R6–R10 | Original timeout persistence, immutable CAS, serialized bounds, Unicode identity, and post-hash deadline scenarios remain closed. `src/core.ts:1132–1188`, `:1238–1260`, `:1289–1415` retains durable failure and complete candidate identity checks; `test/core.test.ts:838–1013`, `:1060–1178`, `:1282–1331` retains isolated limit/deadline/path/evidence/CAS regressions. |
| R11–R15 | Original public-read scoping, overlapping tracked PR, merged/base content, aggregate REST work, and BOM/empty-file cases remain closed. Inspected `src/github.ts:632–833`, `:1130–1200`, `:1425–1519`, `:1735–1862`, `:1895–1932`, `:1985–2093` and retained `test/github.test.ts` regressions. Writes/deletions/modes are independently checked on the owned head, actual merge result, and observed configured base; deterministic recovery never force-updates an unrelated branch. R28 does not reopen the original absence of aggregate request enforcement. |
| R16, R24–R26 | Original replay/shape/lifecycle correctness issues closed. `src/worker.ts:237–242`, `:287–307`, `:310–388` accepts both documented arrays, captures checked revisions, and preserves retryable API errors; `src/github.ts:588–600`, `:797–821` distinguishes rate-limit evidence from denial. `src/store.ts:254–290`, `:504–564` atomically gates mutations on body claim and checked registration revision. `test/control-plane.test.ts:578–741`, `:857–995` covers temporary denial, normal payloads, delayed operator approval, actual SQLite checkpoint-induced revision changes, repository CAS and no-reactivation. |
| R17 | Original unbounded waits/watchdog gap closed. `src/opencode.ts:589–719`, `:744–804` bounds admission, interruption and removal; `src/sandbox.ts:405–450`, `:568–598`, `:712–784` bounds process start/output/kill/cleanup and late completion. `test/opencode.test.ts:294–361` and `test/sandbox.test.ts:424–466` exercise stalls. Additionally, the reviewer invoked the actual `TargetJobDO.alarm` with an expired same-instance run using native in-memory SQLite: job became failed/job-deadline-exceeded, run became expired, and job-owned cleanup ran once. |
| R18 | Original reconciliation concurrency/backoff gap closed. `src/job.ts:1226–1265`, `:1368–1403` shares an operation guard; `:923–954`, `:1783–1913` retains durable claim/lease/due time and uncertain-effect handling. `test/job.test.ts:571–602` checks durable claims/backoff. A supplemental actual-RPC check confirmed simultaneous reconcile calls share one promise/operation and `runTracking` during reconcile is rejected busy. |
| R19 | Original lost cleanup/partial terminalization gap closed. `src/job.ts:898–920`, `:1632–1644`, `:1731–1762` registers cleanup before verifier effects and retains failure obligations. The reviewer injected a cleanup-insert failure into native SQLite: the actual terminalization transaction rolled back, leaving the job running rather than terminal-without-cleanup. Runner final-destroy failure/retry is retained at `test/sandbox.test.ts:457–466`. |
| R20 | Original adapter-admission cancellation gap closed. `src/job.ts:411–457`, `:820–895`, `:1268–1354`, `:1505–1647` persists cancellation and guards later transitions; `src/opencode.ts:593–650` installs cancellation before policy/session admission and removes late-created sessions. `test/job.test.ts:513–530`, `test/opencode.test.ts:306–338` retain regressions. Native SQLite independently rejected admission after persisted cancellation without creating a late job. Whole route/discovery cancellation remains a coverage improvement below, not assumed passing. |
| R21 | Original unbounded-history halt/closed ambiguity closed. `src/contracts.ts:330–334`, `:437–442` makes lifecycle explicit by stored PR number. `src/github.ts:2095–2179` never equates undefined with closed. `src/job.ts:657–758`, `:1006–1075`, `:1916–2005` uses durable due times/keyset cursors and atomic retained cancelled/merged transitions. `test/job.test.ts:532–553`, `:605–658` covers 40-record paging, closure/backoff and actual DO lifecycle methods with mocks. There is no count-based 33/128-record hard rejection in this path. Aggregate retention/operator-recovery documentation still needs improvement (F1). |
| R22 | Original deferred/duplicate directory accounting closed. `container/verify.py:100–166` charges each directory incrementally during scandir traversal. `test/sandbox.test.ts:477–535`, `:580` executes the real Python helper against within-limit nested and over-limit empty-directory fixtures, stopping at the first excess directory. The two similar helper tests are redundant but do not weaken the gate. |
| R23 | Original fresh-SQLite SDK initialization blocker closed. `src/job.ts:1216–1222` initializes the real SDK before app tables. `test/runtime.test.ts:69–120` creates an SDK session and app job, closes the SDK host to make the test actor idle, evicts the actual DO, and reads both persisted records in its reconstruction. Both runtime tests passed independently. This is graceful local idle eviction/session persistence, not suspended model-turn replay proof. |

F2's advertised test-engine mismatch is closed by `package.json:6–8`; the separate transitive `@opentui/core` engine warning is still disclosed. F3's isolated portable guard tests remain present/passing. F1, F4 and F5 are not cleared by assertions: recovery/retention policy, suspended-turn restart ordering, and transport-before-parsing/output-bound proof remain follow-ups below.

### R27 — Medium, must-fix: irrelevant head changes reset target-base generation accounting

**Locations:** `src/core.ts:186–218`, `:1031–1065`; `src/job.ts:513–530`. Current regression: `test/core.test.ts:802–836` keeps `toCommit` fixed throughout the generation-limit test.

The two-generation limit is keyed by the full synchronized `fromCommit`/upstream `toCommit` pair. The irrelevant-poll reuse branch notices prior selected work, but if the target base changed it falls through to that exact-range lookup. An unrelated upstream commit changes `toCommit`, giving the same selected semantic workload a fresh generation budget. Ordinary target-base churn together with README-only upstream changes therefore repeatedly admits fresh agent/test work despite no new selected source behavior. Stale publication guards still refuse outdated bases; this is repeated inference/verification work, not unsafe publication or checkpoint activation.

**Independent deterministic check:** Reused the saved core fixture and actual `runJob` in memory. Four successive plans kept synchronized origin and parser before/after contents fixed, changed the target base each time, and after the first poll changed only README in the checked delta. All four returned ready-to-publish; agentCalls=4, runnerCalls=4, synced unchanged. The existing fixed-head regression correctly stops at two, but does not cover this sequence. No model/provider request or remote effect occurred. Other history/commit caps still impose eventual limits; this is a bypass of the promised two-generation bound, not a claim of literally unlimited execution beyond every cap.

**Required repair:** Preserve cumulative source coverage and stale-base verification, but make the inference-generation ledger stable while selected source evidence is unchanged across irrelevant upstream heads (or safely defer for explicit operator recovery once its allowance is consumed). Do not reset a terminal failure's step/attempt allowance merely because irrelevant metadata advanced. Keep exact proposal/checkpoint identity separate from the logical workload allowance; never reuse verification for a different target base.

**Required regressions:** The four-poll unchanged-selected-content sequence above, including cancelled/failed/stale-publication variants; assert the third generation stops before agent/runner, checked/synced semantics remain correct, repeated deliveries do not reset allowance, and genuinely changed selected source is handled through an explicitly defined new logical workload. Exercise the production durable ledger with real SQLite, not only a fake range list.

### R28 — Medium, must-fix: source request allowance still assumes one fetched version

**Locations:** `src/github.ts:1211–1215`, `:1259–1260`; enforcing request gate at `:568–573`; unique-source-file accounting at `src/core.ts:523–536`.

R3 now fetches both versions of modified files, but `readSourceSnapshot` still sets its request allowance to `maxFiles + 50 + 20`. `maxFiles` intentionally counts unique changed paths, not two versions. Consequently an otherwise small permitted source set can fail solely because the new before/after implementation requires approximately twice as many blob reads as the old allowance anticipates.

**Independent deterministic check:** Used the actual GitHub adapter/request/body reader with mocked authorization and REST responses, regular one-byte files, a ten-second budget, maxFiles=200 and maxBytes=250000. A 100-modification snapshot passed with 100 before files, 100 after files and 204 REST requests. A 140-modification snapshot failed `github-operation-request-limit` at exactly 270 requests; completing it requires 284 even with authorization mocked out. Its 140 unique source paths plus one target file fit the default core file cap, and its contents/metadata fit the context cap. Real authorization adds requests rather than fixing the shortage. No GitHub network request was made.

**Required repair:** Compute the bounded operation allowance from the pinned before/after materialization work, including authorization/tree/commit overhead, while retaining the absolute aggregate REST ceiling and fail-closed truncation/deadline/byte gates. Prefer charging actual required versions/deduplicating immutable blob reads over blindly removing bounds. If an absolute platform ceiling makes a configured maximum infeasible, validate/document that explicitly before partial materialization rather than silently advertising the old unique-file capability.

**Required regressions:** A 140-modified-path tiny-text source under the default policy must complete within a correctly computed allowance; add mixed add/modify/delete and ordinary token-inventory overhead cases. Verify exact before/after content and classifications, and keep independent absolute-request-ceiling/deadline tests failing before further HTTP effects.

### Supplemental check method and outputs

Three repository-root `node --input-type=module` stdin scripts transpiled the saved reviewed TypeScript with the installed compiler and imported it through in-memory data URLs. They wrote no probe/source files and used no stored keys. The core script exported existing fixture helpers in memory; the GitHub script mocked only authorization/HTTP; the job script used `node:sqlite` plus a transactionSync-shaped adapter executing the actual SQL and invoked actual DO prototype methods with bounded local dependencies. All three exited 0 with assertions satisfied:

```text
irrelevant-head + target-base churn:
  outcomes=[ready-to-publish,ready-to-publish,ready-to-publish,ready-to-publish]
  agentCalls=4; runnerCalls=4; syncedUnchanged=true
before/after source reads:
  100 modified paths: passed; before=100; after=100; requests=204
  140 modified paths: github-operation-request-limit; requests=270
R19 native SQLite: cleanup-insert failure rolls back terminal transition
R17 actual DO alarm/native SQLite: failed/job-deadline-exceeded;
  run expired; cleanup attempted once
R20 native SQLite: cancelled admission creates no late job
R18 actual RPC guard: one shared reconcile operation;
  run during reconcile rejected target-job-busy
```

The probes establish ordinary local control flow/resource accounting, not live scheduling, provider spending, D1 replication, or Container behavior.

### Nonblocking coverage and maintainability improvements

1. **Full route-to-real-DO and SDK model/tool-turn coverage remains missing.** The BOM integration's `rpc` at `test/integration.test.ts:515–536` wraps the core and supplies fake publication/merge observations; it does not run `TargetJobDO.runTracking`, the bundled provider/tool hooks, or the production sandbox. Its passing stale-base fixture is a fake-boundary assertion; the separate GitHub adapter regression substantiates the actual adapter gate. Keep the docs' failed `Network connection lost` provider experiment as a failure, not proof. Add a credential-free, SDK-supported transport fixture in a later authorized test dispatch.
2. **F4 restart policy remains unverified.** Installed `@opencode/sdk/dist/workerd.d.ts:17–19` promises suspended-session replay. `dist/chunks/logging-d9bx5h6j.js:39–40` forks replay before top-level plugin registration at `dist/chunks/logging-y51agw8v.js:35–36`. App session mappings/cleanup are now durable, but the local registry is rebuilt empty and the runtime test closes an idle host. Add a synthetic suspended-turn boot regression proving hook ordering, blocked unknown sessions and durable cleanup; no unintended model/tool execution was demonstrated here.
3. **F5 transport/CPU bounds need targeted runtime proof.** Session-message limits are checked after SDK parsing/persistence (`src/opencode.ts:668–681`); per-tool matcher calls retain separate default work budgets. Output-token/model metadata and finite steps are useful limits, not proof of a strict streaming byte ceiling matching every policy value. Calibrate ordinary permitted workloads against Workerd CPU/subrequest limits before live use. Preserve the repaired portable/GitHub aggregate gates.
4. **Add production DO lifecycle regression depth.** Include concurrent alarm/reconcile/publication with delayed completion, cancellation during actual discovery/snapshot reads, eviction with active run/publication leases, retained closed records across more than 128 jobs, and alarm-driven failed-cleanup recovery. Current fake-SQL job tests cannot prove transaction rollback; the supplemental native SQLite check should become a permanent deterministic regression.
5. **F1 operator recovery/retention documentation is incomplete.** Closed-unmerged records are correctly retained and cannot automatically republish the same job, but package docs do not describe an actionable operator recovery procedure or long-term job/effect/session retention policy. Document what a manual run can and cannot reset, safe newly pinned identities, uncertain-publication handling and review of unresolved cleanup. Do not suggest deleting durable evidence or silently reactivating checkpoints.
6. **Strengthen source-negative coverage.** Add isolated wrong-before-commit, omitted/extra before file, deleted-after-present, wrong-mode and combined-before-byte regressions, alongside existing positive modification/deletion/rename cases. Keep model-scoped data separate from verifier-only package/tests/helpers.
7. **Packaging/deployment scope remains limited.** The current metafile still contains `@opencode/util/dist/effect/app-node.js`; the idle SDK/session smoke does not prove every Node-only/provider path reachable in Workerd. The app dependency advisory report is not cleared, actual production Linux/SDK Container execution was not run, and live GitHub App installation/auth/publication/merge is untested. The independently reviewed isolated deployed smoke Worker remains untouched and does not substitute for these gates.

### Phase 5 handoff

After writing this review and the automated plan entries, `git diff --check` again returned no output and exited 0. Separate `git diff --no-index --check /dev/null docs/cloudflare-review.md` and `git diff --no-index --check /dev/null .plans/cloudflare-github-app.md` returned no whitespace diagnostics; each exited 1 because the untracked file differs from `/dev/null`, not because a whitespace check failed.

Independent whole-tree review/checks are complete. All seven listed app/root verification commands above passed. No critical/high or build blocker was found; **R27/R28 remain medium must-fix**, with explicit bounded repair/regression ownership to be granted by the planner. Tick independent-review, passing-final-checks and disclosed/no-high re-review boxes only; leave accepted-repairs and every manual/human release checkbox unchecked. Preserve the historical evidence, all repaired gates, optional Linux code, and the deployed smoke Worker. A passing local suite is not production/live-full-App approval.

## FINAL bounded Unit E re-review — 2026-10-10

### Updated disposition and scope

**R27 and R28 are independently verified closed. No remaining must-fix finding, new critical/high defect, or Worker build blocker was verified in this bounded re-review. Phase 5 is done for the tested local review/repair scope only.** R1–R26 retain the earlier stable-tree review's local closure evidence. This section supersedes the preceding unresolved R27/R28 disposition without rewriting its historical findings or reproductions.

Read the updated Unit E plan, previous FINAL findings, the repaired core/origin-block and durable SQLite lookup paths, GitHub source materialization/request-budget implementation, corresponding core/job/GitHub regressions, and the two operator guides. Independently ran the five requested commands and replayed both original scenarios with extra terminal-status/mixed-classification checks. Implementation/tests/root CLI and the deployed isolated smoke Worker remained read-only. No Docker, deployment, secret access/change, real provider/GitHub/cloud operation, architecture change or commit occurred. Only this appended review and a Phase 5 execution-log entry were written.

### Fresh independent required checks

All five commands ran from the repository root and exited 0:

```text
$ npm --prefix apps/cloudflare run typecheck
> @oc-port-agent/cloudflare@0.1.0 typecheck
> tsc --project tsconfig.json --noEmit
(no diagnostics)
Exit code: 0

$ npm --prefix apps/cloudflare test
> vitest run
RUN v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
Test Files 8 passed (8)
Tests 123 passed (123)
Start at 10:50:13
Duration 12.55s
Exit code: 0

$ npm --prefix apps/cloudflare run test:runtime
> vitest run --project workerd
RUN v5.0.3 /Users/kyeshmz/Documents/personal/oc-port-agent/apps/cloudflare
Test Files 1 passed (1)
Tests 2 passed (2)
Start at 10:50:38
Duration 13.37s
Exit code: 0

$ npm --prefix apps/cloudflare run build:worker
> wrangler deploy --dry-run --containers-rollout=none --outdir .wrangler/worker-build --metafile .wrangler/worker-build-meta.json
wrangler 4.149.0
Total Upload: 23158.23 KiB / gzip: 3995.31 KiB
Bindings: TARGET_JOBS (TargetJobDO), SANDBOX (Sandbox), JOB_QUEUE,
  DB, GITHUB_APP_ID (placeholder), OPENCODE_MODEL
Configured container: oc-port-agent-cloudflare-sandbox (Dockerfile)
--dry-run: exiting now.
Exit code: 0

$ git diff --check
(no output)
Exit code: 0
```

The same experimental Node SQLite/missing dependency sourcemap warnings were non-fatal. Runtime tests use the previously inspected synthetic binding configuration; no credential values were read. The dry run did not build/run Docker or deploy anything. Root checks were not rerun in this narrower dispatch; their earlier independent results above remain historical evidence, not new Unit E results.

### R27 closure: stable conservative synchronized-origin allowance

`apps/cloudflare/src/core.ts:46`, `:204–241`, `:1030–1060` now bounds new job generations by tracking identity, policy hash and synchronized origin, independent of checked marker, upstream head and target base. The blocker hash omits head/base, is retained durably, and is returned on later origin-matching attempts. Exact existing-job recovery remains ahead of this admission check and does not invoke a new model. Model-free irrelevant same-base reuse is preserved; different target bases still require newly pinned verification. All persisted job statuses count toward the allowance, so failures/cancellations cannot automatically refund it. The history query remains bounded/fail-closed, rather than scanning an unbounded ledger.

`apps/cloudflare/src/job.ts:370–371`, `:535–551` supplies an indexed production SQLite lookup by tracking/synchronized-origin/policy. `apps/cloudflare/test/job.test.ts:843–922` executes this real store against native in-memory SQLite with four unrelated heads/new bases. It asserts two ready proposals followed by two failures, exactly two agent/runner calls, unchanged synced origin, checked marker at the second accepted head, three retained records and one blocker. The existing fixed-head changed-base regression remains at `test/core.test.ts:802–836` with the new bounded failure category.

**Additional independent replay:** Re-ran the original four-head scenario using the actual portable core and production `DurableSqliteJobStore` against a fresh native SQLite database, not the fake query-string interpreter. Repeated it with the first two generated records retained as failed/stale-base and cancelled/closed-unmerged. In all three variants, outcomes were ready-to-publish, ready-to-publish, failed, failed; old-origin agentCalls=2 and runnerCalls=2; third/fourth blocker IDs were identical; three records were retained and synchronized progress remained unchanged. A separately simulated changed synchronized origin admitted a fresh job, confirming ledger-key separation only—not demonstrating a merge or permission to rewrite real checkpoints.

**Tradeoff assessed:** This is deliberately stricter than a semantic-source cache: genuinely changed selected work can also be refused after two generations at the same origin. That behavior is an authorized conservative stop, not a new omission/publication defect. `apps/cloudflare/README.md:321–330` and `docs/cloudflare-github-app.md:77–93` accurately describe it, distinguish `lastCheckedCommit` from synchronized origin, state that only verified merge progress supplies the ordinary fresh allowance, and do not claim an implemented reset endpoint. Operator recovery must be separately reviewed; deleting evidence or hand-editing checkpoints is expressly discouraged. No fresh must-fix regression was verified in this admission change.

### R28 closure: classified before/after work within the existing absolute ceiling

`apps/cloudflare/src/github.ts:48–50`, `:1214–1248` validates unique pinned classifications and computes two blob requests per modification, one per addition/deletion, plus the bounded 70-request authorization/inventory/commit/tree reserve. An allowance exceeding 2,000 is rejected before authorization or HTTP. The adapter still carries the operation context through every actual read, retains the original absolute request gate, shared deadline/glob/response accounting, exact tree classification checks, combined content-byte limits and fatal file decoding. This repairs sizing of permitted work without disabling aggregate enforcement.

`apps/cloudflare/test/github.test.ts:558–685` independently passes 140 modifications through ordinary mocked installation inventory/token/repository/commit/tree/blob HTTP, validates both versions, and exceeds the old 270-request cutoff within the new bounded allowance. It also checks mixed add/modify/delete completeness and refuses 966 modifications with zero HTTP calls. The retained request-ceiling regression at `test/github.test.ts:1166` and the existing deadline/byte/completeness tests still pass.

**Additional independent replay:** Re-ran the original actual-adapter HTTP/body-reader probe with authorization mocked out only. The 140-modification case now passes with 140 exact one-byte before files, 140 exact after files, pinned commits/modes, and 284 requests. A mixed addition/modification/deletion passes with exactly the expected before/after/deleted sets and eight requests. A 966-modification request reserves 2,002 requests and fails `source-snapshot-request-limit` before any HTTP call. The saved suite supplies the complementary normal authorization overhead coverage; these probes made no real GitHub request.

```text
R27 production/native SQLite, prior ready/failed/cancelled variants:
  each outcomes=[ready-to-publish,ready-to-publish,failed,failed]
  each old-origin agentCalls=2; runnerCalls=2
  each stable third/fourth blocker=true; retained records=3
  simulated new origin: fresh ready-to-publish job admitted
R28 140 modifications: passed; before=140; after=140; HTTP requests=284
R28 mixed add/modify/delete: exact sets passed; HTTP requests=8
R28 over absolute reserved allowance: source-snapshot-request-limit;
  HTTP requests=0
```

Both supplemental repository-root `node --input-type=module` stdin scripts exited 0 with assertions satisfied. As in the earlier review, they used installed TypeScript transpilation/in-memory module imports, native SQLite or mocked REST boundaries, and wrote no probe files. Neither is Workerd/provider/Container/live-service proof.

### Remaining nonblocking follow-ups and approval limits

- **F1:** The conservative generation/recovery documentation is now explicit and adequate for these repairs. An implemented operator recovery workflow, aggregate evidence/session retention policy and operational handling of uncertain publication/cleanup remain future improvements; no new reset API was required or assumed.
- **F4:** Suspended SDK model-turn replay and plugin/registry startup ordering remain unverified. The passing actual Workerd smoke covers SDK/app record initialization and idle-host eviction persistence, not interrupted inference replay.
- **F5:** Transport-before-parsing byte ceilings, output/CPU calibration and shared per-tool work accounting remain unproven follow-ups, not newly demonstrated defects.
- Full route-to-real-DO execution, SDK model/tool turns, provider-backed coding, production Linux SDK/Container execution and live GitHub App installation/publication/merge remain outside passing evidence. The failed controlled provider transport experiment remains failed evidence. Dependency advisory/runtime-import limits and all human live-release gates remain disclosed.

The saved Phase 5 accepted-repairs checkbox was already checked when this re-review began; its condition is now independently satisfied and it remains checked. All Phase 5 automated review/repair/check conditions are satisfied for the tested local scope. Every manual/human release checkbox remains unchecked. Historical findings and prior command outputs were preserved; this is not production or live-full-App approval.
