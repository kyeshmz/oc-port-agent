import { spawn } from 'node:child_process';

export interface CommandResult { code: number; stdout: string; stderr: string; durationMs: number }
export interface RawCommandResult extends Omit<CommandResult, 'stdout'> { stdout: Buffer }
export async function runBytes(command: string, args: string[], cwd: string, timeoutSeconds = 120, env = process.env): Promise<RawCommandResult> {
  const start = Date.now();
  return new Promise(resolve => {
    const childEnv = { ...env };
    // Some CLIs use PWD instead of process.cwd(); don't leak the caller's location.
    childEnv.PWD = cwd;
    // Do not make a nested `node --test` silently inherit the parent's internal runner mode.
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(command, args, { cwd, env: childEnv, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let problem = '';
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') problem += `\n${(error as Error).message}`; }
    };
    const stop = (message: string): void => {
      if (problem) return;
      problem = message;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 1000);
      escalation.unref();
    };
    const timer = setTimeout(() => stop(`Command timed out after ${timeoutSeconds}s`), timeoutSeconds * 1000);
    const collect = (destination: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) stop('Command output exceeded 16 MiB; result is incomplete');
      else destination.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', error => { problem = error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      resolve({ code: problem ? 1 : (code ?? 1), stdout: Buffer.concat(stdout), stderr: `${Buffer.concat(stderr).toString('utf8')}${problem || signal ? `\n${problem || `Terminated by ${signal}`}` : ''}`, durationMs: Date.now() - start });
    });
  });
}
export async function run(command: string, args: string[], cwd: string, timeoutSeconds = 120, env = process.env): Promise<CommandResult> {
  const result = await runBytes(command, args, cwd, timeoutSeconds, env);
  return { ...result, stdout: result.stdout.toString('utf8') };
}
export async function mustRun(command: string, args: string[], cwd: string, timeoutSeconds = 120): Promise<string> {
  const result = await run(command, args, cwd, timeoutSeconds);
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
export const git = (root: string, args: string[]) => mustRun('git', args, root);
