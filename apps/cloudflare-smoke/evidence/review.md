# Phase 6 independent live-smoke review

Reviewed 2026-10-09 by Sol high. **Outcome: deployed smoke proof sufficient;
no critical/high or other blocking defect found within this bounded scope.**

Worker: <https://oc-port-agent-sdk-smoke-kyeshmz-20261009.kye-324.workers.dev>

## Independent checks

`npm --prefix apps/cloudflare-smoke run typecheck` exited 0:

```text
> @oc-port-agent/cloudflare-sdk-smoke@0.1.0 typecheck
> tsc --project tsconfig.json --noEmit
```

Unauthenticated HTTPS probes at `2026-10-09T22:35:39.264Z` all passed:

| Request | Status | Response body |
| --- | --- | --- |
| GET `/health` | 200 | `{"status":"ok","versionId":"51cccc78-9519-4676-8bde-c53661f45211"}` |
| GET `/smoke/read` | 401 | `{"error":"unauthorized"}` |
| POST `/smoke/write` (bodyless) | 401 | `{"error":"unauthorized"}` |

`git diff --check` exited 0 with no output. No authenticated test, deployment,
secret rotation, Docker, model invocation, or credential access was performed
by this reviewer. Implementation was read-only; the main app was not reviewed.

## Correctness assessment

- `src/index.ts:19–47`: one retained SDK host Promise per DO lifetime; constructor
  initialization blocks incoming events. Real `OpenCodeWorkerd.create()` finishes
  before the application creates `smoke_state`, preserving SDK-first schema
  initialization on fresh SQLite storage. Initialization errors reset the object
  rather than exposing a partially ready host.
- `src/index.ts:49–128`: only one fixed DO name, SDK session ID, title and checkpoint
  are used. Parameterized SQL stores three fixed keys; no request-selected state,
  arbitrary SDK proxy, prompt, tool execution or model inference path exists.
  Recovery checks the fixed SDK session when creation throws, handling a prior
  SDK commit without an app pointer. Reads require the expected pointer, actual
  SDK session ID and checkpoint value; errors are not returned as success.
- `src/index.ts:131–183`: auth precedes DO access on both smoke routes; SHA-256
  digests are compared without a secret-prefix early exit. Health returns only
  status/version. SDK failures return a generic 500 and log only a fixed message,
  route and error class, not the token or raw SDK error text. Requests cannot
  supply prompts, discovery paths, plugins, provider credentials or URLs.
- `wrangler.jsonc:3–25`: isolated workers.dev Worker, generated version binding,
  one SQLite DO class export, required smoke secret, current compatibility date,
  node compatibility and logs/traces. No container, D1, queue, cron or custom
  route is configured. Current Cloudflare docs confirm `exports` is supported;
  absence of legacy `migrations` is not a defect.
- Package, lockfile and installed SDK agree on `2.0.26`. Generated declarations
  type both the namespace and secret. Installed SDK Workerd code uses injected
  DO SQLite, an in-process client transport, empty config plugin discovery and
  unavailable local filesystem/process services. Explicit model catalog fetch
  and snapshot flags are false. This does not claim the entire SDK tool graph
  was removed; only the fixed server-info/session APIs are reachable here.
- `scripts/test-online.mjs:150–307`: deploy/resume checks are scoped to the named
  smoke Worker and recorded deployments. The generated token is passed over
  stdin and used in memory; saved evidence contains no token or auth header.
  The script really deploys and exercises HTTPS; it is not an offline mock.

## Evidence and proof limits

Authenticated results in `live.json` are **implementer evidence reviewed, not
independently rerun**. They record HTTP 200 for SDK server info/session retrieval
and app checkpoint write/read. The latest write has
`sessionCreatedThisRequest: false`; it retrieves an existing session, not a fresh
creation on that request. SDK `server.info().version` is honestly `unknown`;
the installed/pinned package version is not a runtime-reported version.

The retained earlier observation at `2026-10-09T22:14:42.950Z` has different boot
IDs (`7b6cc9f3…` to `fed814d9…`) and Worker versions (`1f3b6919…` to `1480c699…`),
with the same session and checkpoint, supporting recovery in a new DO instance.
The latest observation retains boot `7ec57e74…` and DO version `bda44a6f…` after
redeploy to `51cccc78…`; it proves read-back only in that same instance. A
150-second wait does not itself prove eviction. Independent health confirms
the latest public Worker version, not the DO's current boot identity.

This is sufficient for the isolated real Cloudflare SDK/DO smoke objective. It
does not approve the main App, porting workflow, inference, Linux verification,
production reliability, or future use beyond the smoke. Deployed resources were
left unchanged: the smoke Worker, its SQLite DO namespace and smoke secret.

## Nonblocking regression follow-ups

1. `scripts/test-online.mjs:243–245`: assert the post-redeploy health version ID
   equals the recorded redeploy version, as the pre-redeploy check already does;
   currently only HTTP 200 is asserted there. Keep same-boot results separate.
2. Add small offline regressions for SDK-first initialization, fixed-session
   recovery/read failure, and auth-before-DO access. Also check the distinction
   between retained `sessionCreated` and `sessionCreatedThisRequest`; the former
   is a persisted availability marker, not proof of a new create on each run.

Neither follow-up requires broadening this smoke into a production project.

References: [OpenCode V2 Cloudflare SDK](https://opencode.ai/v2/docs/build/sdk/cloudflare/),
[DO class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/),
[DO initialization ordering](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile).
