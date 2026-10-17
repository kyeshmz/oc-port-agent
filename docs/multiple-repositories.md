# Gather ports from multiple repositories

A collection gathers selected functionality from several source repositories into one target Git repository. It reuses the existing per-upstream policies rather than changing their format or sharing a checkpoint. You can still check or synchronize any policy separately.

## Configure the target

Run in the repository where the adapted functionality belongs:

```sh
oc-port-agent init --config policies/retry.json --upstream https://github.com/your-org/retry-source.git --ref main
oc-port-agent init --config policies/strip-bom.json --upstream https://github.com/sindresorhus/strip-bom.git --ref main
```

Edit each policy's selections, acceptance criteria, preservation rules, and trusted verification commands. The upstream may be an HTTPS Git URL or an absolute local Git repository path. Describe the adaptation into your target API; the tool does not blindly copy files or install upstream dependencies.

Set a reviewed baseline for each source:

```sh
oc-port-agent baseline --config policies/retry.json --commit <reviewed-retry-source-SHA>
oc-port-agent baseline --config policies/strip-bom.json --commit <reviewed-strip-bom-SHA>
```

Alternatively, put an immutable reviewed `baselineCommit` in each policy when it has no checkpoint. An existing checkpoint always takes precedence. A baseline acknowledges a starting point; it is not proof that the target implements the source. Use `--full` to adopt functionality already present there.

Create `ports.json`:

```json
{
  "$schema": "./node_modules/oc-port-agent/schema/oc-port-agent.collection.schema.json",
  "version": 1,
  "policies": ["policies/retry.json", "policies/strip-bom.json"]
}
```

Policy paths are relative to the **target repository root**, even when the collection is in a subdirectory. The list accepts 1–100 unique, exact paths; traversal, globs, and symlink aliases are rejected. The schema reference is optional and is not fetched at runtime. Commit the policies, collection, `.gitignore`, and any baseline checkpoints before synchronizing.

## Check, adopt, and track

```sh
oc-port-agent check --collection ports.json --full
oc-port-agent sync --collection ports.json --full
```

`check` fetches every source and prints its repository, branch, immutable range, relevant selections, and pending/up-to-date status. It does not call a model or advance checkpoints. `sync` preflights all policies before creating one isolated proposal worktree. Each port then runs in listed order with its own permissions, context limit, retry bound, decisions, and host verification. Later ports can read earlier adaptations but cannot edit outside their own declared paths.

After all pending ports succeed, **every policy's verification runs again against the combined target**, including policies whose upstream did not change. The host restores each policy's pinned context packet before its checks, so reference-compilation/parity checks use that source's SHA rather than the last port's SHA. These final checks must leave tracked/nonignored files unchanged. A regression, blocked decision, invalid policy, scope violation, or failed check stops the collection. Failed worktrees are retained for inspection; do not merge their partial commits.

Overlapping target paths are permitted for intentional composition. The final checks catch tested incompatibilities; they do not establish arbitrary behavioral equivalence. Each policy's own checks must pass when its port finishes, so place prerequisite ports first and keep checks scoped to the behavior they verify. For a feature that needs several sources to change atomically before any individual check can pass, split the adoption into reviewed stages instead.

The returned JSON identifies one proposal branch/worktree, an aggregate evidence report, and a result/report for each source. Review the complete diff before explicitly merging the proposal or publishing a draft PR:

```sh
oc-port-agent sync --collection ports.json --pr --repo your-org/target --base main
```

No checkpoint in your original checkout changes until you merge the proposal. Each policy retains its usual independent checkpoint; collections can include the legacy `oc-port-agent.json` policy without migrating its state. Do not cherry-pick partial commits from a collection: the final report verifies the complete proposal. Nothing auto-merges.

After the initial adoption is reviewed and merged:

```sh
oc-port-agent check --collection ports.json
oc-port-agent sync --collection ports.json
```

Only changed sources need proposals/model work. When every source is unchanged, sync returns `up-to-date` without a model call or new worktree. Unrelated upstream changes can still create checkpoint/report-only commits without a model. `--config` and `--collection` are mutually exclusive.

The GitHub Action exposes the same behavior with `collection: ports.json` instead of `config`. Existing explicit publication credentials, fresh-base checks, and draft-only rules remain in force. This feature is in the local CLI and reusable Action, not the separate experimental Cloudflare backend.

## Test with the existing public fixtures

```sh
npm test
npm run test:collection -- --help
# Explicit opt-in: fetch public sources and make bounded real model calls.
npm run test:collection -- --live
```

The collection harness reuses the existing pinned [escape-string-regexp and strip-bom cases](public-repository-tests.md#pinned-reference-inputs), but gathers both into **one** disposable target and proposal: regex escaping becomes a Python API; BOM stripping becomes the target's JavaScript API. It first proves the fixed acceptance tests fail, then checks source provenance, scoped implementation changes, unchanged tests/helpers/policies, independent checkpoints, combined host verification, and caller preservation. It explicitly fast-forwards only the disposable target, reruns both acceptance suites, and requires a model-free follow-up sync.

The default model and per-source limits match the existing public harness: `openai/gpt-6-luna#max`, at most two attempts per source, 30 steps per attempt, 300 seconds per attempt, 250 KB context, and 120 seconds per verification command. Provider charges may apply. Override with `--model provider/model#variant` if needed. Bare source snapshots, target, proposal, and `evidence/collection.json` are retained under `$OC_PORT_PUBLIC_TMPDIR` or `$TMPDIR/opencode`. No source code is checked out/executed from upstream, no credentials enter evidence, and nothing is pushed to GitHub. The normal test suite exercises the same harness with local source repositories and a fake adapter.

### Observed combined live run

On October 17, 2026, both pinned cases passed together using the real OpenCode v2.0.32 runner with `openai/gpt-6-luna#max`. A fresh rerun after the per-source verification-context fix also passed in 98 seconds. Both initial acceptance suites failed as intended; the single proposal and explicitly merged disposable target passed both suites. Fixed tests, helpers, policies, and the collection stayed unchanged. The caller was preserved before merge, source checkpoints remained independent, and a second collection sync returned `up-to-date` without invoking a model. No GitHub writes were made.

Retained evidence on the test machine:

```text
/var/folders/q6/tz5lqjtn66q2cw4jg9qtfcj00000gn/T/opencode/oc-port-collection-v96QyY/evidence/collection.json
```

This is a local artifact, not a published result or evidence of arbitrary-project parity. Re-running creates a fresh disposable target and evidence.

### Observed original Rust/TypeScript demo collection run

The original `oc-port-agent-demo/rust-upstream` and `typescript-target` repositories also passed their existing checks: 2 Rust tests, 4 TypeScript tests, differential parity at 8 retry inputs, installed-tool/schema checks, and an unchanged-upstream sync. Both original checkouts remained clean.

An extended test used independent disposable clones of those repositories. It changed only the Rust clone's retry base from 250 to 300ms and cap from 2000 to 2400ms, confirmed stale TypeScript failed parity, and added the pinned BOM source as a second policy targeting a new TypeScript API. The real OpenCode runner gathered both ports into one proposal. Compiled Rust tests, TypeScript tests/parity, and fixed BOM tests all passed in combined verification. The proposal preserved input validation and `retryLabel`, left the caller unchanged until the explicit disposable-target merge, retained independent checkpoints, and passed a model-free follow-up sync. The original repos' HEADs and clean statuses were unchanged; nothing was pushed.

Retained extended-run evidence and per-command logs:

```text
/private/var/folders/q6/tz5lqjtn66q2cw4jg9qtfcj00000gn/T/opencode/oc-port-existing-repos-FOJjba/evidence.json
```

This run exercised source-dependent verification using the demo's existing pinned-reference scripts. A regression test now also covers restoring a policy's own context packet when that policy is unchanged and a different source is ported.
