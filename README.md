# oc-port-agent

Selectively adopt and keep upstream functionality aligned with a target repository, using **OpenCode V2**.

This is not a fork-merging bot or a language translator alone. Track a retry policy, API behavior, bug fix, tests, documentation, or configuration across repositories with different languages **or the same language and different architectures**. Describe what you want, which upstream paths are evidence, which target paths may change, and what must remain different.

Status: an initial implementation with offline integration tests and a passing local Rust → TypeScript synchronization demo using the real OpenCode V2 CLI. Private GitHub repositories have been created for the [tool](https://github.com/kyeshmz/oc-port-agent), [Rust reference](https://github.com/kyeshmz/oc-port-demo-rust), and [TypeScript target](https://github.com/kyeshmz/oc-port-demo-typescript). The model-powered GitHub run still needs CI secrets; no scheduled workflow is enabled. One controlled demo is not a guarantee of correctness for arbitrary projects.

## How it works

1. Fetch the configured upstream branch into a bare cache and compare its freshly fetched commit with a recorded checkpoint.
2. Select relevant net changes using your tracking policy. `sync --full` can import functionality already present upstream.
3. Create a separate target worktree and give OpenCode a pinned JSON packet with the diff, before/after source files, mappings, requirements, and preservation rules. Upstream hooks and agent instructions are never checked out into the active target.
4. Start a private authenticated OpenCode server (without restarting or reconfiguring your shared service), wait for the temporary `oc-port-agent` profile to register, and submit work through `opencode run --server`. The agent may read target code and edit selected target paths, but cannot run shell commands, access network tools, use MCP/subagents, edit the checkpoint, commit, or push.
5. Enforce file-scope/history gates and run the operator's trusted verification commands. Retry verification failures within a configured bound; stop on protected edits or ambiguous/blocked decisions.
6. Commit a reviewable proposal with evidence and a new checkpoint. Optionally push it and create a **draft PR**. The target's effective checkpoint changes only when that proposal merges.

No automatic merging, force pushes, silent truncation, implicit baselines, or wholesale copying of upstream code.

## Requirements and installation

- Node.js 22+, Git, Linux or macOS.
- An installed and authenticated **OpenCode V2** CLI. This implementation was checked against local CLI flags in v2.0.26; V1 is not supported.
- GitHub CLI (`gh`) and target-repo credentials only when using `--pr`.
- Install the target project's dependencies yourself. Verification executes in a new worktree, so dependencies ignored by Git are **not copied from your main checkout**. For example, configure `npm ci` before `npm test`, or provision dependencies on an isolated runner.

```sh
cd /path/to/oc-port-agent
npm ci
npm run build
node /path/to/oc-port-agent/dist/src/cli.js --help
```

The package is local/private and has not been published to npm. You can also run `npm link` to expose its `oc-port-agent` executable locally.

## Configure a target

Run these commands inside the **target** Git repository:

```sh
oc-port-agent init --upstream https://github.com/your-org/reference-project.git --ref main
```

Edit `oc-port-agent.json`. Replace its `EDIT ME:` placeholders and configure real verification commands. [examples/features.json](examples/features.json) covers same-language or architecture-independent functionality; [examples/rust-to-typescript.json](examples/rust-to-typescript.json) shows a cross-language case.

An individual tracking rule looks like this:

```json
{
  "id": "retry-policy",
  "description": "Keep upstream cancellation and retry behavior aligned, not its HTTP-library implementation.",
  "upstreamPaths": ["src/client/**", "tests/client/**"],
  "excludeUpstreamPaths": ["tests/client/benchmarks/**"],
  "targetPaths": ["src/network/**", "test/network/**"],
  "acceptance": [
    "Permanent errors never retry.",
    "Retries stop immediately when the caller cancels.",
    "New upstream cases have equivalent target regression tests."
  ],
  "mappings": [{ "upstream": "src/client/**", "target": ["src/network/**"] }]
}
```

`description` names the desired functionality; paths define the context and edit boundary. A rule can watch an entire directory but request only one feature. Include relevant dependencies/tests in `upstreamPaths`, and allow target test files in `targetPaths`.

### Configuration reference

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `$schema` | Optional editor reference to `./node_modules/oc-port-agent/schema/oc-port-agent.schema.json` when installed as a package. Runtime validation is still enforced by the tool. |
| `upstream.repository` | HTTPS Git URL, without embedded credentials, or an absolute local repo path. |
| `upstream.ref` | Branch name (default `main` in the scaffold). Not a tag or arbitrary revision expression. |
| `selections` | One or more rules: unique `id`, `description`, `upstreamPaths`, `targetPaths`, and nonempty `acceptance`. Optional `excludeUpstreamPaths` and `mappings`. |
| `preserve` | Intentional target differences and compatibility requirements. These are instructions; use tests to enforce critical ones. |
| `protectedPaths` | Additional edit-denied paths. Defaults protect CI workflows and agent instruction files. Explicitly replace this array to opt into adapting those files. Tool internals/config/OpenCode configuration remain protected regardless. |
| `verification` | Nonempty list of trusted `{ command, args, timeoutSeconds? }` checks. Each runs without shell interpolation, from the proposal worktree. Default per-command timeout: 300 seconds. |
| `opencode.executable` | CLI executable, default `opencode`. |
| `opencode.model` | Optional `provider/model#variant`. Otherwise uses OpenCode's configured default. No model/provider is hardcoded. |
| `opencode.timeoutSeconds` | Default 1200 seconds per attempt. |
| `opencode.maxAttempts` | Default 2; range 1–5. |
| `opencode.steps` | Default 100; maximum 500 model steps per attempt. |
| `limits.maxCommits` | Maximum backlog, default 100. Stops instead of discarding older commits. |
| `limits.maxContextBytes` | Complete serialized plan limit, default 1,000,000 bytes. Narrow the selection or raise it explicitly. |

Globs are repository-relative and case-sensitive: `*` matches within one component, `**` spans directories, `?` matches one character, and `**/` also matches zero directories. No braces, character classes, escapes, absolute paths, or `..` traversal. OpenCode permissions have a broader wildcard grammar; the host's post-edit gate is the stricter authority.

Verification commands are trusted executable configuration, not model suggestions. If you intentionally configure `sh -c`, you are authorizing that shell command. Add typechecks, behavioral regression tests, shared fixtures, differential tests, and docs validation as appropriate. **A passing build or model-written report is not proof of parity.**

## Initial adoption and ongoing sync

For an existing target that already corresponds to an upstream commit:

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

`baseline` is an explicit acknowledgment of a starting point, **not a parity test**. Use `--full` after a HEAD baseline to import existing selected functionality. Review the policy before invoking a model; it sends selected source/context to your configured provider.

`check` fetches and previews without calling OpenCode or advancing the checkpoint. `sync` requires a clean target and leaves your original files/branch/checkpoint untouched. Successful proposals and failed attempts remain in separate worktrees; the CLI prints their paths. Inspect a successful proposal, then merge its branch or use a PR:

```sh
git diff HEAD..<printed-proposal-branch>
git merge --ff-only <printed-proposal-branch>
```

Do not merge a failed proposal. Failed attempts deliberately remain available for inspection; the same deterministic branch will block a rerun until you intentionally clean up or rename your own proposal branch/worktree. The tool does not delete user work.

When only unrelated upstream paths change, the host creates a checkpoint/report-only proposal without calling a model, but still runs verification. When upstream has not changed, ordinary `sync` does nothing. Renames are represented as deletion/addition; deleted files retain before-source context.

Changing the source, selections, acceptance, preservation rules, protected paths, or verification changes the tracking policy hash. The tool stops until you explicitly review and reset the baseline. Choose an older commit to rescan, or use `sync --full` to reevaluate the new selection; never reset straight to HEAD merely to hide pending work. Model, timeout, retry, and context-limit adjustments do not invalidate a checkpoint.

## GitHub draft PRs

First authenticate `gh` and check out the freshly fetched target base. Then:

```sh
oc-port-agent sync --pr --repo your-org/target --base main
# Add --full for initial adoption.
```

The target origin must match `--repo`, and the checkout must equal the current remote base. The tool refuses when another `oc-port/` PR is open and rechecks before publishing. No force push, update of unrelated PRs, auto-merge, or publication without `--pr`. Commit hooks are disabled for host-controlled worktree/commit/push operations; run all required checks explicitly in `verification` and target CI instead.

The PR includes the exact upstream range, per-rule apply/skip reasons, executed commands and exit codes, and a committed `.oc-port/reports/*.json` evidence file. Agent decisions remain claims for human review. A GitHub publication failure preserves the committed proposal; if a push succeeded but PR creation failed, review/create the PR manually instead of force-pushing or discarding the branch.

### GitHub Action

This repository includes a reusable composite [action.yml](action.yml) and an opt-in [target workflow example](examples/github-workflow.yml). Publish the tool first, then replace the placeholder action repository/ref with a reviewed commit SHA. Nothing installs a workflow into another repo automatically.

The example now runs on **GitHub-hosted Ubuntu**, sets up Node 22, and installs an exact OpenCode V2 release using `@opencode/cli`, the package named by the [current V2 CI docs](https://opencode.ai/v2/docs/cli/commands/). No floating `latest` release or curl installer is used. Set `install-opencode: 'false'` if you deliberately provide a preinstalled V2 CLI.

The [official OpenCode GitHub Action](https://github.com/anomalyco/opencode/blob/dev/github/action.yml) accepts a model and obtains provider credentials through environment variables. This wrapper supports that convention and also exposes an explicit secret input:

```yaml
- uses: YOUR_OWNER/oc-port-agent@REVIEWED_COMMIT_SHA
  with:
    api-key: ${{ secrets.OPENCODE_API_KEY }}
    api-key-env: OPENCODE_API_KEY
    model: opencode/gpt-6.1-sol
    opencode-version: '2.0.26'
    mode: sync
    publish: 'true'
    repository: ${{ github.repository }}
    base: main
  env:
    GH_TOKEN: ${{ secrets.OC_PORT_GITHUB_TOKEN }}
```

| Action input | Behavior |
| --- | --- |
| `api-key` | Provider API key from GitHub Secrets. Required for sync/adopt unless the corresponding provider environment variable is already set; not needed for check. Never a workflow-dispatch text input. |
| `api-key-env` | Provider credential variable, default `OPENCODE_API_KEY`. Alternatives: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or a custom provider's `*_API_KEY`. The selected model/provider must recognize it. |
| `model` | Optional `provider/model#variant` override for this run. Does not rewrite the tracking policy or checkpoint. |
| `opencode-version` | Exact `@opencode/cli` V2 version, default `2.0.26`. |
| `install-opencode` | Default `'true'`; set `'false'` to use an already-installed V2 CLI. |
| `mode` | `check`, `sync` (default), or `adopt` (`sync --full`). |
| `publish` | Default `'false'`; enables draft PR publication only when explicitly `'true'`. |
| `repository`, `base` | Required explicit target and base when publishing. |

OpenCode is the default; no Anthropic key is required. The OpenCode example uses the currently available `opencode/gpt-6.1-sol` model. [The external-provider example](examples/github-workflow-external.yml) uses `OPENAI_API_KEY`; Anthropic and other providers work by selecting their recognized key variable and matching model. You can alternatively omit `api-key` and set the matching provider variable under `env`, just like the official action.

The API key is mapped into the **private server process environment**, never command arguments, repository config, checkpoints, or committed reports. Actions masking is applied. A fresh, runner-local OpenCode database prevents saved OAuth credentials on self-hosted runners from taking precedence over the supplied CI key. This provider key is separate from the private server's generated authentication password and from the GitHub publication token. There is no interactive `/connect` step.

Configure project dependencies and `OC_PORT_GITHUB_TOKEN` (target contents + PR write permissions). Prefer a narrowly scoped GitHub App installation token or fine-grained token. A non-default token can also allow the created PR to trigger normal target CI; GitHub's default workflow token has event-trigger restrictions. Scheduled runs poll from the target, so you need no control over the upstream repo. Do not use `pull_request_target`, run on untrusted forks, or grant the agent publication credentials.

The official action invokes `opencode github run`; this wrapper uses its own deterministic sync/checkpoint/verification pipeline instead, with OpenCode V2 as the restricted coding runner. It does not inherit the official action's GitHub App/OIDC flow.

## Safety and limits

- Upstream stays in a bare Git cache. Full source files/diffs are inert JSON strings; upstream `.opencode`, `AGENTS.md`, hooks, and dependencies are not installed or executed.
- The temporary agent has deny-by-default permissions. Shell, network tools, MCP, subagents, external directories, checkpoint edits, and sensitive target reads are denied. GitHub publication tokens are removed from its environment.
- Host gates verify Git history and tracked/nonignored changed paths before and after checks. The host alone stages, commits, writes checkpoints, and creates PRs.
- These are **workflow guards, not an OS sandbox**. Ignored-file mutations are not comprehensively audited. Existing target/global OpenCode configuration, plugins, and configured verification commands must be trusted. Use an isolated runner with no unrelated secrets. The model needs its provider credential; Git/host verification may need repository credentials.
- Shell-free agent execution means new dependencies, complex migrations, unclear behavior, binaries, non-UTF-8 files, symlinks, and submodules may require a human or explicit trusted verification setup. Binary translation is not supported.
- The complete before/after content of watched text files is sent as context. Large scopes fail loudly; this version does not automatically partition huge codebases or maintain per-symbol semantic graphs.
- Net diffs are used rather than replaying every transient upstream commit. Apply/skip decisions are per tracking rule, with upstream commit provenance preserved in the evidence.
- Skipped decisions with reasons still require review. Declarative preservation rules cannot guarantee compatibility without good tests.

## Development

```sh
npm ci
npm run typecheck
npm test
# Optional: parse the generated agent using the installed V2 CLI; no model calls.
OC_PORT_TEST_OPENCODE=1 npm test
```

Tests use disposable local Git repos and a fake model adapter. They exercise upstream fetching, initial adoption, checkpoint activation on merge, deletion context, scope protection, verification failure/retries, complete reports, and the real CLI adapter's arguments/cleanup. No paid model calls or live GitHub writes are required.

See [docs/research.md](docs/research.md) for the existing projects investigated and why this is a separate implementation.

## Live demonstration

The adjacent [`../oc-port-agent-demo`](../oc-port-agent-demo/README.md) contains two independent Git repos with the packaged tool installed in both apps. The TypeScript tracking policy points at the Rust repo and the packaged JSON Schema.

The live test changed only Rust's retry policy (100 → 250ms base, 1000 → 2000ms cap), observed the old TypeScript parity check fail, invoked real OpenCode to update TypeScript source/tests, verified against compiled Rust, explicitly merged the proposal into the target, and confirmed a second sync is a no-op. The target-only helper and input validation survived. Full evidence is in `../oc-port-agent-demo/evidence/e2e-result.json`.

That demo also caught a real CLI integration issue: child processes inherited the caller's `PWD` and could select the wrong repository. The runner now sets `PWD` to the canonical proposal worktree, with a regression test. Private-server startup also waits for asynchronous agent registration and handles its authentication instead of touching the user's shared daemon.
