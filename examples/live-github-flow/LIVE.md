# Live GitHub App flow: dedicated backend

This guide covers **provisioning only**. Provisioning creates the dedicated Worker, its new D1 database and queues, applies only that database's migration, uploads the approved secrets, and deploys the fixed public Sandbox preview image. It does **not** register the repository, run a job, call the model, create a pull request, or merge anything.

The controller is import-safe. Do not run it until the independent Sol review explicitly approves the controller, the live-entry wrapper, and the OpenCode credential resolver.

## Fixed target

| Item | Value |
| --- | --- |
| Cloudflare account | `324e23339afefd2f1f689e735c2b8789` |
| Worker | `oc-port-agent-live-test-20261010` |
| Workers.dev URL | `https://oc-port-agent-live-test-20261010.kye-324.workers.dev` |
| GitHub owner / repository | `kyeshmz/oc-port-agent-live-test-20261010` (private) |
| GitHub App | `oc-port-agent-20261010` (ID `5266090`) |
| Selected-repository installation | `170044765` |
| Sandbox image | `docker.io/cloudflare/sandbox:0.13.0-next.776.1-python` |

The controller checks that the App belongs to `kyeshmz`, retains only the intended contents / pull-request / metadata permissions and `pull_request` event, and that the installation exposes exactly the private fixture repository. It does not install the App anywhere.

## Provisioning prerequisites

1. Finish the independent Sol review. This is a hard gate for any actual credential resolution or remote write.
2. Use Node 22 or later and the checked-in `apps/cloudflare/node_modules/wrangler` install. The controller uses native Wrangler authentication without exporting Wrangler credentials, and explicitly sets `CLOUDFLARE_ACCOUNT_ID=324e23339afefd2f1f689e735c2b8789` for every Wrangler child process. It stops if the inherited account ID points elsewhere or `wrangler whoami` does not confirm the target account.
3. Ensure the setup helper's `examples/live-github-flow/.private/credentials.json` is the newly generated App file, owned by the current OS user, regular/non-symlink, mode `0600`; `.private/` must be owned by the current user, regular/non-symlink, mode `0700`. The controller rejects unexpected fields; it does not read global GitHub credentials or reuse any provider key in this file.
4. Ensure the supported OpenCode SDK/plugin API can read the exact Console connection metadata: integration `opencode`, credential ID `cred_ff5c3340d002t0edkOPNVJLA35`, method `key`, label `default`. The resolver refuses changes and returns the value only to the in-process deployment controller. It does not change the active connection, prompt a model, or access other integrations.
5. Do not set a conflicting `CLOUDFLARE_ACCOUNT_ID`. Do not create a Worker, D1 database, or queue with the controller's fixed Worker name or its generated `ocpa-live-test-20261010-<random-suffix>-*` resource names. Unknown existing resources cause a stop, not an overwrite.

## Explicit provisioning command

From the repository root, after review and operator approval:

```sh
node examples/live-github-flow/deploy-worker.mjs --execute
```

The command writes protected owned state/configuration beneath ignored `.private/`, keeps a separate mode-`0600` admin-token file at `examples/live-github-flow/.private/live-worker-admin-token`, and records only nonsecret resource/version metadata in a new version-specific file under `examples/live-github-flow/evidence/`. Secret values are passed to Wrangler only through `--secrets-file /dev/stdin`; they are not arguments, environment variables, stdout, state, or evidence. The OpenCode key is never written to a local file.

The controller uses unique test-prefix names for a fresh D1/main Queue/dead-letter Queue, one queue consumer with batch size and concurrency set to `1`, one Sandbox instance of `standard-1`, and no cron trigger. Migrations are applied with the generated config and the explicit new D1 name using `--remote`. It uses a public registry image reference, not a Dockerfile or local Docker build.

The generated config sets `GITHUB_APP_ID=5266090`, `OPENCODE_PROVIDER=opencode`, and `OPENCODE_MODEL=gpt-6-luna`. Its required secret names are exactly `ADMIN_TOKEN`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, and `OPENCODE_API_KEY`. The Worker source path is `../../../apps/cloudflare/src/live-entry.ts` relative to the generated `.private/live-worker.wrangler.jsonc`; the D1 migration directory is the absolute `apps/cloudflare/migrations` directory in this checkout. Cron is disabled by omitting `triggers`.

If the command stops after creating a resource, it preserves that resource and the last ownership phase in protected `.private/live-worker-state.json` and updates the nonsecret `evidence/live-worker-resources-<suffix>.json` ownership record after each verified resource ID. Do not delete or rename the resource to make a retry pass. The state machine resumes only when saved IDs and Worker version/tag metadata match; ambiguous partial ownership requires operator review.

## Separate runtime preflight

After provisioning, the operator may run the fixed runtime preflight separately. It authenticates with the protected admin-token file, sends an empty `POST`, reads only the pinned fixture at main commit `8cf62db4e306d8b40cdf7cb4a7b016333ded6655` through the App, and executes only `node --test test/strip-prefix.test.mjs` in the actual Sandbox runner. No model/provider call or edit is involved. The expected result is a **trusted failure** (`command-failed`, nonzero exit, no workspace-file changes) because the base fixture contains the known initial BOM behavior mismatch. A pass, timeout, changed fixture, unexpected hash/mutation evidence, or cleanup failure does not count as ready.

To avoid placing the admin token in shell history, arguments, or output, invoke the request from Node and read the protected file directly inside that process:

```sh
node --input-type=module -e '
import { readFile } from "node:fs/promises";
const token = (await readFile("examples/live-github-flow/.private/live-worker-admin-token", "utf8")).trim();
const response = await fetch("https://oc-port-agent-live-test-20261010.kye-324.workers.dev/admin/runtime-check", {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
const result = await response.json();
console.log(JSON.stringify(result));
process.exitCode = response.ok ? 0 : 1;
'
```

The endpoint returns only whitelisted status/step counts, the fixture pin, a workspace digest, and the fixed test-name/count/failure-category proof. A private in-memory observer validates the bounded TAP output against the exact three fixture test names and expected BOM `ERR_ASSERTION`/`strictEqual` mismatch; only its closed proof is returned. It never returns TAP/stdout/stderr, repository contents, credentials, or arbitrary command output.

Expected success shape (the command must exit nonzero if the response is not HTTP-success):

```json
{
  "status": "ready",
  "expectedFailureObserved": true,
  "repository": "kyeshmz/oc-port-agent-live-test-20261010",
  "commit": "8cf62db4e306d8b40cdf7cb4a7b016333ded6655",
  "inputWorkspaceSha256": "<64 lowercase hex characters>",
  "verification": {
    "status": "failed",
    "failureCode": "command-failed",
    "step": {
      "index": 0,
      "exitCode": 1,
      "durationMs": 25,
      "stdoutBytes": 100,
      "stderrBytes": 50
    },
    "workspaceFiles": 0,
    "unchanged": true,
    "oracle": {
      "totalTests": 3,
      "passed": 2,
      "failed": 1,
      "failedTest": "remove exactly one leading BOM, preserving repeated and interior BOMs",
      "passedTests": ["reject nonstrings without coercion", "preserve the target-only helper"],
      "failureCategory": "ERR_ASSERTION/strictEqual/BOM-mismatch"
    }
  }
}
```

## Registration, bounded model run, and merge are separate operator actions

Do not perform these steps as part of provisioning or runtime preflight.

1. Once the Worker and webhook URL are ready, redeliver the actual signed GitHub `installation` webhook through the App's delivery controls. GitHub automatically delivers installation lifecycle events; do not fabricate or manually post a webhook. The endpoint is `https://oc-port-agent-live-test-20261010.kye-324.workers.dev/webhooks/github`.
2. Copy `examples/live-github-flow/registration.template.json` to `examples/live-github-flow/.private/registration.live.json` and change only `installationId` to the numeric JSON value `170044765` (not a string). The registration schema is `{ installationId: number, target: { owner: string, name: string }, baseBranch: string, upstream: { repository: string, ref: string, baselineCommit: string }, policy: object }`. Keep owner `kyeshmz`, target `oc-port-agent-live-test-20261010`, base `main`, upstream ref `upstream`, and baseline `8cf62db4e306d8b40cdf7cb4a7b016333ded6655` unchanged. Keep the complete `policy` object from the template unchanged; it selects only `reference/bom.js` → `lib/strip-prefix.js`, protects the tests/config/helper, and verifies with `node --test test/strip-prefix.test.mjs` (`timeoutSeconds: 30`, one attempt, 15 steps, 180 seconds, 16,384 verification-output bytes).
3. Submit that JSON to `POST /admin/registrations` with its JSON body. Use the same Node pattern above, reading both JSON and admin token from local protected/ignored paths. Print only the returned registration ID and public baseline metadata; never print the Authorization header.

   ```sh
   node --input-type=module -e '
   import { readFile } from "node:fs/promises";
   const base = "https://oc-port-agent-live-test-20261010.kye-324.workers.dev";
   const token = (await readFile("examples/live-github-flow/.private/live-worker-admin-token", "utf8")).trim();
   const registration = JSON.parse(await readFile("examples/live-github-flow/.private/registration.live.json", "utf8"));
   const response = await fetch(`${base}/admin/registrations`, {
     method: "POST",
     headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
     body: JSON.stringify(registration),
   });
   const result = await response.json();
   console.log(JSON.stringify({
     status: response.status,
     registrationId: result?.registration?.id ?? null,
     active: result?.registration?.active ?? false,
     lastCheckedCommit: result?.registration?.lastCheckedCommit ?? null,
     lastSyncedCommit: result?.registration?.lastSyncedCommit ?? null,
   }));
   process.exitCode = response.ok ? 0 : 1;
   '
   ```

4. Only after the runtime preflight reports the expected trusted failure and the operator approves the possible provider charge, submit one explicit empty-body `POST /admin/registrations/<registration-id>/run`. It accepts only a validated registration ID and does not accept commands or repository/ref overrides. Provisioning itself never schedules or launches this run.

   ```sh
   REGISTRATION_ID='<id-from-step-3>' node --input-type=module -e '
   import { readFile } from "node:fs/promises";
   const base = "https://oc-port-agent-live-test-20261010.kye-324.workers.dev";
   const token = (await readFile("examples/live-github-flow/.private/live-worker-admin-token", "utf8")).trim();
   const registrationId = process.env.REGISTRATION_ID;
   if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(registrationId ?? "")) throw new Error("invalid registration id");
   const response = await fetch(`${base}/admin/registrations/${encodeURIComponent(registrationId)}/run`, {
     method: "POST",
     headers: { authorization: `Bearer ${token}` },
   });
   const result = await response.json();
   console.log(JSON.stringify({ status: response.status, accepted: result?.accepted === true }));
   process.exitCode = response.ok ? 0 : 1;
   '
   ```
5. Review the actual model edits, verifier result, App-authored draft PR, and pinned evidence. Merge only the verified PR in this disposable repository as an explicit operator action. Then allow the genuine merged-PR webhook/reconciliation and verify the final unchanged-upstream run is model-free.

The admin-token pattern can be reused for those JSON requests: read the token and request file inside Node, send them via `fetch`, and print only a deliberately filtered response. Never paste the token, App private key, webhook secret, or OpenCode key into chat or a command line.

## Implementation references

- [OpenCode V2 embedded SDK](https://opencode.ai/v2/docs/build/sdk) and [plugin integration API](https://opencode.ai/v2/docs/build/plugins#integrations)
- [Wrangler Worker deploy and `--secrets-file`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)
- [Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Containers deploy and registry images](https://developers.cloudflare.com/containers/guides/deploy/)
