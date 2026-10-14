# Self-hosting the Cloudflare GitHub App backend

See the package guide at
[`apps/cloudflare/README.md`](../apps/cloudflare/README.md) for resource
creation, credentials, App permissions, operator registration, local commands,
and runtime limitations. The operator-facing GitHub App permissions/events are
also summarized in [`apps/cloudflare/github-app-manifest.json`](../apps/cloudflare/github-app-manifest.json).

## Current status

This is an experimental, separate self-hosted backend; it does not replace the
root CLI. It is **not production-approved** and must not be deployed as an
unattended service yet.

The coordinated integration initializes the real OpenCode Workerd SDK schema
before creating app-owned SQLite tables. The runtime suite exercises actual SDK
session create/get and app job storage across a Durable Object eviction without
provider calls. R1–R3 and the PR lifecycle integration are implemented and have
offline regression coverage; Sol's independent Phase 5 review/re-review and
human live validation remain pending. This app is still not production-approved.

The controlled OpenAI-compatible provider-turn probe could not complete: stubbing
global `fetch` intercepted provider requests but also disrupted the SDK's
in-process Workerd fetch transport, which returned `Network connection lost`.
No real provider request or paid inference was made. Session persistence is
proven in Workerd; real SDK model/tool-turn behavior is not yet verified for the
OpenCode Console default or explicit legacy OpenAI route.

The Node hosted fixture test runs the actual portable core, trusted full-workspace
gates, and BOM acceptance tests with a test-only agent, publisher, GitHub
boundary, and local process runner. The Worker HTTP/scheduler/queue chain uses
SQLite-backed D1 and a test DO RPC adapter, not a remote Worker or real
Cloudflare Container. The runner executes ordinary Node locally; it does not
prove Linux isolation. No GitHub API, paid model, app deployment, or remote
publication is part of these checks.

## Trust and approval model

One trusted self-hosting administrator owns the GitHub App, its installations,
the `ADMIN_TOKEN`, each registration, and the executable verification policy.
The MVP has no user OAuth onboarding, tenant dashboard, billing, or user-level
policy review. Target code and upstream content are untrusted data; configured
verification commands are trusted executable policy. The Worker retains GitHub
and model credentials. They are not put in queue payloads, model tools, runner
environment/files, reports, or logs. The sandbox runs without outbound internet
by default; its test dependencies must be present in the approved image or
otherwise provisioned under an explicit operator policy.

The App requests Contents read/write, Pull requests read/write, and Metadata
read only. Manually subscribe only to `pull_request` and `push`. A `push` to a
tracked upstream branch queues a poll for each matching registration, so install
the App on upstream repositories you control; other upstreams use the daily
fallback poll. GitHub automatically
sends `installation` and `installation_repositories` to every GitHub App, and
does not allow manual subscriptions to those events; the backend still handles
them. See [GitHub's webhook event documentation](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation).
There are no Actions/workflow permissions, auto-merge, or force-push operations.
A pull-request event is only a reconciliation hint; the host confirms merged
state on the configured target base before checkpoint activation.

## Provider configuration

The dedicated live-test Worker defaults to the trusted `OPENCODE_PROVIDER=opencode`
selection and requires `OPENCODE_API_KEY`. The `gpt-6-luna` model ID is sent
unprefixed through the installed Open Responses provider package to the fixed
`https://opencode.ai/zen/v1/responses` endpoint. `ocpa-opencode` is only the
internal SDK provider alias. A missing Console key is a hard failure even if an
OpenAI key is present; there is no implicit provider or account fallback.

`OPENCODE_PROVIDER=openai` is a separate legacy opt-in. It reads only
`OPENAI_API_KEY`, uses an operator-selected OpenAI model with the Chat
Completions protocol at `https://api.openai.com/v1/chat/completions`, and is not
required for the default Console setup. Both routes have exact endpoint guards,
reject redirects, and disable title/compaction/physical retry requests. Offline
tests use synthetic keys only and make no provider request.

## Operator-only release checklist

1. Obtain independent Sol review/re-review and human approval of the completed
   source, trusted-policy model, runtime evidence, and Linux verification setup.
2. Pass `npm --prefix apps/cloudflare run types`, `typecheck`, offline tests,
   real Workerd initialization/persistence, the Worker-only dry-run bundle, root
   CLI typecheck/tests, and `git diff --check` on the reviewed final tree.
3. Create isolated D1/Queue/Container resources and a private GitHub App. Verify
   the exact installation scope, webhook signature secret, admin access, and
   model/provider spending limit.
4. Apply migrations and perform a real, supervised regex/BOM fixture cycle in
   the account: initial trusted check fails, scoped update is proposed, the
   configured Linux Container runs the target's actual tests, the draft is
   reviewed and explicitly merged, then a repeated poll is a no-op. Confirm no
   secrets enter model/sandbox contexts and inspect all Worker, D1, Queue, DO,
   and Container logs.
5. Keep the App and Worker private, monitor costs/recovery, and do not enable
   broader installation access until the human approves the complete review.

No deployment, remote registration, live GitHub API operation, real model call,
or remote publication is performed by the local scaffold/test scripts.

## Cumulative inference-generation limit

For a given registration, policy hash, and synchronized (`lastSyncedCommit`)
origin, the Worker permits at most two persisted inference/verification job
generations. The allowance does not reset when unrelated upstream commits move
the poll head or when the target base changes. A further attempt is stored as
`sync-origin-generation-limit`; the agent and verifier are not called, and the
synced checkpoint remains unchanged. A changed target base always requires fresh
verification; an earlier result is never reused.

This intentionally conservative cap can also stop genuinely new selected work
while the synchronized origin remains unchanged. A verified merge that advances
`lastSyncedCommit` establishes a new origin and its own bounded allowance. There
is no authenticated budget-reset endpoint. If no safe cumulative proposal can
be merged, stop and obtain an explicitly reviewed operator recovery/rebaseline
procedure; do not delete durable job/effect evidence or manually rewrite either
checkpoint to bypass the cap.
