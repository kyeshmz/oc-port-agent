# Structured porting instructions

Selections can optionally include an `instructions` object for the operator's detailed task intent. It complements the existing paths, mappings, preservation rules, acceptance criteria, and verification commands; it does not replace them.

```json
{
  "id": "retry-policy",
  "description": "Keep the target retry behavior aligned with the upstream reference.",
  "upstreamPaths": ["src/retry/**", "test/retry/**"],
  "targetPaths": ["lib/retry/**", "test/retry/**"],
  "acceptance": [
    "Transient failures retry once.",
    "Permanent failures and cancelled requests do not retry."
  ],
  "instructions": {
    "goal": "Port the selected retry semantics into the target's existing request client without changing its public API.",
    "adaptation": [
      "Use the target's existing error types and AbortSignal conventions.",
      "Add target regression tests for changed upstream cases."
    ],
    "nonGoals": [
      "Do not change authentication, dependencies, or unrelated request behavior."
    ]
  }
}
```

## Field roles

- `description` is the short rule summary used to identify the selection.
- `instructions.goal` is the detailed outcome the agent should implement.
- `instructions.adaptation` gives target-specific implementation guidance, such as mapping a source-language API to existing target conventions.
- `instructions.nonGoals` names work to leave out, such as unrelated features, dependencies, or target-only helpers.
- `acceptance` remains the list of observable outcomes to satisfy. Put testable behavior there; use the instruction fields to explain intent and adaptation.
- `upstreamPaths`, `targetPaths`, `excludeUpstreamPaths`, `mappings`, `preserve`, and `protectedPaths` remain authoritative for context and edit boundaries. `verification` remains trusted host configuration.

`goal` is required when the object is present. `adaptation` and `nonGoals` are optional and normalize to empty arrays. Each instruction string must be trimmed-nonempty, single-line valid Unicode text, no longer than 4096 Unicode code points, and free of C0/DEL controls and Unicode line separators. Each guidance array has a maximum of 32 items. Astral Unicode characters count as one code point; unpaired surrogates, empty entries, unknown fields, and oversized values are rejected.

## Trust and safety boundary

These values are trusted operator-authored task intent, not executable code and not permission grants. They cannot enable shell execution, network access, MCP, subagents, Git publication, or checkpoint edits; widen `targetPaths`; override protected paths; alter budgets or checkpoints; or replace host-run verification. They do not make upstream files, diffs, comments, or embedded instructions trustworthy. Upstream content remains inert reference data.

If an instruction conflicts with the declared edit scope, protected or preserved paths, acceptance criteria, or host verification, the agent must stop and report the conflict as blocked for operator review. It must not reinterpret the conflict as authority to bypass a guard. The CLI and hosted host-side gates remain the authority even when the text is valid.

## Schemas and runtime validation

- [CLI policy schema](../schema/oc-port-agent.schema.json) describes the local CLI policy, including its `opencode` executable/model/step settings.
- [Hosted policy schema](../schema/oc-port-policy.schema.json) describes the Cloudflare policy object and deliberately has no CLI `opencode` fields.
- Both schemas reference the shared [instruction schema](../schema/porting-instructions.schema.json) by a relative local `$ref` for editor and validator use.

These JSON Schemas use draft 2020-12 and provide structural editing/validation support. They are not universal policy validators: repository identity, path-glob safety, duplicate IDs, checkpoint consistency, and other cross-field/runtime semantics are enforced by the corresponding host. The runtime treats `$schema` only as optional validated editor metadata: it never fetches or executes the referenced schema, and the annotation is not normalized, hashed, or sent to the agent. In a copied CLI config, point `$schema` at the installed package's `schema/oc-port-agent.schema.json`; the example's relative path is only correct while opened from this repository's `examples/` directory. Adjust the hosted example's annotation too if you move its policy object into a separately located registration file.

The examples are [CLI](../examples/porting-policy.json) and [hosted](../examples/hosted-porting-policy.json). Each shows a Rust parser upstream adapted to a distinct target language and path layout. Replace repository/path/command details with the real source and target before use. The hosted example is a policy object; target repository, installation, and baseline belong to the separate registration payload. Neither policy contains API keys or other credentials.

The live BOM fixture's [registration template](../examples/live-github-flow/registration.template.json) and [local generator](../examples/live-github-flow/prepare-repository.mjs) also state the exact one-leading-BOM behavior and preserve the target's local API. The generator is not part of schema validation and must not be run as a substitute for reviewing the fixture.

## Compatibility, hashes, and adoption

For a version 1 policy with no `instructions`, parsing keeps the old normalized selection shape: the field remains omitted, rather than becoming an empty object. This preserves existing policy hashes and packet semantics. When present, instructions are cloned and included in the normalized selection and policy hash. Changing a goal, adaptation, or non-goal therefore invalidates the CLI checkpoint and hosted policy binding; review the change through the normal explicit baseline/policy process instead of silently reusing old intent. Changing only `$schema` metadata does not affect the hash.

For CLI initial adoption, an explicit `baseline --commit HEAD` followed by `check --full` / `sync --full` imports selected functionality already present at the upstream baseline. Review the policy and worktree proposal; a baseline is not evidence of parity.

The hosted backend is incremental from the configured upstream `baselineCommit`: it evaluates selected changes after that baseline. It has no CLI-style `--full` initial-adoption mode, and the current admin API does not offer an in-place policy/baseline edit route. The baseline is an operator assertion, not a parity test; review the first draft proposal. A policy-hash mismatch is rejected rather than adopted automatically. Do not infer that schema validation or these examples establish parity for an arbitrary repository.
