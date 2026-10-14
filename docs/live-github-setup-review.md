# Local GitHub App approval-helper review

Date: 2026-10-10  
Scope: bounded, read-only Phase 2 helper review under `.plans/live-github-flow.md`, before user approval or real credential handling.

## Decision

**Approved for the local, tested helper scope only. No blocking correctness or privacy defect was identified.** This is not approval evidence for a registered/installed GitHub App, a deployed Worker, working provider credentials, or the full live flow. Phase 2's actual registration, installation, and dedicated-backend setup remain pending.

Reviewed `examples/live-github-flow/setup-app.mjs`, `setup-app.test.mjs`, `SETUP.md`, and `.gitignore`, against the plan's helper constraints. Implementation was not changed. No browser was launched; no live GitHub conversion, credential access, provider request, deployment, Docker operation, or commit was performed. Offline tests used only synthetic credentials and disposable stores under the approved OpenCode temporary root.

## Review findings

- **UI and CSP:** Both fixed HTML pages receive fresh CSP nonces on their inline scripts (`setup-app.mjs:114–125`). The regression checks match each script nonce to its response policy without `unsafe-inline`. Registration stays disabled until the local manifest fetch succeeds; the form posts a JSON-encoded manifest and state to the fixed personal-account GitHub registration URL. Completion rendering uses `textContent` and a validated slug for its GitHub link, not response-derived HTML. No private key, webhook secret, or provider key is rendered.
- **Local request boundary:** The listener binds only to `127.0.0.1`; requests must have the exact loopback Host and local URL origin (`501–520`, `595`). Approval/completion-info reads reject foreign Origin and cross-site fetch metadata. Provider writes require the exact Origin and form content type. The callback intentionally allows GitHub's cross-site navigation, but requires a random 32-byte state, exact single parameters, and constant-time comparison; accepted state is consumed before conversion. Provider CSRF is similarly random, compared in constant time, and consumed before writing. Body/header sizes and server timeouts are bounded.
- **GitHub conversion:** Only a bounded, validated manifest code can enter the fixed HTTPS `api.github.com/app-manifests/{code}/conversions` POST (`338–359`, `422–450`). It has no request body, follows no redirects, uses a 15-second abort signal, and reads at most 32 KiB of response data. App ID, slug, PEM envelope/size, and webhook-secret size/content are validated. Only required fields are retained; client secret and unrelated response fields are discarded. Failures return fixed generic text and are not logged or echoed.
- **Protected storage and reuse:** The default store is covered by `.private/` in the local `.gitignore`. Startup requires an owned, nonsymlink mode-0700 directory and refuses any existing credential path without reading or replacing it (`168–200`). New credentials are written to an exclusive mode-0600 temporary file, synced, and published with a no-clobber hard link. Optional provider updates use atomic rename only after validating the current process's credential-file identity, owner, mode, and link count (`203–277`). Temporary files stay in the same ignored protected directory and are cleaned on normal completion/error. This helper intentionally does not resume credentials after restart.
- **Callback, status, and optional provider input:** Successful callbacks redirect with 303 to `/complete`, removing callback parameters from the destination. Failed callbacks return generic 400/502 text rather than a clean redirect; their incoming URL can still contain the temporary code/state, so it must not be copied into evidence or chat. `/status` contains only public App identity and readiness booleans; installation/backend readiness always remain missing. Provider input is a password field, bounded, same-origin/CSRF protected, saved only to the process-owned store, and never sent to a provider. The page discloses possible later model charges.
- **Approval and installation boundary:** The UI/docs require the user's normal authenticated browser and GitHub approval; no login automation exists. The manifest requests a private App with contents/pull-request write and metadata read permissions. The installation link itself is not repository-restricted: the operator must wait for backend readiness and explicitly choose **only** `kyeshmz/oc-port-agent-live-test-20261010`. The helper neither installs nor verifies permissions or deployment.

## Independent verification

All three required checks exited 0:

```text
node --test examples/live-github-flow/setup-app.test.mjs
tests 9; suites 0; pass 9; fail 0; cancelled 0; skipped 0; todo 0

node --check examples/live-github-flow/setup-app.mjs
(no output)

git diff --check
(no output)
```

The test command was run with `TMPDIR` set to the approved OpenCode temporary root. An additional `git check-ignore` confirmed both the default credential path and a representative temporary credential path are ignored; it did not read either file.

Tests exercise the manifest, both HTML/CSP responses, mocked successful conversion, callback replay/rejection, Host/Origin rejection, provider storage, response/form bounds, generic API failures, synthetic-secret non-disclosure, and startup refusal of prior/symlinked stores. These are offline HTTP/source checks, not browser DOM execution or real GitHub permission/manifest validation. The tests do not independently exercise every timeout/filesystem-error branch or explicitly replay a successful provider POST; the one-use behavior was also inspected in source.

## Follow-ups and handoff

No implementation repair is required by this review. Remaining evidence belongs to the operator/planner, not this review:

1. User-driven browser approval must establish real GitHub acceptance, final App ownership/permissions, and successful local completion. Do not infer these from the mocked exchange. GitHub's documented form/state/conversion flow supports the reviewed wiring, but is not live proof: [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
2. Provision the **dedicated test Worker**, its resources and secrets through the approved secure path; leave the smoke Worker untouched. Resolve provider credential/run policy and the real trusted verifier-runtime requirement. Keep cron disabled until the required checks pass.
3. Install only after backend/webhook readiness and verify the one selected repository. Registration alone cannot satisfy this gate.

For the later authorized launch, from the repository root:

```sh
node examples/live-github-flow/setup-app.mjs
```

Default setup URL: `http://127.0.0.1:8807/`; nonsecret readiness URL: `http://127.0.0.1:8807/status`. The helper was not launched outside the offline tests. Keep the process running through registration and optional provider entry; if it refuses a pre-existing store, do not delete, export, or overwrite credentials to bypass that refusal.
