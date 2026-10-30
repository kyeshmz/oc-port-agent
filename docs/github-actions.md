# Run oc-port-agent with GitHub Actions

The reusable composite [action.yml](../action.yml) runs the CLI in a target
repository. Start with the [target workflow](../examples/github-workflow.yml),
replace its example action repository/ref with a reviewed commit SHA, and commit
the target's policy and checkpoint before enabling it.

For centralized credentials and independent public-upstream discovery, use the
separate [hosted GitHub App](../apps/cloudflare/README.md). This Action uses
repository workflow credentials and the CLI pipeline.

## Provider and publication credentials

The example runs on GitHub-hosted Ubuntu, sets up Node 22, and installs an exact
OpenCode V2 release using `@opencode/cli`. Set `install-opencode: 'false'` when
you provide a preinstalled V2 CLI. See the [V2 CLI documentation](https://opencode.ai/v2/docs/cli/commands/).

The [official OpenCode Action](https://github.com/anomalyco/opencode/blob/dev/github/action.yml)
accepts a model and provider environment variables. This wrapper supports that
convention and an explicit secret input:

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

| Input | Behavior |
| --- | --- |
| `api-key` | Provider key from GitHub Secrets. Required for sync/adopt unless the corresponding provider environment variable is set; not needed for check. Never use a workflow-dispatch text input for secrets. |
| `api-key-env` | Provider credential variable, default `OPENCODE_API_KEY`. Alternatives include `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, or a custom provider's `*_API_KEY`. The selected provider must recognize it. |
| `model` | Optional `provider/model#variant` override; does not rewrite policy or checkpoint. |
| `opencode-version` | Exact `@opencode/cli` V2 version; default `2.0.26`. |
| `install-opencode` | Default `'true'`; set `'false'` for an already-installed V2 CLI. |
| `mode` | `check`, `sync` (default), or `adopt` (`sync --full`). |
| `publish` | Default `'false'`; explicitly enables draft PR publication. |
| `repository`, `base` | Required target and base when publishing. |
| `config`, `collection` | Repository-relative single policy or ordered collection; mutually exclusive. |

OpenCode is the default provider; no Anthropic key is required. Choose a model
available to your account. The [external-provider example](../examples/github-workflow-external.yml)
uses `OPENAI_API_KEY`; other providers work with their recognized credential
variable and matching model. You can omit `api-key` and set the variable under
`env` instead.

The key enters the private server's environment, never command arguments,
repository config, checkpoints, or committed reports. Actions masking is applied.
A fresh runner-local OpenCode database prevents saved OAuth credentials from
overriding the supplied key. The provider key is separate from the generated
server authentication password and GitHub publication token; no interactive
`/connect` step is needed.

Configure dependencies and `OC_PORT_GITHUB_TOKEN` with target contents and PR
write permissions. A narrowly scoped App installation token or fine-grained token
can let the new PR trigger target CI, unlike GitHub's default workflow token's
event restrictions. Keep publication credentials out of the agent environment.
Do not run this workflow on untrusted forks or with `pull_request_target`.

## Triggers

The example target workflow supports:

- Manual dispatch to preview, sync, or perform first adoption.
- An `upstream-push` repository dispatch for prompt updates when you control the
  upstream. The [optional notify workflow](../examples/upstream-notify-workflow.yml)
  sends it on pushes to `main`; its dispatch token needs Contents write on the
  target.
- A daily scheduled fallback, which also covers third-party upstreams without
  any upstream setup.

Dispatch is a wake-up hint. The sync reads the repository and branch from the
committed policy, never `github.event.client_payload`. The CLI does not schedule
itself or merge proposals automatically.

The official Action invokes `opencode github run`; this wrapper uses its own
sync/checkpoint/verification pipeline with OpenCode as the restricted coding
runner. It does not inherit the official Action's App/OIDC flow.
