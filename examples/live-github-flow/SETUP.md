# Local GitHub App approval helper

This helper prepares the dedicated private test App for `kyeshmz/oc-port-agent-live-test-20261010`. It does not install the App, deploy a Worker, or make a provider call.

## Requirements and launch

Use Node.js 22 or newer. From the repository root, run:

```sh
node examples/live-github-flow/setup-app.mjs
```

The helper binds only to `127.0.0.1`, on port `8807` by default. It prints the local setup URL, a nonsecret `/status` URL, and the protected credentials-file path. Open the printed setup URL yourself in your normal authenticated browser. To ask the operating system for an available port, run:

```sh
LIVE_GITHUB_FLOW_PORT=0 node examples/live-github-flow/setup-app.mjs
```

The browser page submits the fixed personal-account manifest to GitHub. Review GitHub's App name and permissions and approve the registration yourself. The helper never automates GitHub login or approval. The manifest is for `oc-port-agent-live-kyeshmz-20261010`, is private, and requests only contents and pull request write access, metadata read access, and a manual subscription to `pull_request`. GitHub automatically sends `installation` and `installation_repositories` to every GitHub App; they cannot be manually subscribed. The backend still handles those automatic events. See [GitHub's webhook event documentation](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation). Its webhook URL is the planned dedicated live-test Worker URL.

The callback accepts one short-lived GitHub manifest code, exchanges it only with GitHub's fixed HTTPS conversion endpoint, and redirects to a clean local URL. It saves only the App ID, slug, private key, and webhook secret. GitHub's client secret and all other response fields are discarded. Conversion failures are intentionally generic; because the code is one-use, check GitHub App settings before retrying rather than repeating registration blindly.

## Protected local files

- `.private/` is created with mode `0700`.
- `.private/credentials.json` is created atomically with mode `0600` and ignored by Git. It contains only `appId`, `slug`, `privateKey`, and `webhookSecret`, plus `openaiApiKey` if you choose to enter one in the local completion page.
- A random `.credentials-*.tmp` file may exist briefly during an atomic write; it is inside the same protected, ignored directory and is removed on completion.

The helper refuses a symlinked/unsafe store or any pre-existing `credentials.json`; it does not inspect or overwrite credentials left by an earlier run. Keep the setup process running while completing registration and the optional provider-key form. If startup refuses the store, stop and have an operator inspect it locally—do not copy credentials into chat or another unprotected location.

The optional password field posts only to this loopback helper, uses same-origin and one-use CSRF checks, and stores the value locally. It does not call OpenAI. A later bounded live model run is limited to one attempt, 15 steps, and 180 seconds and may incur provider charges.

## Status and installation boundary

The nonsecret `GET /status` endpoint returns only public App identity and booleans:

```json
{
  "appId": null,
  "slug": null,
  "created": false,
  "missing": {
    "appCredentials": true,
    "providerKey": true,
    "installation": true,
    "backendReady": true
  }
}
```

After a successful callback, `appId`, `slug`, and `created` reflect credentials saved by the current helper process. `installation` and `backendReady` remain missing: registration is not installation or deployment. The helper intentionally does not reload a protected credentials file after process restart, so it cannot report the former process's status.

**Do not install the App until the dedicated backend and webhook endpoint are ready.** The completion page may show GitHub's installation link after registration, but it is not permission to install early. Once the backend is ready, install on **only** `kyeshmz/oc-port-agent-live-test-20261010`; do not select all repositories or any other repository. App credentials and any provider key still need to be provisioned to the dedicated Worker using the approved secure secret path. The helper does not deploy or configure that Worker.

No installation, backend deployment, Docker use, or live model run happens as part of this helper.
