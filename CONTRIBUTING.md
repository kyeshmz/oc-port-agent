# Contributing

See [README.md](README.md) for configuring a target and using the tool.

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

The package has not been published to npm. You can also run `npm link` to expose its `oc-port-agent` executable locally.

## Development

```sh
npm ci
npm run typecheck
npm test
# Optional: parse the generated agent using the installed V2 CLI; no model calls.
OC_PORT_TEST_OPENCODE=1 npm test
```

Tests use disposable local Git repos and a fake model adapter. They exercise upstream fetching, initial adoption, checkpoint activation on merge, deletion context, scope protection, verification failure/retries, complete reports, and the real CLI adapter's arguments/cleanup. No paid model calls or live GitHub writes are required.

The pinned public-repository harness is separate and explicitly opt-in: `npm run test:public -- --help` shows its options. Live runs require `--live`; the default `npm test` remains offline and credential-free. Both cases passed a real run using `openai/gpt-6-luna#max`, with protected tests and model-free second-sync checks. See [docs/public-repository-tests.md](docs/public-repository-tests.md) for the pinned cases, safeguards, bounds, observed results, and evidence location.
