import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(scriptPath));
const wranglerPath = join(packageRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const workerName = "oc-port-agent-sdk-smoke-kyeshmz-20261009";
const accountId = "324e23339afefd2f1f689e735c2b8789";
const checkpointValue = "oc-port-agent-sdk-smoke-persisted-v1";
const evidencePath = join(packageRoot, "evidence", "live.json");
const evidence = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  accountId,
  workerName,
  sdkVersion: "2.0.26",
  wranglerVersion: "4.149.0",
  deployments: {},
  checks: {},
};
let token = "";
let targetVerified = false;

function redact(value) {
  return token ? value.replaceAll(token, "[REDACTED]") : value;
}

function runWrangler(args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerPath, ...args], {
      cwd: packageRoot,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function safeOutput(result) {
  return redact(`${result.stdout}\n${result.stderr}`).replace(/\u001b\[[0-9;]*m/g, "").trim();
}

async function requiredWrangler(args, stdin = "") {
  const result = await runWrangler(args, stdin);
  if (result.code !== 0) {
    const detail = safeOutput(result).slice(-1200);
    throw new Error(`wrangler ${args[0]} exited ${result.code}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function deploymentShape(value) {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray(value.deployments)
      ? value.deployments
      : [];
  const latest = candidates.at(-1);
  if (!latest || typeof latest !== "object") return undefined;
  const versions = Array.isArray(latest.versions) ? latest.versions : [];
  const active = versions.find((entry) => entry && typeof entry === "object" && entry.percentage === 100)
    ?? versions[0];
  const versionId = active && typeof active === "object" && typeof active.version_id === "string"
    ? active.version_id
    : typeof latest.version_id === "string"
      ? latest.version_id
      : undefined;
  const deploymentId = typeof latest.id === "string" ? latest.id : undefined;
  return { deploymentId, versionId };
}

async function latestDeployment() {
  const result = await requiredWrangler(["deployments", "list", "--name", workerName, "--json"]);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Wrangler returned an unreadable deployment listing");
  }
  const deployment = deploymentShape(parsed);
  if (!deployment?.versionId) throw new Error("Wrangler deployment listing did not include an active version ID");
  return deployment;
}

async function api(path, method, authorization) {
  const response = await fetch(`${evidence.url}${path}`, {
    method,
    headers: authorization ? { authorization: `Bearer ${authorization}` } : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJsonResponse: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

async function waitForHealth(expectedVersionId) {
  let last;
  for (let attempt = 0; attempt < 15; attempt++) {
    last = await api("/health", "GET");
    if (last.status === 200 && last.body.versionId === expectedVersionId) {
      return { ...last, attempts: attempt + 1 };
    }
    if (attempt < 14) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { ...last, attempts: 15 };
}

async function apiWithAuthRetry(path, method, authorization) {
  let last;
  for (let attempt = 0; attempt < 15; attempt++) {
    last = await api(path, method, authorization);
    if (last.status !== 401) return { ...last, attempts: attempt + 1 };
    if (attempt < 14) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { ...last, attempts: 15 };
}

function assertSmokeRead(result, label) {
  assert.equal(result.status, 200, `${label} returned HTTP ${result.status}`);
  assert.equal(typeof result.body.bootId, "string");
  assert.equal(typeof result.body.workerVersion?.id, "string");
  assert.equal(typeof result.body.serverInfo?.version, "string");
  assert.equal(result.body.session?.id, "ses_oc_port_agent_sdk_smoke_phase6");
  assert.equal(result.body.session?.getId, result.body.session?.id);
  assert.equal(result.body.checkpoint?.key, "phase6_checkpoint");
  assert.equal(result.body.checkpoint?.value, checkpointValue);
}

async function saveEvidence() {
  evidence.finishedAt = new Date().toISOString();
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  token = randomBytes(32).toString("base64url");

  const existing = await runWrangler(["deployments", "list", "--name", workerName, "--json"]);
  if (existing.code === 0) {
    if (!process.argv.includes("--resume")) {
      throw new Error("target Worker already has deployments; refusing to overwrite it (use --resume only for this recorded smoke Worker)");
    }

    let previous;
    try {
      previous = JSON.parse(await readFile(evidencePath, "utf8"));
    } catch {
      throw new Error("--resume requires the prior package-generated live evidence; refusing to overwrite an unverified Worker");
    }
    const current = deploymentShape(JSON.parse(existing.stdout.trim()));
    const previouslyRecorded = Object.values(previous.deployments ?? {}).some((deployment) =>
      deployment && deployment.deploymentId === current?.deploymentId,
    );
    if (previous.workerName !== workerName || previous.accountId !== accountId
      || !["not found via Wrangler deployments list", "matched this package's recorded smoke deployment"]
        .includes(previous.checks?.preexistingWorker)
      || !previouslyRecorded || typeof previous.url !== "string") {
      throw new Error("current deployment does not match this package's recorded smoke Worker; refusing to overwrite it");
    }
    targetVerified = true;
    Object.assign(evidence.deployments, previous.deployments);
    evidence.initialTargetCheck = previous.initialTargetCheck
      ?? "Wrangler reported the target Worker not found before its first deployment";
    if (previous.priorSuccessfulPersistenceObservation) {
      evidence.priorSuccessfulPersistenceObservation = previous.priorSuccessfulPersistenceObservation;
    }
    evidence.url = previous.url;
    evidence.resume = true;
    evidence.checks.preexistingWorker = "matched this package's recorded smoke deployment";
    evidence.deployments.preResume = current;
    await requiredWrangler(["deploy"]);
    evidence.deployments.resumeCodeDeploy = await latestDeployment();
    await requiredWrangler(["secret", "put", "SMOKE_TOKEN", "--name", workerName], `${token}\n`);
    evidence.deployments.resumedSecretUpload = await latestDeployment();
  } else {
    if (!/not found|could not find|does not exist|no such worker|10007/i.test(safeOutput(existing))) {
      throw new Error("could not verify that the target Worker is unused; refusing to deploy");
    }
    targetVerified = true;
    evidence.initialTargetCheck = "Wrangler deployments list reported the target Worker not found";
    evidence.checks.preexistingWorker = "not found via Wrangler deployments list";

    const firstDeploy = await requiredWrangler(
      ["deploy", "--secrets-file", "/dev/stdin"],
      `${JSON.stringify({ SMOKE_TOKEN: token })}\n`,
    );
    const url = safeOutput(firstDeploy).match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
    if (!url) throw new Error("Wrangler deploy succeeded but did not report a workers.dev URL");
    evidence.url = url;
    evidence.deployments.initial = await latestDeployment();
  }

  const activeVersionId = evidence.deployments.resumedSecretUpload?.versionId
    ?? evidence.deployments.initial.versionId;
  const health = await waitForHealth(activeVersionId);
  assert.equal(health.status, 200, "health endpoint did not return HTTP 200");
  assert.deepEqual(health.body, { status: "ok", versionId: activeVersionId });
  evidence.checks.health = { status: health.status, attempts: health.attempts, body: health.body };

  // Verify that the public surface does not allow a fixed test mutation.
  const unauthorized = await api("/smoke/write", "POST");
  assert.equal(unauthorized.status, 401, "unauthenticated write endpoint was not rejected");
  evidence.checks.unauthorized = { status: unauthorized.status };

  const write = await apiWithAuthRetry("/smoke/write", "POST", token);
  assertSmokeRead(write, "authenticated SDK write/read");
  assert.equal(typeof write.body.sessionCreated, "boolean");
  if (!evidence.resume) assert.equal(write.body.sessionCreated, true, "the fixed SDK session was not created by the smoke test");
  assert.equal(write.body.checkpointWritten, true);
  evidence.checks.authenticatedWrite = {
    status: write.status,
    serverVersion: write.body.serverInfo.version,
    bootId: write.body.bootId,
    workerVersion: write.body.workerVersion,
    sessionId: write.body.session.id,
    sdkSessionGetId: write.body.session.getId,
    sessionCreated: write.body.sessionCreated,
    sessionCreatedThisRequest: typeof write.body.sessionCreatedThisRequest === "boolean"
      ? write.body.sessionCreatedThisRequest
      : null,
    sessionRetrieved: write.body.session.getId === write.body.session.id,
    checkpoint: write.body.checkpoint,
    checkpointWritten: write.body.checkpointWritten,
  };

  await requiredWrangler(["deploy"]);
  evidence.deployments.redeploy = await latestDeployment();
  const redeployHealth = await waitForHealth(evidence.deployments.redeploy.versionId);
  assert.equal(redeployHealth.status, 200, "health endpoint did not recover after redeploy");
  evidence.checks.healthAfterRedeploy = { status: redeployHealth.status, attempts: redeployHealth.attempts };

  // Allow the remote DO to hibernate/evict before reading its retained state.
  // Cloudflare's lifecycle may keep an in-memory instance alive for up to
  // 140 seconds when it is not hibernateable.
  evidence.checks.idleWaitSeconds = 150;
  await new Promise((resolve) => setTimeout(resolve, 150_000));

  const read = await apiWithAuthRetry("/smoke/read", "GET", token);
  assertSmokeRead(read, "post-redeploy persistence read");
  assert.equal(read.body.session.id, write.body.session.id, "SDK session ID changed across redeploy");
  assert.equal(read.body.checkpoint.value, write.body.checkpoint.value, "app checkpoint changed across redeploy");
  evidence.checks.redeployRead = {
    status: read.status,
    serverVersion: read.body.serverInfo.version,
    bootId: read.body.bootId,
    workerVersion: read.body.workerVersion,
    sessionId: read.body.session.id,
    sdkSessionGetId: read.body.session.getId,
    checkpoint: read.body.checkpoint,
  };
  evidence.persistenceAcrossRedeploy = {
    sdkSessionIdUnchanged: read.body.session.id === write.body.session.id,
    appCheckpointUnchanged: read.body.checkpoint.value === write.body.checkpoint.value,
    workerVersionChanged: read.body.workerVersion.id !== write.body.workerVersion.id,
    doBootIdChanged: read.body.bootId !== write.body.bootId,
  };
  if (evidence.persistenceAcrossRedeploy.doBootIdChanged
    && evidence.persistenceAcrossRedeploy.workerVersionChanged) {
    evidence.priorSuccessfulPersistenceObservation = {
      testedAt: evidence.startedAt,
      write: {
        bootId: write.body.bootId,
        workerVersionId: write.body.workerVersion.id,
        sessionId: write.body.session.id,
        checkpointValue: write.body.checkpoint.value,
      },
      postRedeployRead: {
        bootId: read.body.bootId,
        workerVersionId: read.body.workerVersion.id,
        sessionId: read.body.session.id,
        checkpointValue: read.body.checkpoint.value,
      },
      sdkSessionIdUnchanged: evidence.persistenceAcrossRedeploy.sdkSessionIdUnchanged,
      appCheckpointUnchanged: evidence.persistenceAcrossRedeploy.appCheckpointUnchanged,
      workerVersionChanged: true,
      doBootIdChanged: true,
    };
  }
  await saveEvidence();

  console.log(JSON.stringify({
    outcome: "passed",
    url: evidence.url,
    deployments: evidence.deployments,
    healthStatus: health.status,
    unauthorizedStatus: unauthorized.status,
    sdkVersion: evidence.sdkVersion,
    sessionId: read.body.session.id,
    checkpointValue: read.body.checkpoint.value,
    persistenceAcrossRedeploy: evidence.persistenceAcrossRedeploy,
    evidencePath: "apps/cloudflare-smoke/evidence/live.json",
  }, null, 2));
}

main().catch(async (error) => {
  evidence.failure = error instanceof Error ? redact(error.message).slice(0, 1600) : "unknown failure";
  if (targetVerified) {
    try {
      await saveEvidence();
    } catch {
      // Preserve the primary failure if writing evidence is unavailable.
    }
  }
  console.error(evidence.failure);
  process.exitCode = 1;
}).finally(() => {
  token = "";
});
