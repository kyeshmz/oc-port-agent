# Dedicated live Worker pre-deploy review

Date: 2026-10-10. Scope: final bounded correctness/privacy review of Units A/B/C for `.plans/live-github-flow.md`, Phase 2. **Blocked: do not run `deploy-worker.mjs --execute`, resolve the saved key, or treat the current runtime probe as readiness proof yet.** Three concrete fixes are required; no further whole-App audit is requested.

Implementation was read-only. No private App/auth files, real credential resolution, backend preflight, GitHub/Cloudflare mutations, model calls, Docker, or commits were performed. Public documentation retrieval and local synthetic checks only.

## Must-fix blockers

### B1 — Queue discovery uses the wrong ID format

- Location: `examples/live-github-flow/deploy-worker.mjs:770–790`, especially line 774; tests at `examples/live-github-flow/deploy-worker.test.mjs:229–230`.
- `parseQueuePage` recognizes only 36-character hyphenated UUIDs. Cloudflare Queue resource IDs are not D1 UUIDs: the [Queue API](https://developers.cloudflare.com/api/resources/queues/methods/get/) specifies a resource identifier of at most 32 characters. Installed Wrangler 4.149.0 prints the returned `queue_id` unchanged in its list table (`node_modules/wrangler/wrangler-dist/cli.js:350115–350139`). Current tests manufacture hyphenated UUID Queue IDs.
- A synthetic installed-table-shaped row with a 32-hex ID produces `match: undefined, rowCount: 0`. Thus the controller stops pagination early, misses existing-name conflicts, and cannot verify a just-created Queue. The live command would create D1/main Queue and then fail before saving the Queue ID.
- Minimum fix: parse supported Queue identifiers/table columns separately from D1 UUIDs; reject malformed nonempty table data rather than treating it as an empty page. Preserve exact name/ID ownership checks.
- Required regressions: provisioning and resume with 32-hex Queue IDs; existing-name conflict; wanted Queue on a later page containing ordinary opaque IDs; malformed/duplicate rows fail closed. No live resource creation is needed to prove the fix.

### B2 — Runtime probe mistakes infrastructure failure for the expected assertion

- Location: `apps/cloudflare/src/live-entry.ts:230–249,340–349`; related `apps/cloudflare/src/sandbox.ts:623–645` and `apps/cloudflare/src/sandbox-helper-assets.ts:19–48`; misleading example at `examples/live-github-flow/LIVE.md:79–84`.
- `expectedFailureEvidence` accepts any safe-integer nonzero exit with `command-failed` and no workspace changes. The runner only exposes output byte counts, not evidence of which tests ran. The trusted privilege-drop launcher can return 126 without executing Node; missing Node/import errors or signals can likewise produce a command failure without the expected BOM assertion.
- Synthetic predicate check confirmed that exit 126, zero stdout/stderr, and zero changes satisfies the readiness predicate. HTTP 200 currently does **not** prove the fixed Node test ran with exactly the expected failure. Even requiring exit 1 alone would not distinguish import/runtime failures.
- Minimum fix: a fixed, trusted probe must validate bounded machine-readable test evidence internally and return only a closed summary: all three pinned tests executed, the BOM assertion failed as expected, the nonstring/helper tests passed, and workspace/cleanup gates remained valid. Do not expose raw output or introduce arbitrary command/repository inputs. Update the guide's negative-exit success example.
- Required regressions: expected 2-pass/1-BOM-failure evidence accepted; launcher 126, missing executable, import/syntax failure, signal exit, missing/wrong test, wrong assertion, pass, timeout, truncation, mutation, and cleanup failure rejected. Preserve authentication and secret-free output.

### B3 — Successful partial-deployment recovery is unreachable

- Location: `examples/live-github-flow/deploy-worker.mjs:1165–1169,1350–1354,1420–1429`.
- After a successful Wrangler exit, state is durably saved as `deployment-succeeded` before remote version/evidence verification. On a retry, `assertProtectedPrerequisites` rejects the matching config because its allowed-phase list omits `deployment-succeeded`. This happens before the explicit recovery branch at line 1427. A transient metadata/evidence failure or process interruption therefore strands an otherwise owned deployment.
- Synthetic check confirmed `live-worker-config-ownership-indeterminate` for this phase with matching config and resource IDs.
- Minimum fix: permit that owned phase through prerequisite validation while retaining config digest, resource ID, tag/message, and active 100%-deployment verification. Never reinterpret a failed/ambiguous `deploying` rollout as success or redeploy over an unknown Worker.
- Required regressions: successful deploy followed by metadata failure/interruption resumes without secret resolution, migrations, resource creation, or redeploy; mismatched config/version/ownership still stops; failed Wrangler rollout remains indeterminate.

## Reviewed boundaries without a new blocker

- **Unit A:** Console selection carries only `OPENCODE_API_KEY` to the installed `@opencode/ai/providers/openai-compatible-responses` package and fixed `https://opencode.ai/zen/v1/responses` endpoint. Generic OpenAI is explicit and uses its separate key. Model/HTTP route guards and redirect refusal prevent Console-key fallback; title/compaction/auxiliary requests and retries are constrained. Existing per-job step/time/tool bounds remain in place.
- **Unit B:** exact helper bytes/digest are checked against `container/verify.py`; bounded root bootstrap precedes target materialization; target commands pass through the fixed nonroot launcher with supplementary groups cleared and a closed environment. Internet-disabled startup, complete before/after inventory, hashes/modes, deadline and destruction gates remain. Actual image prerequisites still need live proof after B2 is repaired.
- **Resolver:** installed 2.0.26 declarations confirm `Plugin.Context.integration.get` returns `{ location, data: IntegrationInfo }`, with `data.id` and `data.connections`; `connection.resolve(ConnectionInfo)` returns `Credential.Value | undefined`. `CreateOptions.config.directory/project`, `models.fetch/snapshot`, log `{ level, emit }`, session create/remove, and the import paths match the installed declarations. A local check using the actual installed `Plugin.define` plus a complete synthetic response envelope succeeded with exactly one approved resolve call. It did not create an actual SDK host or read credentials. No declared-interface mismatch was found.
- **Controller privacy/scope:** protected App/state/admin/config modes and ownership checks, fixed account/App/installation/repository, stdin-only secret transport, redacted failures and discarded deploy output are present. Resource ambiguity halts rather than adopting unknown resources. Cron is omitted; the smoke Worker is not selected. B1/B3 are functional blockers, not reasons to weaken ownership checks.

Sources: installed SDK/plugin/client/server/AI declarations and implementation, [V2 SDK guide](https://opencode.ai/v2/docs/build/sdk), [V2 plugin guide](https://opencode.ai/v2/docs/build/plugins), installed Wrangler table/deployment ordering, and the Queue API above. Tests/mocks are not real API, image, or saved-key proof.

## Verification

All five required commands ran and exited 0:

| Command | Observed output |
| --- | --- |
| `node --test examples/live-github-flow/opencode-credential.test.mjs examples/live-github-flow/deploy-worker.test.mjs` | 34 tests, 34 pass, 0 fail |
| `npm --prefix apps/cloudflare run typecheck` | `tsc --project tsconfig.json --noEmit`; no diagnostics |
| `npm --prefix apps/cloudflare test` | 9 test files passed; 149 tests passed (includes 7 wrapper tests) |
| `npm --prefix apps/cloudflare run test:runtime` | 1 test file passed; 2 tests passed |
| `git diff --check` | No output |

Representative terminal output:

```text
# tests 34
# pass 34
# fail 0
> tsc --project tsconfig.json --noEmit
 Test Files  9 passed (9)
      Tests  149 passed (149)
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

Runtime suites emitted experimental SQLite/missing dependency sourcemap warnings, not failures. The tests replace Worker secret bindings with synthetic values. Supplemental synthetic checks confirmed B1/B2/B3 and the resolver's declared metadata envelope; none accessed `.private/` or resolved real keys.

## Handoff and remaining live proof

Main agent should dispatch only these bounded fixes/regressions, then obtain targeted re-review. Existing App ID `5266090` / installation `170044765` metadata is prior evidence, not newly verified here. No production approval is given.

After the blockers clear, the intended approval scope remains only the exact saved Console key connection (`cred_ff5c3340d002t0edkOPNVJLA35`, integration `opencode`, key method, label `default`) transferred through the supported API into the dedicated Worker's `OPENCODE_API_KEY`; fixed-account isolated provisioning; genuine fixed no-model runtime probe; and the already bounded fixture test flow. Still needed: actual supported resolver activation/cleanup, real Wrangler resource IDs/deployment/secret acceptance, public-image startup and nonroot verification with expected test evidence, signed webhook delivery, approved registration/model behavior, verified App-authored draft PR, explicit test merge/checkpoint reconciliation, and unchanged-upstream model-free no-op. Report live failures as failures; no raw auth extraction, other keys, OAuth/global changes, Docker, or generic-provider fallback.

## Targeted final re-review — approved to execute

2026-10-10, after the three repairs. **This decision supersedes the initial blocked decision above. All three blockers are closed; no remaining must-fix issue was identified in this targeted re-review.** Main session may now run `node examples/live-github-flow/deploy-worker.mjs --execute` under the existing user authorization, then the separately authenticated fixed no-model runtime probe. This is pre-deploy test-scope approval, not a claim of successful provisioning or full production approval.

### Closure evidence

- **B1 closed:** `examples/live-github-flow/deploy-worker.mjs:770–862` now parses bounded header/row columns, accepts 32-hex Queue IDs (with UUID compatibility), rejects malformed/unrecognized/duplicate data, and scans through an empty page with a 20-page cap. Tests cover opaque-ID provisioning/resume, later-page conflict before key resolution, malformed rows, duplicate names/IDs, and the page cap. Unknown resources remain a halt condition.
- **B2 closed:** `apps/cloudflare/src/live-entry.ts:250–337,399–445` requires exactly one private observation of the pinned command/job/repository/commit, exit 1, untruncated bounded stdout and empty stderr, the three exact test names/statuses, 2-pass/1-fail counts, and the expected BOM `ERR_ASSERTION`/`strictEqual` mismatch. Result byte counts must match the observation; `command-failed`, unchanged workspace and successful runner cleanup remain required. Launcher 126/127, import/syntax failure, signal exit, missing/wrong test/assertion, timeout, truncation, missing observation, pass and mutation regressions reject readiness.
- **Observer privacy/default behavior confirmed:** `apps/cloudflare/src/sandbox.ts:76–92,640–685` adds only an opt-in trusted in-process callback; raw stdout/stderr remain absent from `VerificationResult`, HTTP evidence, logs and model context. The callback is wired only into the fixed live preflight. Production calls without it retain their result/gates; observer errors fail closed. Before/after inventory and sandbox destruction still run; cleanup failure cannot return readiness. Tests explicitly cover private observer output, unchanged public results and destruction on observer failure.
- **B3 closed:** `examples/live-github-flow/deploy-worker.mjs:1233–1245,1492–1500` admits the owned `deployment-succeeded` phase and retains config/admin digests, resource IDs, tag/message and active 100% version checks. Recovery tests verify no App file access, approved-key resolution, migrations, extra resources or redeploy; config/version/resource mismatches still stop. A failed Wrangler rollout remains `deploying`, not success.

Supplemental offline check captured the actual local fixed fixture's Node TAP output **privately**, passed it through the reviewed predicate, and confirmed exit 1 / three tests / two passes / one expected failure. The same predicate rejected launcher exit 126 with empty output. Only the closed summary was printed; no SDK host, saved key, private file or network call was involved.

### Re-review verification

All four required commands ran and exited 0:

```text
node --test examples/live-github-flow/opencode-credential.test.mjs examples/live-github-flow/deploy-worker.test.mjs
# tests 46
# pass 46
# fail 0

npm --prefix apps/cloudflare run typecheck
> tsc --project tsconfig.json --noEmit
[no diagnostics]

# Working directory: apps/cloudflare
npx vitest run --project node test/live-entry.test.ts test/sandbox.test.ts
 Test Files  2 passed (2)
      Tests  37 passed (37)

git diff --check
[no output]
```

### Approval limits and live proof

Approval is only for Worker `oc-port-agent-live-test-20261010`, account `324e23339afefd2f1f689e735c2b8789`, App `5266090`, installation `170044765`, and the one private fixture. Resolve only the exact previously approved Console default key through the supported SDK/plugin API; pass it into `OPENCODE_API_KEY` without exposing or storing the value. Keep protected stdin/state, distinct fresh D1/Queues, one public-image Sandbox, cron off, and smoke Worker untouched. No other keys, OAuth, global preferences, billing changes, Docker or generic-provider fallback are authorized.

Known limits are operational halts, not additional review gates: Queue metadata scans cap at 20 pages; controller deploy is bounded to 180 seconds; probe has a 120-second runner budget, 30-second fixed test and 16,384-byte output cap; strict Node TAP format differences fail closed. Preserve owned partial state on failure and report it honestly rather than silently expanding scope/time or bypassing guards. Real saved-key activation/cleanup, Cloudflare acceptance/rollout, public-image prerequisites and remote expected-test evidence remain to be obtained by the main session. The signed webhook, registration, bounded charged model run, App draft PR and explicit merge/checkpoint/no-op assertions remain separate live steps under the existing plan.

Nonblocking documentation follow-up: `examples/live-github-flow/LIVE.md:84` still illustrates `stderrBytes: 50`, while the repaired probe requires empty stderr (zero bytes). The implementation rejects nonempty stderr correctly; this example typo does not block execution.

This re-review changed only this document and an appended plan log. No implementation edits, private-file reads, actual credential resolution, live API/deployment/model calls, Docker or commits occurred.
