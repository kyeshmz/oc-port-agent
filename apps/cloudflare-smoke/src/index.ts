import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";

const DO_NAME = "phase6-single-retained-smoke";
const SESSION_ID = "ses_oc_port_agent_sdk_smoke_phase6";
const SESSION_STATE_KEY = "sdk_session_id";
const SESSION_CREATED_KEY = "sdk_session_created";
const CHECKPOINT_KEY = "phase6_checkpoint";
const CHECKPOINT_VALUE = "oc-port-agent-sdk-smoke-persisted-v1";

type SmokeReadResult = {
  bootId: string;
  workerVersion: { id: string; timestamp: string };
  serverInfo: { version: string };
  session: { id: string; getId: string };
  checkpoint: { key: string; value: string };
};

export class OpenCodeSmokeDO extends DurableObject<Env> {
  private readonly bootId = crypto.randomUUID();
  private readonly host: Promise<OpenCodeWorkerd.Interface>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.host = ctx.blockConcurrencyWhile(async () => {
      const host = await OpenCodeWorkerd.create({
        storage: ctx.storage,
        config: {
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
          websearch: false,
          mcp: { servers: {} },
        },
        models: { fetch: false, snapshot: false },
        plugins: [],
      });

      // OpenCode initializes its SQLite schema in the storage above. App-owned
      // tables are created only afterward to preserve the SDK migration rule.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS smoke_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) WITHOUT ROWID
      `);
      return host;
    });
  }

  async writeSmoke(): Promise<SmokeReadResult & {
    sessionCreated: boolean;
    sessionCreatedThisRequest: boolean;
    checkpointWritten: boolean;
  }> {
    const host = await this.host;
    const existing = this.readState(SESSION_STATE_KEY);
    let sessionCreatedThisRequest = false;

    if (existing !== undefined && existing !== SESSION_ID) {
      throw new Error("unexpected retained session id");
    }

    if (existing === undefined) {
      try {
        await host.session.create({ id: SESSION_ID, title: "OpenCode Cloudflare SDK persistence smoke" });
        sessionCreatedThisRequest = true;
      } catch {
        // Recover the one fixed session if a previous invocation stopped after
        // the SDK commit but before the app-owned pointer was saved.
        await host.session.get({ sessionID: SESSION_ID });
      }
      this.writeState(SESSION_STATE_KEY, SESSION_ID);
    }
    this.writeState(SESSION_CREATED_KEY, "true");

    this.writeState(CHECKPOINT_KEY, CHECKPOINT_VALUE);
    const result = await this.readSmokeWithHost(host);

    return {
      ...result,
      sessionCreated: this.readState(SESSION_CREATED_KEY) === "true",
      sessionCreatedThisRequest,
      checkpointWritten: true,
    };
  }

  async readSmoke(): Promise<SmokeReadResult> {
    return this.readSmokeWithHost(await this.host);
  }

  private async readSmokeWithHost(host: OpenCodeWorkerd.Interface): Promise<SmokeReadResult> {
    const sessionID = this.readState(SESSION_STATE_KEY);
    if (sessionID !== SESSION_ID) throw new Error("retained SDK session is missing");

    const [server, session] = await Promise.all([
      host.server.info(),
      host.session.get({ sessionID }),
    ]);
    if (session.id !== sessionID) throw new Error("SDK session read-back mismatch");

    const value = this.readState(CHECKPOINT_KEY);
    if (value !== CHECKPOINT_VALUE) throw new Error("app checkpoint is missing or invalid");

    return {
      bootId: this.bootId,
      workerVersion: {
        id: this.env.VERSION_METADATA.id,
        timestamp: this.env.VERSION_METADATA.timestamp,
      },
      serverInfo: { version: server.version },
      session: { id: sessionID, getId: session.id },
      checkpoint: { key: CHECKPOINT_KEY, value },
    };
  }

  private readState(key: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM smoke_state WHERE key = ?", key)
      .toArray();
    return rows[0]?.value;
  }

  private writeState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO smoke_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }
}

async function authorized(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(suppliedHash);
  const right = new Uint8Array(expectedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", versionId: env.VERSION_METADATA.id });
    }

    const operation = url.pathname === "/smoke/write" && request.method === "POST"
      ? "write"
      : url.pathname === "/smoke/read" && request.method === "GET"
        ? "read"
        : undefined;
    if (!operation) return jsonError("not found", 404);
    if (!(await authorized(request, env.SMOKE_TOKEN))) return jsonError("unauthorized", 401);
    if (operation === "write" && Number(request.headers.get("content-length") ?? "0") > 0) {
      return jsonError("request body is not accepted", 400);
    }

    try {
      const stub = env.SDK_SMOKE.getByName(DO_NAME);
      const result = operation === "write" ? await stub.writeSmoke() : await stub.readSmoke();
      return Response.json(result);
    } catch (error) {
      console.error(JSON.stringify({
        message: "OpenCode SDK smoke operation failed",
        path: url.pathname,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      return jsonError("smoke operation failed", 500);
    }
  },
} satisfies ExportedHandler<Env>;
