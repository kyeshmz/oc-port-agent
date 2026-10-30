# CLI and policy reference

Start with the [README quick start](../README.md#quick-start). Run all commands
below inside the **target** Git repository.

## Commands

| Command | Result |
| --- | --- |
| `init --upstream <repository> --ref main` | Scaffold a tracking policy; edit its placeholders before use. |
| `baseline --commit <upstream-SHA\|HEAD>` | Explicitly acknowledge a starting point and write the checkpoint. |
| `check` | Fetch and preview changes without a model call or checkpoint advance. |
| `check --full` | Preview adoption of all selected functionality, even on an unchanged upstream. |
| `sync` | Adapt new selected changes in a separate proposal worktree. |
| `sync --full` | Adopt all selected functionality in a separate proposal worktree. |
| `sync --pr --repo owner/target --base main` | Also push a verified proposal and create a draft PR. |

`check`, `baseline`, and `sync` accept `--config <repository-relative-policy.json>`.
`check` and `sync` accept `--collection <ports.json>` instead of `--config`.
`sync --model provider/model#variant` overrides the model for one run without
rewriting the policy. See [multiple upstreams](multiple-repositories.md).

## Configure a target

```sh
oc-port-agent init --upstream https://github.com/your-org/reference-project.git --ref main
```

Edit `oc-port-agent.json`, replacing every `EDIT ME:` placeholder and supplying
real verification commands. [features.json](../examples/features.json) covers
same-language or architecture-independent functionality;
[rust-to-typescript.json](../examples/rust-to-typescript.json) covers a
cross-language case.

`description` names the desired functionality; paths define context and the edit
boundary. A selection can watch an entire directory while requesting only one
feature. Include relevant dependencies and tests in `upstreamPaths`, and allow
target tests in `targetPaths`.

For detailed intent, add optional `instructions` with a required `goal` and
optional `adaptation` / `nonGoals` lists. These do not grant permissions or widen
the declared paths. See the [structured-instructions guide](porting-instructions.md),
[CLI policy](../examples/porting-policy.json), and
[hosted policy](../examples/hosted-porting-policy.json).

## Configuration reference

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `$schema` | Optional editor reference to `./node_modules/oc-port-agent/schema/oc-port-agent.schema.json` when installed as a package. Runtime validation is still enforced. |
| `upstream.repository` | HTTPS Git URL without embedded credentials, or an absolute local repository path. |
| `upstream.ref` | Branch name; the scaffold defaults to `main`. Not a tag or arbitrary revision expression. |
| `selections` | One or more rules: unique `id`, `description`, `upstreamPaths`, `targetPaths`, and nonempty `acceptance`. Optional `excludeUpstreamPaths`, `mappings`, and detailed `instructions`. |
| `preserve` | Intentional target differences and compatibility requirements. Use tests to enforce critical ones. |
| `protectedPaths` | Additional edit-denied paths. Defaults protect CI workflows and agent instruction files. Explicitly replace this array to opt into adapting those files. Tool internals, the active policy, checkpoints, agents, and OpenCode configuration remain protected regardless. |
| `allowSkillEdits` | Optional exact skill IDs. Opens only selected paths under `.opencode/skills/<id>/`; default `.opencode/**` protection is unchanged without this opt-in. Nested skills, agent instructions, config, and symlinks remain blocked. |
| `allowNulTextPaths` | Optional exact selected, non-excluded upstream paths (default `[]`) declared to be UTF-8 text with literal NUL. Strict UTF-8 validation still applies to original Git blob bytes. No globs, traversal, symlinks, or submodules. This only permits reading text and never expands edit permissions; changing it requires baseline review. Deleted files can still supply before-context. |
| `baselineCommit` | Optional reviewed immutable SHA used only when that policy has no saved checkpoint. Never accepts HEAD or replaces an existing checkpoint. |
| `reviewMetadataPaths` | Optional exact, already selected provenance/registry files. Skipped reviews may update these receipts only; applied decisions require changes outside them. Protected paths still win. |
| `verification` | Nonempty list of trusted `{ command, args, timeoutSeconds? }` checks, run without shell interpolation from the proposal worktree. Default timeout: 300 seconds per command. |
| `opencode.executable` | CLI executable; default `opencode`. |
| `opencode.model` | Optional `provider/model#variant`; otherwise uses OpenCode's configured default. |
| `opencode.timeoutSeconds` | Default 1200 seconds per attempt. |
| `opencode.maxAttempts` | Default 2; range 1–5. |
| `opencode.steps` | Default 100; maximum 500 steps per attempt. |
| `limits.maxCommits` | Maximum backlog, default 100. Stops instead of discarding older commits. |
| `limits.maxContextBytes` | Complete serialized plan limit, default 1,000,000 bytes. Narrow the selection or raise it explicitly. |

Globs are repository-relative and case-sensitive: `*` matches within one
component, `**` spans directories, `?` matches one character, and `**/` also
matches zero directories. No braces, character classes, escapes, absolute paths,
or `..` traversal. OpenCode permissions have a broader wildcard grammar; the
host's post-edit gate is the stricter authority.

Verification commands are trusted executable configuration. Each runs as an
argument array; configuring `sh -c` explicitly authorizes that shell command.
Dependencies ignored by Git are not copied into a new proposal worktree, so
provision them through trusted verification steps or an isolated runner.

## Baselines and first adoption

For a target that already corresponds to a known upstream commit:

```sh
oc-port-agent baseline --commit <known-upstream-SHA>
git add oc-port-agent.json .gitignore .oc-port/state.json
git commit -m "Configure selected upstream tracking"
oc-port-agent check
oc-port-agent sync
```

For functionality not yet implemented in the target:

```sh
oc-port-agent baseline --commit HEAD
git add oc-port-agent.json .gitignore .oc-port/state.json
git commit -m "Configure selected upstream adoption"
oc-port-agent check --full
oc-port-agent sync --full
```

A baseline acknowledges a starting point; it is not a parity test. `--full`
imports existing selected functionality after a HEAD baseline. Do not use HEAD
to conceal pending changes to an existing port.

An optional policy `baselineCommit` acknowledges an existing imported revision
on first use without mutating the caller. A check verifies ancestry against the
freshly fetched upstream. Existing checkpoints take precedence. Each nondefault
policy path uses `.oc-port/checkpoints/<path-hash>.json`; `oc-port-agent.json`
retains `.oc-port/state.json`.

Changing source, selections, acceptance, preservation rules, protected paths, or
verification changes the policy hash and requires explicit baseline review.
Choose an older commit to rescan, or use `sync --full` to reevaluate a selection.
Model, timeout, retry, and context-limit adjustments do not invalidate a
checkpoint.

## Review and checkpoints

`sync` requires a clean target. It leaves your original files, branch, and
checkpoint untouched while it works in a separate Git worktree. The CLI prints
the proposal branch and worktree paths. Inspect a successful proposal, then
merge its branch or use a PR:

```sh
git diff HEAD..<printed-proposal-branch>
git merge --ff-only <printed-proposal-branch>
```

Failed attempts remain available for inspection. The deterministic branch can
block a rerun until you intentionally clean up or rename the proposal branch and
worktree. The tool does not delete that work or merge a failed proposal.

Unrelated upstream changes produce a checkpoint/report-only proposal without a
model call, but still run verification. An unchanged upstream makes ordinary
`sync` a no-op. Renames are represented as deletion/addition; deleted files keep
their before-source context. Net diffs are used rather than replaying every
transient upstream commit.

## GitHub draft PRs

Authenticate `gh` and check out the freshly fetched target base, then run:

```sh
oc-port-agent sync --pr --repo your-org/target --base main
# Add --full for first adoption.
```

The target origin must match `--repo`, and the checkout must equal the current
remote base. The tool refuses when another `oc-port/` PR is open and rechecks
before publishing. It never force-pushes, updates unrelated PRs, or auto-merges.
Commit hooks are disabled for host-controlled worktree/commit/push operations;
put required checks in `verification` and target CI.

The PR records the upstream range, per-rule apply/skip reasons, executed commands
and exit codes, and a committed `.oc-port/reports/*.json` evidence file. A
publication failure preserves the committed proposal. If push succeeded but PR
creation failed, review/create the PR manually rather than discarding the branch.

## Execution boundaries

The upstream stays in a bare Git cache. Before/after source files and diffs are
inert JSON strings; upstream hooks, dependencies, and agent instructions are
not checked out into the active target.

Each run starts a private authenticated OpenCode V2 server and a temporary
restricted agent. The agent can read target code and edit selected paths, but
cannot run shell/network tools, use MCP/subagents, change checkpoints, commit,
or push. GitHub publication tokens are removed from its environment. The host
checks history and file scope, executes configured verification, and writes
reports, commits, and checkpoints.

These are workflow guards, not OS isolation. Ignored-file mutations are not
comprehensively audited; target/global OpenCode configuration, plugins, and
verification commands must be trusted. Use an isolated runner without unrelated
secrets. New dependencies, complex migrations, ambiguous behavior, binary or
non-UTF-8 files, symlinks, and submodules can require manual work. Large contexts
fail rather than being silently truncated. Passing tests and apply/skip reports
are evidence for review, not a guarantee of complete parity.
