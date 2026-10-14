# Public-repository adoption harness

This harness tests two narrowly scoped adaptations through the real `oc-port-agent` pipeline. Public repositories are **inert reference inputs**, not target repositories. The tool creates independent disposable target Git repositories, runs trusted acceptance tests, creates a proposal, verifies it, and locally fast-forwards only that disposable target after every gate passes. It never writes to GitHub.

## Run

The regular test suite is offline, credential-free, and makes no model calls:

```sh
npm test
```

Inspect the public harness options without fetching repositories or invoking a model:

```sh
npm run test:public -- --help
```

Live work is explicitly opt-in. To run both pinned cases with the default `openai/gpt-6-luna#max` model:

```sh
npm run test:public -- --live
```

Select one case or override the model explicitly:

```sh
npm run test:public -- --live --case strip-bom
npm run test:public -- --live --model provider/model#variant --case escape-string-regexp
```

Only `escape-string-regexp` and `strip-bom` are accepted. Unknown cases, options, and invalid model names fail before the run. Git and OpenCode CLI are required; Python 3 is also required for the regex case. The runner checks tool availability without printing credentials. It uses OpenCode's existing authentication or the provider environment already configured for the process. It does not extract, print, save, or change credentials. Configure authentication through your normal OpenCode/provider setup before opting in; never pass a key as a command-line argument.

## Pinned reference inputs

| Case | Public reference | Pinned commit | Target adaptation |
| --- | --- | --- | --- |
| `escape-string-regexp` | [sindresorhus/escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp) | `a7f7dabaf336bda98d2166848af15d9168b10bcf` | JavaScript `index.js` behavior to a Python implementation using only the standard library |
| `strip-bom` | [sindresorhus/strip-bom](https://github.com/sindresorhus/strip-bom) | `c691ec5724be8bb61e9df269a2577fcba41353f7` | JavaScript behavior to a differently named/local JavaScript API using Node built-ins |

For each case, the runner bare-clones the public repository, verifies the pinned commit object, and freezes a local `public-pinned` branch at that SHA. The agent receives only the selected source path in an inert plan packet. No public files are checked out, sourced, installed, or executed; upstream scripts, dependencies, hooks, and agent instructions remain out of the target. The disposable fixture configuration points to the frozen bare snapshot as a **local upstream**, not to a public target. An inert attribution file records the source URL, pin, and available upstream license text.

## Trusted checks and bounds

Each target begins with an intentionally incomplete implementation and operator-written tests. The runner first proves those tests fail, previews full adoption, then calls the normal `initialize`, `setBaseline`, `planSync`, and `synchronize` APIs. On a live run, `synchronize` uses its real `invokeOpenCode` adapter; only the offline regression test injects a fake adapter.

- The regex case checks exact escaping of the observed metacharacters and `-` as `\x2d`, invalid input rejection, empty and Unicode strings, backslashes, plus deterministic exhaustive short strings. Python `re` is used only in the target's trusted tests.
- The BOM case checks removal of exactly one leading U+FEFF, preservation of a second or interior BOM and all other contents, Unicode/empty/backslash inputs, and invalid input rejection.
- Both cases check their target-only helper API. The agent's editable allowlist contains only the implementation file; fixed tests, helper, configuration, attribution, state, and upstream are outside its edit scope. The runner compares fixed-file hashes and the caller target's HEAD, implementation, and checkpoint before merging.
- The host requires an applied decision with an actual implementation edit, successful configured verification, the exact pinned provenance, and no unexpected proposal files. It independently runs the trusted tests in the proposal, then again after the local fixture fast-forward. Finally, an ordinary second sync must report `up-to-date` without invoking the model.
- Each case permits at most **two** model attempts, **30** agent steps per attempt, a **300-second** attempt timeout, and **250 KB** of serialized context. Host verification commands have a 120-second timeout. Running both cases may therefore make up to four model attempts. Provider charges may apply; there is no fixed cost guarantee.

Agent-written summaries are not treated as proof. A passing result applies only to these two pinned behaviors and fixtures; it is not a claim of arbitrary-project parity, a production port, or a test of later upstream changes. Review the proposed translations and licensing before any use outside the disposable fixtures.

## Evidence and retained artifacts

Every live invocation creates a unique `oc-port-public-repositories-*` directory under `$OC_PORT_PUBLIC_TMPDIR` when set, or `$TMPDIR/opencode` by default. The same temporary root is used for retained proposal worktrees. The command prints the combined evidence path. Machine-readable `evidence/combined.json` and one evidence file per case record the public URL and SHA, model, local snapshot and target/proposal paths, selection/source hash, commands and exit codes, initial failure, fixed hashes, scope/preservation results, timings, final status, and which stages were not reached. Evidence summaries exclude prompts, credentials, and arbitrary model/server output.

Targets, local proposals, failed attempts, and evidence are retained for inspection; the runner does not delete them. A failed case exits nonzero and records the failure stage and error kind. A preserved proposal/worktree may require manual inspection. Do not merge a failed proposal. These artifacts are disposable local data and are not pushed or published.

## Observed live run

The run captured at `2026-10-09T05:31:37Z` used the real OpenCode V2.0.26 adapter and `openai/gpt-6-luna#max` with existing saved authentication. Both pinned public cases passed in approximately 83 seconds total:

| Case | Initial trusted tests | Proposal and merged tests | Fixed tests/helper/config | Second sync |
| --- | --- | --- | --- | --- |
| `escape-string-regexp` | Failed as intended | Passed | Unchanged | `up-to-date`, no model call |
| `strip-bom` | Failed as intended | Passed | Unchanged | `up-to-date`, no model call |

Both proposals changed only their allowed implementation file plus the host-written evidence report. Caller HEAD, implementation, and checkpoint remained unchanged until the explicitly verified local fixture merge. The source repository was not committed, merged, or pushed. The full offline suite afterward reported 36 passed, 0 failed, and 1 optional CLI test skipped; typecheck passed.

Retained combined evidence on the machine that ran the test:

```text
/var/folders/q6/tz5lqjtn66q2cw4jg9qtfcj00000gn/T/opencode/oc-port-public-repositories-J2zM9B/evidence/combined.json
```

This is a local temporary artifact, not a portable or published result URL. The evidence names both retained targets and proposal worktrees. Re-running the command generates fresh evidence. An earlier implementation-subagent attempt through the OpenCode provider failed with insufficient account funds; the user explicitly selected OpenAI for the successful implementation and live tests. No credentials were extracted or changed.
