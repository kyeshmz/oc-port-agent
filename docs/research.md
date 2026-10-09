# Existing work and implementation decision

Investigated on October 8, 2026. These are source/documentation findings, not benchmark claims.

## Closest tool: upsync

[wangyedev/upsync](https://github.com/wangyedev/upsync) is an MIT-licensed Rust CLI for initial cross-language ports and upstream synchronization. It tracks a commit, sends a diff to a CLI coding agent, runs a verification command, and updates state.

Source findings:

- [`src/agents.rs`](https://github.com/wangyedev/upsync/blob/main/src/agents.rs) implements Claude Code, Gemini CLI, and Codex CLI, not OpenCode. All three use the same Claude-style arguments.
- [`src/git.rs`](https://github.com/wangyedev/upsync/blob/main/src/git.rs) fetches origin but reads local `HEAD`; [`src/main.rs`](https://github.com/wangyedev/upsync/blob/main/src/main.rs) compares that value to the checkpoint. A fetch alone does not advance local HEAD, so new upstream changes can be missed.
- [`action/action.yml`](https://github.com/wangyedev/upsync/blob/main/action/action.yml) invokes `upstream-sync`, while [`Cargo.toml`](https://github.com/wangyedev/upsync/blob/main/Cargo.toml) names the binary package `upsync`.
- [`src/config.rs`](https://github.com/wangyedev/upsync/blob/main/src/config.rs) defaults TypeScript verification to `npm run build`; that does not establish equivalent behavior.
- [`src/prompts.rs`](https://github.com/wangyedev/upsync/blob/main/src/prompts.rs) focuses on translating a whole project or applying all upstream differences. It does not define operator-selected functionality, target edit boundaries, intentional differences, or merge-activated proposal state.

The track → diff → adapt → verify idea is reusable. The implementation and scope are not sufficient to adopt unchanged. `oc-port-agent` is independently implemented in TypeScript; no upstream source files were copied.

## Other precedents

- [Fabro Semantic Port](https://docs.fabro.sh/examples/semantic-port): commit-processing loop with port/skip decisions, a persistent ledger, and bounded repair. Useful workflow design; the example is not a turnkey OpenCode runner.
- [GitHub Agentic Workflows feature synchronization](https://github.github.com/gh-aw/gallery/multi-repo/feature-sync/): reusable cross-repo adaptation and draft-PR automation.
- [Copilot SDK Java weekly upstream sync](https://github.com/copilot-community-sdk/copilot-sdk-java/blob/main/.github/workflows/weekly-upstream-sync.yml) and [porting prompt](https://github.com/copilot-community-sdk/copilot-sdk-java/blob/main/.github/prompts/agentic-merge-upstream.prompt.md): real .NET-to-Java upstream detection and coding-agent delegation, including architecture preservation and test mapping.
- [vibe-fork](https://github.com/dollspace-gay/vibe-fork): Claude Code porting discipline, source/target routing, critic-written regression tests, and preservation of semantics. Its README does not establish a reusable automatic upstream monitor.
- [Rust Porting Playbook sync template](https://github.com/jlevy/rust-porting-playbook/blob/main/playbooks/auto-sync-agent-prompt-template.md): differential validation, changed-test coverage, and explicit handling of accepted differences.

## What this implementation adds

OpenCode V2 execution; arbitrary functionality rather than language-only porting; operator-defined scopes/acceptance/mappings/preservation; full initial adoption; fresh-ref upstream tracking; deny-by-default agent tools; deterministic Git/edit/verification gates; state committed only into review proposals; explicit draft publication; and offline integration tests.

OpenCode contracts were checked against the [V2 CLI](https://opencode.ai/v2/docs/cli), [agent definitions](https://opencode.ai/v2/docs/agents), [permissions](https://opencode.ai/v2/docs/permissions), and local `opencode run --help` in v2.0.26. This implementation does not claim V1 compatibility or verified model-level equivalence.

## Live integration result

A controlled Rust → TypeScript demo subsequently passed using the real OpenCode CLI/model path, not a fake adapter. The full evidence is stored in the adjacent `oc-port-agent-demo/evidence/e2e-result.json`. This verifies one specific behavioral change and does not establish general cross-project equivalence.

The live check identified two integration requirements that unit mocks did not reveal: agent registration is asynchronous, and the CLI may resolve its active directory from `PWD`. The implementation now starts only its own authenticated localhost server, waits for registration, passes `--server` to the run command, canonicalizes the worktree, and updates child `PWD`. It does not use shared-service start/stop commands.

## Current GitHub Action credentials

Checked the [official action source](https://github.com/anomalyco/opencode/blob/dev/github/action.yml), [V2 CI commands](https://opencode.ai/v2/docs/cli/commands/), and [V2 environment credentials](https://opencode.ai/v2/docs/cli/providers/). The official action takes `model` as an input, runs `opencode github run`, and obtains provider credentials from environment variables; it does not declare a generic API-key input. The V2 CI docs install `@opencode/cli` and pass `ANTHROPIC_API_KEY` from GitHub Secrets. The npm registry confirmed `@opencode/cli` release `2.0.26` is available.

Our wrapper now accepts `api-key`, `api-key-env`, and `model`, maps the secret into the appropriate provider environment for its private server, and installs the pinned V2 CLI on a GitHub-hosted runner. It retains the option to use the official environment-variable convention. GitHub workflow execution has not been claimed as tested live.
