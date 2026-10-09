import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';

export interface PrivateServer { url: string; password: string; close: () => Promise<void> }

// Never touches the user's managed/shared OpenCode service or its configuration.
export async function startPrivateServer(executable: string, root: string, env: NodeJS.ProcessEnv, timeoutSeconds = 120): Promise<PrivateServer> {
  const port = await new Promise<number>((resolve, reject) => {
    const listener = createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') { listener.close(); reject(new Error('Cannot allocate private OpenCode port')); return; }
      listener.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  let password = randomBytes(32).toString('base64url');
  const serverEnv = { ...env, PWD: root, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' };
  const child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env: serverEnv, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let exited = false;
  let exitDescription = '';
  let resolveExit: () => void = () => {};
  const completed = new Promise<void>(resolve => { resolveExit = resolve; });
  const append = (chunk: Buffer): void => {
    log = (log + chunk.toString('utf8')).slice(-16000);
    // Some V2 builds choose and announce their own private-server credential.
    const announced = /server password ([^\s]+)/.exec(log);
    if (announced) password = announced[1]!;
  };
  const redactedLog = (): string => log.replace(/server password [^\s]+/g, 'server password [redacted]');
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', error => { exitDescription = error.message; });
  child.on('close', (code, signal) => { exited = true; exitDescription ||= `exit ${code}, signal ${signal}`; resolveExit(); });
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const close = async (): Promise<void> => {
    if (exited) return;
    kill('SIGTERM');
    await Promise.race([completed, delay(1500)]);
    if (!exited) { kill('SIGKILL'); await completed; }
  };
  const url = `http://127.0.0.1:${port}`;
  const query = new URLSearchParams({ 'location[directory]': root });
  let lastProblem = '';
  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`Private OpenCode server stopped (${exitDescription}). ${redactedLog()}`);
      try {
        const response = await fetch(`${url}/api/agent?${query}`, { headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` }, signal: AbortSignal.timeout(2000) });
        if (!response.ok) throw new Error(`Agent discovery returned HTTP ${response.status}`);
        const data = await response.json() as { data?: { id: string }[] };
        // V2 registration is asynchronous. An HTTP-ready server can initially list no agents.
        if (data.data?.some(agent => agent.id === 'oc-port-agent')) return { url, password, close };
        lastProblem = 'oc-port-agent has not registered yet';
      } catch (error) { lastProblem = (error as Error).message; }
      await delay(250);
    }
    throw new Error(`Private OpenCode initialization timed out: ${lastProblem}. ${redactedLog()}`);
  } catch (error) { await close(); throw error; }
}
