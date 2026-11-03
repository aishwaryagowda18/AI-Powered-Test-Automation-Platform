import { Worker } from 'node:worker_threads';
import { maskValue } from './http-runner.js';

const WORKER_URL = new URL('./script-worker.js', import.meta.url);

/**
 * Run a script test in its own worker thread. The worker is terminated when the
 * test times out or the run is cancelled, so a stuck script can't hang a run.
 */
export function runScriptTest(testCase, { vars, signal, log, timeoutMs }) {
  const code = testCase.config?.code ?? '';
  if (!code.trim()) return Promise.reject(new Error('Script test has no code'));

  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { code, vars, timeoutMs } });
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      fn(value);
    };

    const timer = setTimeout(() => {
      log('error', `Script timed out after ${timeoutMs} ms`);
      finish(reject, new Error(`Script timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    const onAbort = () => finish(reject, Object.assign(new Error('Run cancelled'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });

    const extracted = {};
    worker.on('message', (msg) => {
      if (msg.type === 'log') log(msg.level, msg.message);
      else if (msg.type === 'var') {
        extracted[msg.name] = msg.value;
        log('info', `Captured {{${msg.name}}} = ${maskValue(msg.value)}`);
      } else if (msg.type === 'done') {
        finish(resolve, {
          status: msg.status,
          assertions: msg.assertions,
          errorMessage: msg.errorMessage ?? null,
          errorStack: msg.errorStack ?? null,
          request: null,
          response: null,
          extracted,
        });
      }
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => {
      if (!settled) finish(reject, new Error(`Script worker exited unexpectedly (code ${code})`));
    });
  });
}
