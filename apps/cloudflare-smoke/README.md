# OpenCode SDK Cloudflare live smoke

This package deploys one isolated `workers.dev` Worker and one SQLite-backed
Durable Object to verify the real OpenCode Workerd SDK without Docker, prompts,
model inference, or Linux subprocesses. It is deliberately separate from the
in-progress application under `apps/cloudflare/`.

## Scope and safety

- Worker: `oc-port-agent-sdk-smoke-kyeshmz-20261009` in account
  `324e23339afefd2f1f689e735c2b8789`.
- Only `/health` is public. The fixed `/smoke/write` and `/smoke/read` routes
  require a generated `SMOKE_TOKEN`; neither accepts arbitrary SDK paths,
  prompts, commands, or user data.
- One fixed Durable Object ID and one fixed SDK session ID are retained. The
  OpenCode SDK initializes first in `blockConcurrencyWhile`; the small app
  checkpoint table is created afterward in the same SQLite storage.
- Plugins, web search, MCP servers, model-catalog network fetches, and all
  permissions are disabled. The smoke creates and reads a session but never
  submits a prompt or invokes a model.
- Wrangler receives the generated token through stdin. The online test does
  not write the token to source, command arguments, logs, or evidence.
- The Worker is left deployed after the test. No route, custom domain, cron,
  container, D1 database, queue, account setting, or billing plan is changed.

## Commands

From the repository root:

```sh
npm --prefix apps/cloudflare-smoke ci
npm --prefix apps/cloudflare-smoke run types
npm --prefix apps/cloudflare-smoke run typecheck
npm --prefix apps/cloudflare-smoke run build
npm --prefix apps/cloudflare-smoke run test:online
```

`test:online` first confirms the target Worker has no existing deployment,
then deploys it, uploads a newly generated secret over stdin, checks health and
unauthorized access, and runs the fixed authenticated SDK/checkpoint test over
HTTPS. It redeploys the same Worker and performs read-only session/checkpoint
checks again after a 150-second idle interval intended to permit DO hibernation
or eviction. It writes safe response/version/boot-ID evidence to
`evidence/live.json`. It will stop rather than overwrite a Worker that already
exists under the chosen name. If a run stops after creating the Worker, rerun
with `npm --prefix apps/cloudflare-smoke run test:online -- --resume`; this
requires the current deployment to match the prior package-generated evidence
before redeploying the package code and rotating the smoke-only secret.

## Result boundaries

The evidence proves only the deployed Workerd SDK server-info and session
create/get paths plus the Durable Object SQLite checkpoint read/write path. A
changed boot ID after redeploy indicates a new DO instance; if Cloudflare keeps
the instance alive, the evidence records that limitation while still checking
the deployment version and persisted records. This does not test provider
connectivity, model inference, GitHub, Docker, or Linux verification.

References: [OpenCode SDK for Cloudflare](https://opencode.ai/v2/docs/build/sdk/cloudflare/),
[Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/),
and [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/).
