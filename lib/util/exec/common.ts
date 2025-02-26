import { ChildProcess, spawn } from 'child_process';
import { ExecError, ExecErrorData } from './exec-error';
import type { ExecResult, RawExecOptions } from './types';

// https://man7.org/linux/man-pages/man7/signal.7.html#NAME
// Non TERM/CORE signals
// The following is step 3. in https://github.com/renovatebot/renovate/issues/16197#issuecomment-1171423890
const NONTERM = [
  'SIGCHLD',
  'SIGCLD',
  'SIGCONT',
  'SIGSTOP',
  'SIGTSTP',
  'SIGTTIN',
  'SIGTTOU',
  'SIGURG',
  'SIGWINCH',
];

const encoding = 'utf8';

function stringify(list: Buffer[]): string {
  return Buffer.concat(list).toString(encoding);
}

function initStreamListeners(
  cp: ChildProcess,
  opts: RawExecOptions & { maxBuffer: number }
): [Buffer[], Buffer[]] {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;

  cp.stdout?.on('data', (chunk: Buffer) => {
    // process.stdout.write(data.toString());
    const len = Buffer.byteLength(chunk, encoding);
    stdoutLen += len;
    if (stdoutLen > opts.maxBuffer) {
      cp.emit('error', new Error('stdout maxBuffer exceeded'));
    } else {
      stdout.push(chunk);
    }
  });

  cp.stderr?.on('data', (chunk: Buffer) => {
    // process.stderr.write(data.toString());
    const len = Buffer.byteLength(chunk, encoding);
    stderrLen += len;
    if (stderrLen > opts.maxBuffer) {
      cp.emit('error', new Error('stderr maxBuffer exceeded'));
    } else {
      stderr.push(chunk);
    }
  });
  return [stdout, stderr];
}

export function exec(cmd: string, opts: RawExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024; // Set default max buffer size to 10MB
    const cp = spawn(cmd, {
      ...opts,
      // force detached on non WIN platforms
      // https://github.com/nodejs/node/issues/21825#issuecomment-611328888
      detached: process.platform !== 'win32',
      shell: typeof opts.shell === 'string' ? opts.shell : true, // force shell
    });

    // handle streams
    const [stdout, stderr] = initStreamListeners(cp, {
      ...opts,
      maxBuffer,
    });

    // handle process events
    cp.on('error', (error) => {
      kill(cp, 'SIGTERM');
      reject(new ExecError(error.message, rejectInfo(), error));
    });

    cp.on('exit', (code: number, signal: NodeJS.Signals) => {
      if (NONTERM.includes(signal)) {
        return;
      }

      if (signal) {
        const message = `Process signaled with "${signal}"`;
        kill(cp, signal);
        reject(new ExecError(message, { ...rejectInfo(), signal }));
        return;
      }
      if (code !== 0) {
        const message = `Process exited with exit code "${code}"`;
        reject(new ExecError(message, { ...rejectInfo(), exitCode: code }));
        return;
      }
      resolve({
        stderr: stringify(stderr),
        stdout: stringify(stdout),
      });
    });

    function rejectInfo(): ExecErrorData {
      return {
        cmd: cp.spawnargs.join(' '),
        options: opts,
        stdout: stringify(stdout),
        stderr: stringify(stderr),
      };
    }
  });
}

function kill(cp: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    // TODO: will be enabled in #16654
    /**
     * If `pid` is negative, but not `-1`, signal shall be sent to all processes
     * (excluding an unspecified set of system processes),
     * whose process group ID (pgid) is equal to the absolute value of pid,
     * and for which the process has permission to send a signal.
     */
    // process.kill(-(cp.pid as number), signal);

    // destroying stdio is needed for unref to work
    // https://nodejs.org/api/child_process.html#subprocessunref
    // https://github.com/nodejs/node/blob/4d5ff25a813fd18939c9f76b17e36291e3ea15c3/lib/child_process.js#L412-L426
    cp.stderr?.destroy();
    cp.stdout?.destroy();
    cp.unref();
    return cp.kill(signal);
  } catch (err) {
    // cp is a single node tree, therefore -pid is invalid as there is no such pgid,
    // istanbul ignore next: will be covered once we use process.kill
    return false;
  }
}

// TODO: rename #16653
export const rawExec: (
  cmd: string,
  opts: RawExecOptions
) => Promise<ExecResult> = exec; // TODO: rename #16653
