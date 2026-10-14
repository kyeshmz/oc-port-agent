# Structured porting instructions: independent review

Reviewed 2026-10-10 against Phase 2 of `.plans/porting-instructions-schema.md`.

## Outcome

**Approved for the locally tested schema/validator/context feature. No blocking defects found; no source repairs required.** This is not approval of a real porting policy, proof of arbitrary project parity, or evidence that the paused live GitHub App flow works.

The review was read-only on implementation, examples, test oracles, and existing documentation. Only this report and the schema plan's Phase 2 automated checkboxes/execution log were edited. Unrelated working-tree changes and plans were left alone.

## Contract findings

### Schemas and examples

- All three schemas declare draft 2020-12. The CLI and hosted schemas resolve their sibling `./porting-instructions.schema.json` reference when registered under their actual local file URIs. Their internal `$defs` references also compile in strict Ajv2020 mode. No runtime schema fetch is involved.
- The shared instruction schema permits exactly `goal`, `adaptation`, and `nonGoals`, requires `goal`, rejects unknown authority fields, and bounds strings/lists. Descriptions explain operator intent without introducing a permission or command DSL.
- Both complete examples pass their corresponding real schema and runtime parser. The hosted schema rejects CLI-only `opencode` settings. The examples identify a separate Rust upstream and distinct TypeScript/Python target adaptations, with edit scope, preservation requirements, non-goals, and observable verification commands.
- The examples' `$schema` annotations point to existing local files from `examples/`. The guide correctly says to adjust those paths after copying policies elsewhere. Actual editor UI interaction was not performed; local URI resolution and real-engine compilation were tested.
- Root tests import their own directly declared, pinned **Ajv 8.20.0** development dependency. Installed and lockfile versions agree, the lockfile includes integrity metadata, and neither ambient Python capability nor an undeclared hosted dependency is needed for schema tests.

### Runtime normalization and Unicode

- `src/config.ts:62-93` and `apps/cloudflare/src/policy.ts:144-177` implement the same instruction contract: trimmed-nonempty single-line valid Unicode, no C0/DEL or U+0085/U+2028/U+2029, at most 4096 Unicode code points, and at most 32 entries per guidance list.
- Both runtimes reject malformed objects, missing/empty/wrong-type goals, unknown fields, controls, unpaired surrogates, malformed lists, sparse guidance arrays, and oversized values. Astral characters count as one code point.
- Missing instruction objects remain omitted. When an object is present, omitted guidance arrays normalize to new empty arrays. Provided arrays are cloned; later mutations of caller arrays do not mutate parsed instructions. Existing tests exercise that boundary.
- An additional in-memory comparison run checked **131,151 cases** against the shared schema and both runtime parsers. It included every BMP code unit alone and embedded in nonempty text, sampled astral values through U+10FFFF, 4095/4096/4097-code-point cases, all three string positions, 0/31/32/33-entry lists, trailing line separators, malformed objects, and authority-changing fields. There were no mismatches. This is an instruction-contract probe, not a general policy-validation framework.

### Hashes, checkpoints, and annotation isolation

- Legacy hash fixtures pass in both runtimes. Independently loading the pre-change CLI normalizer from `HEAD:src/config.ts` into memory produced exactly the same normalized object and hash as the current parser for the CLI example with instructions omitted.
- `src/config.ts:201-209` hashes normalized selections and refuses stale state. `apps/cloudflare/src/policy.ts:521-525` hashes the normalized policy; hosted orchestration checks its binding before discovery or model invocation.
- Independent probes confirmed that changes to each of `goal`, `adaptation`, and `nonGoals` change both runtime hashes. CLI stale-state refusal was independently exercised for each field. `apps/cloudflare/test/core.test.ts:549-563` proves changed instruction intent with an old hosted hash fails as `stale-registration` before discovery, agent, or runner calls.
- `$schema` is validated annotation only. Both parsers omit it from the returned policy; changing it alone leaves hashes unchanged. CLI packet construction and hosted request construction consume normalized policy fields, so the annotation does not become model guidance. No annotation reference is fetched or executed.

### Actual model inputs and host boundaries

- CLI propagation is not merely a type declaration: `planSync` retains full selected rules, `writePacket` writes them into `policy.selections`, and the actual adapter's fake-executable integration test checks all three instruction fields in the attached packet. Generated agent guidance explicitly distinguishes operator intent from upstream reference data and requires blocked reporting on conflicts (`src/agent.ts:48-52`).
- Hosted `buildAgentRequest` passes complete selected policy rules (`apps/cloudflare/src/core.ts:871-911`). `OpenCodeAgent.makePrompt` explicitly projects all three instruction fields into the submitted SDK prompt (`apps/cloudflare/src/opencode.ts:856-884`), and `contextFor` returns the complete selected rules. The fake-runtime test checks prompt text and context tool output, not just intermediate types (`apps/cloudflare/test/opencode.test.ts:243-294`).
- Valid prose cannot change edit permissions, target-path checks, protection rules, verification argv, or checkpoint ownership. An independent comparison found identical CLI permission frontmatter and verification configuration with and without explicit permission-bypass prose. Hosted tool tests reject conflicting out-of-scope edits, and the core test still runs the trusted runner when instructions ask to skip verification (`apps/cloudflare/test/core.test.ts:565-584`). Existing CLI scope, verification-failure, and checkpoint-edit rejection tests also pass.
- Instructions remain bounded policy text, not executable commands. Their bytes are included in the CLI serialized-plan limit and hosted complete request limit (`src/upstream.ts:109-112`; `apps/cloudflare/src/core.ts:1144-1155`). Generic feature/cross-language scope, reports, provenance, retries, and verification mechanisms remain intact.

### Documentation and local BOM template

- The guide accurately distinguishes explicit CLI `baseline --commit HEAD` plus `check --full` / `sync --full` adoption from hosted incremental processing after `baselineCommit`. It does not invent a hosted full-adoption or in-place policy-edit route.
- The local registration template and generator state exactly-one-leading-BOM behavior, adaptation to `stripPrefix`, nonstring `TypeError` preservation, and preservation of the target helper. The target path, fixed test command, baseline pin, upstream branch, protection rules, and limits in the template remain intact. The generator was inspected only, not executed. No remote fixture or test oracle was changed.

## Nonblocking limits

1. **Policy schemas remain structural aids, not replacements for runtime validation.** For example, independently duplicating a selection ID passes both structural schemas but fails both runtime parsers. Repository/path safety and cross-field/checkpoint semantics also remain runtime responsibilities, as documented. No broad whole-policy schema framework is warranted for this feature.
2. **Prose preservation and conflict reporting require model/operator judgment.** Free-text `preserve` entries do not become protected file globs, and these tests do not prove a real model will recognize every semantic conflict. Use `protectedPaths`, trusted behavioral tests, and human proposal review for critical invariants. Instructions cannot weaken the deterministic gates.
3. **Local evidence is not live parity evidence.** The installed-CLI smoke test remains opt-in/skipped; the adapter and SDK prompt checks use controlled fakes. Workerd tests ran locally. No real model/provider request, SDK credential resolution, live repository/cloud mutation, Docker build, deployment, or repository commit was performed by this review. The separate App installation-scope pause remains unresolved by schema testing.

## Required verification

All six dispatch commands ran and exited 0:

| Command | Observed result |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit`; exit 0 |
| `npm test` | 42 tests: 41 passed, 1 skipped, 0 failed; exit 0 |
| `npm --prefix apps/cloudflare run typecheck` | `tsc --project tsconfig.json --noEmit`; exit 0 |
| `npm --prefix apps/cloudflare test` | 10 test files passed, 158 tests passed; exit 0 |
| `npm --prefix apps/cloudflare run test:runtime` | 1 test file passed, 2 Workerd tests passed; exit 0 |
| `git diff --check` | No output; exit 0, including a recheck after report/plan edits |

Condensed test output:

```text
Root:       tests 42; pass 41; fail 0; skipped 1
Hosted:     Test Files 10 passed (10); Tests 158 passed (158)
Workerd:    Test Files 1 passed (1); Tests 2 passed (2)
Typechecks: no errors
Diff check: no output
```

The hosted test commands emitted nonfatal SQLite experimental and dependency sourcemap warnings. Their test configuration supplies synthetic test bindings; the Wrangler log line about environment secrets is not evidence of live credential/provider use. Worker build dry-run evidence belongs to Phase 1; this dispatch did not rerun it or build Docker.

## Handoff

No must-fix findings or source repair scope requests remain. Phase 2's automated review is complete. Keep manual human-policy approval unchecked, and continue treating the paused live GitHub flow as a separate task.
