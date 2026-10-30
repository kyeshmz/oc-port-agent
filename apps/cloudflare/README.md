# Cloudflare GitHub App backend

This is a separate, self-hosted backend package. It does not replace the root
CLI and does not provide a multi-user OAuth dashboard. An authenticated
operator approves each target repository, policy, and verification command.

One hosted service supplies the model and GitHub App credentials for **all of its
registered repositories**. Install the App on your GitHub account, select the
repositories it may access, and register their tracking policies. Adding another
repository does not require another provider key or repository secret.

## Release status

**Not production-approved. Do not deploy this package for unattended use yet.**
The coordinated R1–R3 cumulative-checkpoint, before/after source, and complete
verification-workspace contracts are implemented. R21 now reads the stored PR
number and distinguishes open, closed-unmerged, merged, and unknown states;
closed unmerged proposals are retained as terminal cancellations. The real
Workerd smoke initializes the SDK schema before app tables and checks SDK
session plus app job persistence across eviction. These are implementation and
local-test results, not independent Phase 5 approval.

The offline hosted-path test exercises authenticated registration, SQLite-backed
D1 scheduling/outbox, Queue dispatch, the real portable core, a deterministic
fake agent, a test-only local Node verifier executing the fixed BOM tests,
mock publication, merge checkpoint activation, and a model-free follow-up. Its
queue RPC is a test adapter around the core; it is not a deployment or full
Cloudflare DO-to-Container run. The Node verifier is not Linux sandbox proof.
The independent whole-app review/re-review, a production Linux Container run,
and human live validation remain release gates. A Worker-only dry run and a
mocked control-plane test do not prove live GitHub, provider, or Container
behavior.

## What is wired

- `src/index.ts` exposes the Phase 2 Worker, Phase 3 `TargetJobDO`, and the
  installed Sandbox preview `Sandbox` class.
- `wrangler.jsonc` targets the dedicated live-test Worker and declares its D1,
  Queue producer/consumer, target-job and Sandbox Durable Objects, D1 migration
  directory, pinned public Container image, and Workers logs/traces. Cron is
  intentionally disabled until registration/run checks are approved.
- D1 holds installation, tracking, webhook replay, scheduling, and queue-outbox
  records. Each target Durable Object has its own SQLite storage for job state
  and the OpenCode SDK. The Workerd smoke confirms SDK-first schema
  initialization and session/job persistence across test eviction; provider-backed
  model execution remains untested.
- The installed `@cloudflare/sandbox@0.13.0-next.776.1` preview remains the
  runtime baseline. The dedicated live-test config points to its matching
  public Python image directly; the repository `Dockerfile` remains available
  for optional custom-image work.

## Prerequisites and operator decisions

- Node.js `^22.12.0`, `^24.0.0`, or `>=26.0.0` and npm. The tested local Node
  release is 22.23.3. Vitest 5 requires these supported Node ranges.
- Docker Desktop only for optional local custom-image work or Container
  emulation. The dedicated Worker config uses the pinned public Sandbox image,
  so its no-local-Docker deployment path does not build a local image. Cloudflare
  Containers requires an eligible paid plan for deployment.
- The operator-owned GitHub App installed only on the approved test repository,
  and an OpenCode Console API key for the dedicated live-test Worker. No real
  credentials are required for the offline Node tests or Workerd runtime smoke;
  tests inject synthetic values and never call a provider.
- Review the Worker CPU/subrequest limits, Container instance capacity and
  size, allowed verification commands, maximum job/attempt/output limits,
  Cloudflare billing, and provider spending limits before any real deployment.
  The `max_instances: 5` and `instance_type: "standard-1"` values in the
  Wrangler config are starting operator choices, not a cost estimate or
  reviewed production capacity plan.

## Create the Cloudflare resources

The Wrangler config targets the dedicated `oc-port-agent-live-test-20261010`
Worker in the confirmed account, not the separate SDK smoke Worker. Its D1 UUID
is deliberately all zeroes until the dedicated test database is provisioned.
Create the named main and dead-letter queues in that account as part of the
operator-reviewed setup. These commands are instructions only; no Cloudflare
resources have been created by the provider implementation or its tests.

```sh
cd apps/cloudflare
npm ci
npm exec wrangler -- d1 create oc-port-agent-live-test-20261010
npm exec wrangler -- queues create oc-port-agent-live-test-jobs
npm exec wrangler -- queues create oc-port-agent-live-test-jobs-dlq
```

Put the returned D1 database ID in `wrangler.jsonc`. Keep resource IDs and
credentials out of source examples and CI. For a local-only D1 migration:

```sh
npm exec wrangler -- d1 migrations apply DB --local
```

Applying a migration with `--remote` changes the operator's remote database;
review the destination and backup/approval requirements before doing that. The
SQLite Durable Object migration is declared in Wrangler and is applied as part
of an operator-controlled Worker deployment. The local `build` script is a
dry-run and does not deploy or register remote resources.

## Create the GitHub App

Use [`github-app-manifest.json`](./github-app-manifest.json) as the least-
privilege manifest/reference. Replace `YOUR_WORKER_HOST` with the actual
operator-owned hostname when creating the App. Do not create or register the
App from this repository's test/build commands.

Required permissions:

| Repository permission | Access | Why |
| --- | --- | --- |
| Contents | Read and write | Read pinned repository files and publish a verified proposal branch |
| Pull requests | Read and write | Check tracked open PRs, create a draft PR, and confirm merge state |
| Metadata | Read | GitHub-required repository identity/read access |

Manually subscribe to **Pull request** and **Push**. GitHub automatically sends
**Installation** and **Installation repositories** events to every GitHub App;
they cannot be manually subscribed. The Worker must still handle those automatic
events. See [GitHub's webhook event documentation](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation).
A closed, merged pull-request event only schedules reconciliation; the event
itself is not checkpoint proof. There is no Actions/workflow write permission,
merge permission, or automatic merge. The Worker independently reads GitHub
state before advancing a checkpoint.

Set the App webhook URL to `https://<worker-host>/webhooks/github`. Save the
App ID as the non-secret `GITHUB_APP_ID` variable and provision the private key
and webhook secret only through a secret manager. Install the App on the target
repository. A private upstream also needs read access through that installation;
a public upstream does not require installation membership.

### Event-driven updates

GitHub **Push** webhooks are the primary sync trigger. Install the App on the
upstream repositories you control as well as the target repositories. The same
Push subscription covers branch and tag pushes; no additional provider key or
per-repository Actions workflow is needed.

| Event | Work scheduled |
| --- | --- |
| Push to a tracked branch | Check active registrations matching that upstream repository and branch |
| Tag created or updated by a push | Check every active registration for that upstream repository, using each registration's configured branch |
| Branch or tag deletion | No adaptation work |
| A tracked proposal PR merges | Reconcile its checkpoint against GitHub's current state |

The Worker verifies the exact webhook body, records replay protection and a
durable outbox entry, then sends identity-only work to the target queue. This
immediately flushes up to 100 pending outbox records without a scheduler tick;
larger backlogs and failed sends need the configured cron below. The internal
queue kind `poll` means a single upstream check; it does not mean that the
webhook starts a polling loop. An upstream event may come from a different App
installation than the target's.

Each check reads the repository and branch from the stored policy and obtains
the authoritative commit/diff from GitHub. A tag is a wake-up signal: it does
not replace the tracked branch or make the payload's SHA a trusted checkpoint.
Tag-pinned or latest-release-only adoption is a separate policy capability.
Unchanged heads and changes outside the selected upstream paths do not invoke
the model. Selected paths determine whether model work is needed; acceptance
criteria guide adaptation and verification. This does not classify semantic
breaking changes automatically.

Upstreams without the App, such as third-party repositories, need an owner to
install the App or forward notifications; installation on your downstream repo
alone cannot receive their pushes. A daily fallback check also covers missed
events, including GitHub's documented limits on bulk tag pushes and oversized
webhook payloads. See the [Push event contract](https://docs.github.com/en/webhooks/webhook-events-and-payloads#push).
That fallback needs a Worker cron trigger, for example
`"triggers": { "crons": ["17 * * * *"] }`. The hourly tick only enqueues
registrations whose daily poll is due, and a push postpones the next fallback
poll by a day. It also retries pending queue-outbox deliveries after temporary
queue failures. Cron stays disabled in the checked-in config until
registration/run checks are approved.

## Configure shared credentials once

Credentials belong to the hosted Worker environment. The provider module is the
single source of provider/model/key selection for target jobs and the setup-status
endpoint. Registrations contain repository identities, a branch, a baseline and a
policy; they do not accept or store provider credentials. All target Durable
Objects use the same service bindings, so adding repositories or updating their
policies does not copy keys.

For one GitHub account:

1. Configure the GitHub App ID, private key and webhook secret on one Worker.
2. Configure the selected model provider and its API key on that Worker once.
3. Install the App on the account and select the repositories it may cover.
4. Register each target with that installation ID and its reviewed tracking
   policy. Add further repositories to the installation as needed.

The service obtains GitHub installation tokens with the App credential; target
repositories need neither individual provider secrets nor individual publishing
tokens. Rotating a service secret updates subsequent jobs through the Worker
environment, with no registration changes.

`wrangler.jsonc` lists the required secrets but contains no secret values. The
trusted `OPENCODE_PROVIDER` variable defaults to `opencode`, and
`OPENCODE_API_KEY` is the required OpenCode Console credential. For local
development, create the ignored `apps/cloudflare/.dev.vars` file with local-only
values for `ADMIN_TOKEN`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and
`OPENCODE_API_KEY`. Do not use live credentials for a health check. Workerd
tests replace these names with synthetic values inside their isolated process.

For an operator-controlled remote Worker, configure the required values through
the dashboard or the operator's approved secret-management path. Wrangler's
`secret put` command deploys a new Worker version immediately; do not treat it
as a local-only setter. Never put secrets in `vars`, queue messages, model tool
context, sandbox files/environment, logs, CI variables, or test fixtures.

`OPENCODE_PROVIDER` accepts only `opencode` or `openai`; its checked-in default is
`opencode`. That selection is trusted configuration, never model/user input.
The OpenCode route reads only `OPENCODE_API_KEY` and fails closed if it is
missing, even if `OPENAI_API_KEY` happens to be configured. The Responses package
is pinned to `https://opencode.ai/zen/v1/responses`; `gpt-6-luna` remains the
unprefixed model ID, with `ocpa-opencode` used only as the SDK's internal
provider alias. The plugin registers text input/output and actual bounded tool
support, forbids model-controlled endpoint changes, rejects redirects, and
disables auxiliary title/compaction and physical retries.

The separate legacy route is available only with the explicit
`OPENCODE_PROVIDER=openai` setting. It uses only `OPENAI_API_KEY`, the fixed
`https://api.openai.com/v1/chat/completions` Chat Completions protocol, and an
OpenAI model ID selected by the operator. It is not a Console-key fallback; no
generic OpenAI credential is required for the default Console configuration.
Provider credentials, model compatibility, quotas, and spending limits still
require operator approval. Configuration and offline tests do not prove that a
real provider call has succeeded.

After configuring the service, inspect its secret-free setup status:

```sh
curl --fail-with-body \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${WORKER_URL}/admin/configuration"
```

This authenticated endpoint reports the shared provider configuration and GitHub
credential presence, without exposing secret values or making provider calls.
It checks local configuration, not remote API-key validity or webhook delivery.
`provider.credentialScope` is `service`; `provider.configured` indicates that the
selected provider, model and key pass the job runner's configuration validation.
An incomplete provider reports a stable `errorCode` and, when applicable,
`requiredKey`. `github` reports the App ID and presence flags for the shared
private key and webhook secret. Adding a repository does not change this status.

After the release gates and human approval are complete, the operator's remote
sequence is:

```sh
npm exec wrangler -- d1 migrations apply DB --remote
npm exec wrangler -- deploy
```

These commands change remote resources: migration apply writes the account's
D1 database, and deploy uploads the Worker and builds/pushes the Container
image. They are intentionally absent from package scripts and CI.

## Local commands

From the repository root, after dependencies are installed:

```sh
npm --prefix apps/cloudflare ci
npm --prefix apps/cloudflare run types
npm --prefix apps/cloudflare run typecheck
npm --prefix apps/cloudflare test
npm --prefix apps/cloudflare run test:runtime
npm --prefix apps/cloudflare run build:worker
```

`types` runs the pinned Wrangler version against `wrangler.jsonc` and generates
`worker-configuration.d.ts`; rerun it after changing bindings/config.
`build:worker` uses the installed Wrangler `--containers-rollout=none` option
with `--dry-run`, so it builds the actual Worker source/config without building,
pushing, or rolling out the configured image. It does not upload or deploy. The
separate `build` script is an optional full dry run that may inspect or pull the
configured Container image; it is not part of the no-Docker verification set.

`test` runs offline Node suites, the local fixture integration, and the actual
Workerd project. The integration uses a real in-memory SQLite-backed D1 adapter
for registration, scheduling, and outbox, but a fake target-DO RPC/core adapter;
it executes the pinned Node verification command over a bounded fixture
workspace. `test:runtime` separately checks a real Workerd `TargetJobDO`, SDK
session create/get, and app job storage across eviction. It uses synthetic
bindings and makes no provider, GitHub, or Container request. Neither suite
proves Linux isolation or a deployed Container.

Local verification on 2026-10-30 (Node 22.23.3, pinned dependencies):

- Generated Wrangler types and app typecheck passed.
- The full hosted suite passed **203 tests across 12 files**, including signed
  branch/tag webhook dispatch without cron and model-free unchanged/unselected
  follow-ups.
- The explicit Workerd smoke passed **2 tests**, including real SDK session and
  app job recovery after Durable Object eviction.
- The Worker-only dry run passed at **22,827.49 KiB / 3,970.65 KiB gzip**.

The Workerd test preloads the real SDK before constructing the Durable Object.
Vite resolves dynamic imports over RPC; doing that while the startup input gate
is held stalled the test at the existing 20-second initialization bound. The
same failure reproduced on baseline `02acab4`. Preloading fixes the test harness
without changing production initialization, timeouts, or persistence assertions.

The route-chain integration fakes model output and publisher/API boundaries; it
does not make a paid model call. Assertions cover the initial BOM test failure,
scoped adaptation, unchanged fixed tests/helpers, successful
verification/publication/merge, and unchanged-head no-op, plus blocked edits,
failed tests, and stale-base refusal.

A separate controlled OpenAI-compatible provider-turn probe was not retained as
passing evidence: stubbing global `fetch` to return fake SSE responses
interfered with the SDK's in-process Workerd fetch path and ended with
`Network connection lost`. The endpoint was intercepted by the test stub; no
real provider request or paid model call was made. The SDK-backed session
persistence smoke and adapter boundary tests pass, but an actual SDK model/tool
turn remains unverified for both the OpenCode Console default and explicit
legacy OpenAI route.

For an HTTP-only local health check after local secrets are configured, use
`npm exec wrangler -- dev --local`, then request `GET /health`. This tests the
local Worker health endpoint, not remote D1/Queue behavior, App webhooks, model
execution, Container provisioning, sandbox isolation on Cloudflare, or PR
publication.

### Docker verification helper smoke

The Phase 3 helper is built into the configured image. On 2026-10-09, a local
amd64 image was built with:

```sh
docker build --platform linux/amd64 --tag ocpa-cloudflare-sandbox:phase4-local .
```

An ephemeral network-disabled container was then run with
`docker run --rm --network none --platform linux/amd64 --entrypoint /bin/bash -i ocpa-cloudflare-sandbox:phase4-local -s`.
The stdin-only fixture driver ran `verify.py reset`, `inventory`, and `prepare`,
then executed the regex-escaping Python fixture (2 tests) and BOM-stripping
Node fixture (2 tests) as the unprivileged `runner`; the complete helper
inventory matched before and after. The regex case checked literal metacharacter
escaping, `\x2d` hyphens, and TypeError behavior; the BOM case removed exactly
one leading U+FEFF, preserved interior/repeated BOMs, checked TypeError, and
confirmed a target-only helper remained intact. No upstream checkout, model,
GitHub token, or other credential entered the container. This is real local
Linux helper/fixture evidence only—not the still-reserved hosted
route/DO/SDK/publisher integration or Cloudflare Containers deployment proof.
A mocked runner is not evidence that Linux checks passed.

## Register an approved target

The admin API is bearer-token protected and intended for one trusted self-hosting
operator, not public onboarding. It accepts repository identity, an explicit
branch and baseline, and a complete reviewed policy. For example:

```json
{
  "installationId": 12345678,
  "target": { "owner": "your-org", "name": "target" },
  "baseBranch": "main",
  "upstream": {
    "repository": "https://github.com/upstream-org/project.git",
    "ref": "main",
    "baselineCommit": "0123456789abcdef0123456789abcdef01234567"
  },
  "policy": {
    "version": 1,
    "upstream": {
      "repository": "https://github.com/upstream-org/project.git",
      "ref": "main"
    },
    "selections": [{
      "id": "retry-policy",
      "description": "Port the approved retry behavior.",
      "upstreamPaths": ["src/retry/**", "test/retry/**"],
      "excludeUpstreamPaths": [],
      "targetPaths": ["lib/retry/**", "test/retry/**"],
      "acceptance": ["Permanent failures do not retry."],
      "mappings": [{ "upstream": "src/retry/**", "target": ["lib/retry/**"] }]
    }],
    "preserve": ["Keep target-only adapters unchanged."],
    "verification": [{
      "command": "python3",
      "args": ["-B", "-m", "unittest", "discover", "-s", "test"],
      "timeoutSeconds": 300
    }],
    "limits": {
      "maxCommits": 100,
      "maxChangedPaths": 5000,
      "maxFiles": 200,
      "maxContextBytes": 250000,
      "maxFileBytes": 250000,
      "maxResponseBytes": 1000000,
      "maxVerificationOutputBytes": 65536,
      "maxJobSeconds": 1800,
      "maxAttempts": 2,
      "maxSteps": 50
    }
  }
}
```

`verification` is trusted executable configuration. It is launched as an argv
array without a shell, but it can still execute arbitrary code from the target
workspace. Inspect every executable and argument; never accept these values
from an untrusted caller. The example is illustrative and must be replaced with
the target's real paths/tests.

Authenticated routes:

- `GET /admin/configuration` — inspect the shared credential configuration without
  returning secrets or contacting providers.
- `POST /admin/registrations` — validate installation access and store the
  approved policy/baseline.
- `GET /admin/registrations` — list the current operator's registrations.
- `POST /admin/registrations/<id>/run` — enqueue a bounded poll.
- `POST /admin/registrations/<id>/active` — activate/deactivate with the
  current `expectedRevision`.

All require `Authorization: Bearer <ADMIN_TOKEN>`. Registration responses expose
the generated tracking ID, revision, and separate checked/synced commit values.
The baseline is an operator assertion, not a parity test. Review the first
draft PR. The checkpoint advances only after confirmed merge state on the
configured base; it never merges automatically.

Store the reviewed payload in an operator-controlled local file such as
`registration.json`, then submit it without placing the token in source or shell
history:

```sh
curl --fail-with-body --request POST \
  --header "Authorization: Bearer ${ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data @registration.json \
  "${WORKER_URL}/admin/registrations"
```

## Boundaries and known limitations

- The model receives selected source/target reference data and has only
  session-scoped read/stage/report tools. It has no shell, GitHub token,
  publication API, target plugins, or automatic instruction loading.
- The sandbox is started with outbound internet disabled, receives no secrets,
  and runs configured checks under an unprivileged account. Project dependency
  downloads therefore need an operator-reviewed image/build strategy; arbitrary
  internet access is not enabled by default.
- Durable state and idempotency reduce duplicate effects; they do not prove
  exactly-once delivery or remove the need for review/recovery.
- Inference/verification is capped at two job generations per target registration,
  policy hash, and `lastSyncedCommit` origin, independent of unrelated upstream
  heads and target-base changes. This prevents README-only commits or base churn
  from resetting the budget. A `sync-origin-generation-limit` failure is retained
  and does not call the agent or verifier again; advancing `lastCheckedCommit`
  alone does not reset it. The cap is deliberately conservative: later selected
  changes may also wait until a reviewed cumulative proposal is merged and
  advances `lastSyncedCommit`, or a separately approved operator recovery is
  planned. There is no self-service budget-reset route; do not delete job/effect
  records or rewrite checkpoints by hand.
- This is an administrator-only self-hosted MVP, not a multi-tenant service.
  There is no OAuth onboarding UI, user management, billing, auto-merge, or
  force-push path.
- The package lock currently reports 17 npm audit advisories (5 high). The
  transitive `@opentui/core@0.5.17` declares Node `>=26.4.0` and produces an
  npm engine warning on the tested Node 22 runtime. The Wrangler metafile does
  not include `@opentui/core` or the Node SQLite adapter, but does include
  `@opencode/util/dist/effect/app-node.js` and external Node built-ins such as
  `node:child_process` and `node:fs` (five static child-process imports and 25
  static fs imports in the Worker bundle). `nodejs_compat` is enabled, and the
  actual Workerd smoke proves SDK host/session initialization, not reachability
  of every bundled Node import or provider operation. Do not blindly override
  packages or claim a clean runtime audit.
  The CI/test engine range reflects installed Vitest's actual Node requirement,
  not a claim that every transitive package has no engine warnings.
- The hosted fixture verifies the actual fixed acceptance tests in a local Node
  process, but it does not exercise the production sandbox image or Linux
  isolation. The deployed app, provider/model execution, live GitHub permissions,
  and remote draft lifecycle remain unverified. Before production, require the
  independent review/re-review and a human-run GitHub installation/model/Linux
  sandbox/draft-PR cycle in an isolated account with reviewed quotas.
