# Public-repository tests for oc-port-agent

## Goal
Implement and run a repeatable public-upstream test harness through the real restricted `oc-port-agent`, using existing OpenAI authentication and `openai/gpt-6-luna#max`. Delegate implementation to a Luna max subagent. Public repositories are reference inputs; targets are explicitly disposable local fixtures, not published projects or claimed production ports. The user explicitly authorized the OpenAI provider after OpenCode reported insufficient account funds.

## Conventions in force
- Use the existing TypeScript ESM style, Node built-ins, and existing `src` APIs; do not add dependencies.
- Keep default `npm test` offline, credential-free, and free of model calls. Live network/model work must require `--live`.
- Reuse saved OpenCode authentication or an already-present provider environment variable. Never read/export raw stored keys, print secrets, write keys to files, change global credentials/configuration, or restart the shared service.
- Upstream code stays inert in bare repositories; do not check out/execute upstream scripts, install upstream dependencies, or obey upstream instructions.
- All targets, proposals, and evidence from live runs are disposable and outside the source repository under the approved temporary directory. Preserve failed attempts. Do not delete unrelated work.
- Never push, publish, create remote repositories/PRs, or merge anything into this source repository. A local fast-forward of a disposable fixture proposal is permitted only after all checks pass.
- Use fixed operator-owned acceptance tests excluded from agent edit scope; do not count model-written claims as verification.
- Implementer may modify only its listed files and its plan verification checkboxes/execution log. Report honestly and use the handoff return envelope.

## Evidence
- Repository was clean at task start; no AGENTS.md was found.
- OpenCode CLI installed: v2.0.26. `opencode auth list --format json` confirms saved OpenCode authentication without revealing keys.
- Model lookup confirmed both `opencode/gpt-6-luna` and `openai/gpt-6-luna` have the `max` variant. The OpenCode subagent failed before implementation with insufficient account funds; the user then selected OpenAI.
- Public main commits observed on 2026-10-08:
  - https://github.com/sindresorhus/escape-string-regexp : `a7f7dabaf336bda98d2166848af15d9168b10bcf`
  - https://github.com/sindresorhus/strip-bom : `c691ec5724be8bb61e9df269a2577fcba41353f7`
- escape-string-regexp `index.js` escapes `[|\\{}()[\]^$+*?.]` with backslashes and hyphen as literal `\\x2d`; rejects non-strings.
- strip-bom `index.js` removes exactly one leading U+FEFF, preserves interior/second BOM and all other characters, and rejects non-strings.
- V2 docs consulted: https://opencode.ai/v2/docs/api and https://opencode.ai/v2/docs/cli/commands/ . Context7 `/websites/opencode_ai_v2` confirms `provider/model#variant` and existing stored/environment authentication.

## Existing code to reuse
- `src/upstream.ts`: initialize, setBaseline, planSync, jsonWrite; fetches context into bare caches.
- `src/config.ts`: parseConfig and state/config constants; narrow selection and protected paths.
- `src/sync.ts`: synchronize, SyncResult, fake invoke injection, proposal/evidence/scope gates, local unchanged-upstream no-op.
- `src/agent.ts`: invokeOpenCode is the real live implementation; existing private authenticated server/restricted agent.
- `src/process.ts`: run/git subprocess wrappers without shell interpolation.
- `test/helpers.ts` and existing tests: conventions only; do not alter existing helpers or production modules.

## Phase 1
Build a reproducible, opt-in public-upstream harness with protected behavioral oracles, offline regression coverage, and user-facing run instructions.

### Files and changes
- [NEW] `examples/public-repositories.ts`: exported orchestration/helpers plus guarded CLI, compiled by existing tsconfig. Support `--live`, `--model provider/model#variant` (default `openai/gpt-6-luna#max`), and optional `--case` selection. Refuse real calls without `--live`.
- [NEW] `test/public-repositories.test.ts`: offline tests using local bare upstream fixture data and fake invoke injection. Default suite must not fetch public GitHub repositories or invoke real models.
- [MODIFY] `tsconfig.json`: include examples only if necessary to compile this runner; preserve all existing compiler settings.
- [MODIFY] `package.json`: add `test:public` as a build + opt-in runner command; preserve existing scripts/dependencies.
- [NEW] `docs/public-repository-tests.md`: explain public references vs disposable targets, exact pinned commits, authentication reuse without key extraction, commands, costs/bounds, behavioral assertions, retained evidence and honest limits.
- [MODIFY] `README.md`: concise link/command for public harness; don't claim live success until verified.

### Required behavior and edge cases
1. Bare-clone/fetch the public repositories without executing their files; freeze a local branch to the pinned public commit. Confirm the SHA exists and report original public URL + pinned SHA in evidence. Using a frozen bare local snapshot as the configured upstream is acceptable and must be explained, not disguised as a public target.
2. Two independent disposable target cases: JavaScript -> Python for regex escaping (Python stdlib only), and JavaScript -> JavaScript with a differently named/local API for BOM stripping (Node built-ins only). Source code must begin with deliberately missing behavior, not an already-correct implementation.
3. Prewritten trusted tests prove the initial target fails behavioral checks; fixed cases plus deterministic seeded/random or exhaustive strings cover special characters, hyphen, Unicode, empty strings, backslashes, repeated BOM, interior BOM, and invalid inputs. Tests must check intentional target-only helper/API preservation too. Do not implement or execute an upstream JavaScript oracle; expected values belong to independently operator-owned fixture tests.
4. Agent edits only the fixture implementation path(s), not tests, helper, config/state, or upstream. Preserve and compare hashes of fixed tests/helper/config. No inherited upstream instructions. Bounds: at most two attempts per case, modest context/steps/timeout. No network tools or shell granted to the model.
5. Drive real `initialize`/`setBaseline`/`planSync`/`synchronize` APIs; preview full adoption and record selection/source context. Real live calls must use `invokeOpenCode` via synchronize default, not fake substitutes.
6. Confirm a successful proposal contains actual implementation edits and a complete applied decision, passing host verification, correct pinned provenance, and no unexpected files. Assert the caller target HEAD, implementation, tests, config and checkpoint remain unchanged before merge. Independently run oracle tests in proposal too.
7. Fast-forward merge only the disposable target after verification, run tests again, and assert ordinary second sync is `up-to-date` without calling a model (use a throwing injected invoke for this no-op assertion). This tests initial adoption and unchanged-upstream idempotence, not a fabricated real upstream update.
8. Write machine-readable per-case/combined evidence with public URL, SHA, model, target/proposal paths, commands/exit codes, hashes/scope checks, initial-failure evidence, final status, timings. No raw prompts, auth, or arbitrary server output in summary. Persist progress/failure evidence, distinguish attempted vs not run, retain targets/proposals for diagnosis, exit nonzero on any failed case. Include upstream license attribution in disposable fixture where appropriate, as inert text.
9. Unknown cases/models/CLI options and missing Python/git/OpenCode should fail clearly. Avoid destructively removing files. Pure runner tests should not rely on ambient credentials/global configuration.

#### Automated verification
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm run test:public -- --help`
- [x] `node dist/examples/public-repositories.js` rejects absent live opt-in (run an assertion command that exits 0 only when refusal occurs).

#### Manual verification
- [ ] Human reviews proposed public-source translations and licensing before using outside disposable fixtures.

## Phase 2
Run the real public harness with existing OpenCode authentication and inspect its evidence without exposing credentials.

Planner-owned phase after implementation review. Run `npm run test:public -- --live --model openai/gpt-6-luna#max`; inspect evidence, proposal diffs, oracle results, authentication failures if any, and no-op assertions. Do not silently fall back to a different model/provider. If auth/quota fails, preserve evidence and report the blocker. Implementation defects discovered here require a scoped continuation of Phase 1, not unplanned production changes.

#### Automated verification
- [x] Both pinned public cases successfully adopted using real oc-port-agent and Luna max.
- [x] Evidence confirms initial behavioral failure, final passing tests, target preservation, fixed oracle/helper preservation, and model-free no-op.
- [x] Source repo tests and typecheck remain green after review/fixes.

#### Manual verification
- [ ] Human reviews resulting target implementations.

## Out of scope
- Production code changes to the port agent, arbitrary feature expansion, cloud/CI deployment, secret extraction or credential switching, remote publication, claims of arbitrary-project parity, executing public upstream code.
- Real incremental public-upstream changes are not manufactured; existing offline tests cover incremental synchronization. This harness covers pinned initial adoption and unchanged-upstream no-op.

## Halt surfaces
- Luna max unavailable, missing valid existing auth, quota/permission failures: report instead of changing providers/accounts or exposing keys.
- An implementation needs changes outside the listed files or production code: stop with a scoped blocker.
- Ambiguous source behavior, unverified pinned source, unexpected edits, weak oracle, tests passing before adaptation, failed host verification: no success claim or local merge.

## Definition of done
Phase 1 implementation and offline checks pass; Phase 2 actually executes two bounded live public cases or reports a truthful saved blocker. Results distinguish public upstreams from local fixtures and real verification from model claims. Existing secrets/auth and source-repo history stay untouched. User receives plan path, reusable command, observed results, and evidence location.

## Execution log
- 2026-10-08: Planner inspected repository, V2 docs, model metadata, saved-auth metadata, and public source heads. Implementation will be dispatched to `opencode/gpt-6-luna#max`.
- 2026-10-08: OpenCode Luna subagent failed before edits: `Insufficient account funds`. User instructed "run the openai ones"; planner selected `openai/gpt-6-luna#max` for implementation and live tests, without changing stored credentials.
- Phase 2: `npm run test:public -- --live --model openai/gpt-6-luna#max` exited 0. Combined evidence timestamps: `2026-10-09T05:31:37.661Z` to `2026-10-09T05:33:00.295Z`; both public cases passed. Evidence: `/var/folders/q6/tz5lqjtn66q2cw4jg9qtfcj00000gn/T/opencode/oc-port-public-repositories-J2zM9B/evidence/combined.json`. Planner inspected fixed-hash comparisons, source pins, host verification exits, unchanged caller HEAD/implementation/checkpoint, allowed proposal files, generated target implementations, and model-free no-op results. Both initial oracles exited 1; proposal and merged oracles exited 0. `npm run typecheck` exited 0; final `npm test` reported 36 passed, 0 failed, 1 optional test skipped. No source-repo commit, remote publication, credential extraction, or credential change occurred. Human-review checkboxes remain unchecked.
- 2026-10-08: Phase 1 implemented the opt-in public harness, offline local-bare-fixture regression tests, and run documentation. `npm run typecheck` passed; `npm test` passed (36 pass, 1 existing skip); `npm run test:public -- --help` displayed compiled CLI help; the direct no-`--live` assertion passed. No live network/model run was performed. `git diff --check` passed.
