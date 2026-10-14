# Structured porting instructions for the CLI and Worker

## Goal
Give the operator a validated JSON Schema and policy examples that explicitly tell OpenCode what to port, how to adapt it, and what not to port, while preserving existing edit boundaries and verification gates.

## Conventions in force
- Preserve all existing working-tree changes and unrelated plans. Live GitHub validation remains a separate active task; do not resume/edit its private credentials, deployment controller, App installation, repositories, or cloud resources in this unit.
- Use the surrounding TypeScript ESM conventions, strict types, Node tests for the CLI, and Vitest/Workerd tests for the hosted app. No Docker, credentials, real model calls, remote writes, deployments, or commits.
- Backward-compatible version 1: existing policies without `instructions` keep normalized shape, hash, packet semantics and permissions. Optional editor `$schema` metadata never changes policy hashes and is not fetched/executed by the runtime.
- Add only an optional per-selection `instructions` object with `goal`, `adaptation`, and `nonGoals`. `goal` is required and nonempty; guidance arrays default to empty when the object is present. Unknown properties/types/empty entries/controls/oversized text or lists fail closed. Use identical validation semantics in both runtimes: at most 4096 Unicode code points per string, 32 items per guidance list, single-line trimmed-nonempty valid Unicode text with no C0/DEL controls.
- Guidance is trusted operator policy, never upstream instructions. It cannot grant shell/network/MCP/push, expand targetPaths, weaken protected paths, change checkpoints, or replace host verification. Conflicting guidance must be blocked/reviewed, not used as authority to bypass guards.
- Include instructions in policy hash and all selected agent context/prompt surfaces when provided. Changing instructions requires the normal explicit baseline/policy review; no silently reusing a checkpoint under changed intent.
- Avoid a new DSL/planner/provider abstraction. Reuse existing selection/source/target/mapping/preserve/acceptance/verification fields. Schemas are editing/structural validation; runtime still enforces repo/path/scope/cross-field and unique-ID semantics.

## Evidence
- Root `schema/oc-port-agent.schema.json` already describes the CLI tracking policy using JSON Schema 2020-12; it has no detailed instruction object.
- Root `src/config.ts` rejects unknown selection fields and hashes normalized selections. `src/agent.ts` delivers them in the pinned packet; agent text must explicitly distinguish trusted operator instructions from inert reference files.
- Hosted `apps/cloudflare/src/policy.ts` has its own portable strict policy type/normalizer; it currently rejects `$schema` and instructions. Hosted SDK `makePrompt` projects selection fields and must explicitly include instructions. Context tool currently returns full selections.
- User explicitly asks for a schema to instruct the OpenCode agent looking at another repository for porting. Live deployment is separately paused at a changed installation scope (two repos); user chose to narrow it to only the test repo. No key transfer or cloud resources created yet; preserve those facts and do not claim the live flow works from these schema tests.

## Phase 1
Implement backward-compatible structured instructions, editor schemas, examples, and actual agent-context wiring for both runtimes.

### Files owned
- `src/config.ts`, `src/agent.ts`
- `schema/oc-port-agent.schema.json`, new `schema/porting-instructions.schema.json`, new `schema/oc-port-policy.schema.json`
- `test/config.test.ts`, `test/agent.test.ts`, new `test/porting-instructions.test.ts`
- `apps/cloudflare/src/policy.ts`, `apps/cloudflare/src/opencode.ts`
- `apps/cloudflare/test/core.test.ts`, `apps/cloudflare/test/opencode.test.ts`, new `apps/cloudflare/test/porting-instructions.test.ts`
- New `examples/porting-policy.json` (CLI), new `examples/hosted-porting-policy.json` (hosted)
- `examples/live-github-flow/registration.template.json`, `examples/live-github-flow/prepare-repository.mjs`: add explicit BOM intent to local template/generator only; never run the preparation script or alter remote fixture/oracles/pins.
- New `docs/porting-instructions.md`, additive `README.md` link/example (preserve existing edits).
- `package.json`, `package-lock.json`: only add a pinned test-only JSON Schema validator if necessary for genuine 2020-12 schema-conformance tests; preserve all scripts/dependencies/prior changes. No other package files or source ownership.

### Requirements
1. Shared instruction schema declares exactly the three fields with descriptions, strict additionalProperties, goal required, bounded lists/text, no authority-changing fields.
2. Root/hosted schemas reference that schema consistently and resolve locally in editor/validator. Hosted policy schema matches its actual policy—not CLI `opencode` executable/settings fields. Existing CLI schema remains compatible.
3. Runtime validators preserve no-instruction policies; clone normalized instruction data and avoid nested mutation. Hosted `$schema` is optional validated annotation, excluded from normalized policy/hash/model packet.
4. CLI packet and system guidance and hosted prompt/context carry the full instructions. Scope/budgets/report/verification/provenance remain unchanged; instruction strings do not become executable code or commands.
5. Both examples describe a genuine distinct upstream repository and target adaptation, allowed paths, preserved target helper, non-goals, and observable tests. Explain initial adoption (`sync --full` for CLI) versus hosted incremental baseline semantics honestly.
6. Local live-fixture template directs exact BOM behavior/local API preservation without changing trusted tests, baseline SHA, upstream branch, or safety/spending limits.
7. Regression tests: valid/absent/malformed/unknown/control/Unicode/oversized instructions, unchanged legacy hash, changed-intent hash and checkpoint refusal, `$schema` metadata ignored, both schema examples accepted by real validator, and complete CLI/SDK context propagation. Prove guidance cannot widen edit scope or weaken verification. No dependency on real authentication.

#### Automated verification
- [x] `npm run typecheck`
- [x] `npm test`
- [x] `npm --prefix apps/cloudflare run typecheck`
- [x] `npm --prefix apps/cloudflare test`
- [x] `npm --prefix apps/cloudflare run test:runtime`
- [x] `npm --prefix apps/cloudflare run build:worker`
- [x] `git diff --check`

#### Manual verification
- [ ] Human reviews the example intent and policy before running it against real source repositories.

## Phase 2
Independently review the schema/validator/context contract and repair any concrete defects with bounded ownership.

### Ownership
- Sol high read-only review on implementation, report `docs/porting-instructions-review.md`.
- Luna max repairs only specifically named Phase 1 files/tests after planner scope grant; no live/credential/deployment activity.

#### Automated verification
- [x] Independent schema/runtime/context review and tests completed.
- [x] Concrete must-fix findings repaired and independently rechecked, or exact remaining blockers disclosed.

#### Manual verification
- [ ] Human approves the real porting policy; a schema and passing tests do not prove arbitrary project parity.

## Out of scope
Provider changes, credential transfer, live App/repo/cloud operations, Docker, generic prompt DSL, new autonomous tools, arbitrary source instruction loading, automatic merge/baseline changes, unrelated CLI glob/security refactors, or claiming the blocked live GitHub flow passed.

## Halt surfaces
Need edits outside ownership, schema/runtime inconsistencies that cannot be bounded, compatibility/permission/hash regression, or required secrets/network: preserve source and report; do not bypass gates or execute external content.

## Definition of done
Both validated policy variants accept optional structured instructions, actual OpenCode inputs receive them, schemas/examples/docs are usable, legacy policies remain compatible, offline/Workerd/build checks pass, independent Sol review finishes, and live flow remains accurately reported separately.

## Execution log
- 2026-10-10: Created this distinct schema task plan from the user's new instruction. Existing CLI/schema and hosted validators/context inspected. Preserve the previous implementation and live-validation plans; no schema implementation or remote changes yet.
- 2026-10-10 (Phase 1): Added optional structured selection intent, local draft 2020-12 schemas, examples/docs, and CLI/hosted agent-context wiring. All seven Phase 1 automated verification commands passed; `npm test` reported 41 passed/1 skipped, hosted Vitest 158 passed, Workerd 2 passed, Worker build dry-run passed. No live operations or fixture generator execution.
- 2026-10-10 (Phase 2, independent Sol review): Approved the locally tested schema/validator/context feature with no blocking defects or source repairs. All six dispatch verification commands passed (root 41 passed/1 skipped, hosted 158 passed, Workerd 2 passed). Additional in-memory probes found no mismatch across 131,151 shared-schema/CLI/host instruction cases, accepted both examples in their schemas and runtimes, compared legacy CLI normalization/hash against pre-change HEAD, and checked annotation/hash/permission isolation. Report: `docs/porting-instructions-review.md`. Implementation and test oracles stayed read-only; no live/provider/cloud operations, fixture generator execution, Docker build, or repository commit. Manual-policy approval and the separate paused live flow remain untouched.
