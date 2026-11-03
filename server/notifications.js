/**
 * Sends run results to Slack, Microsoft Teams, or any JSON webhook when a run
 * finishes. If the run has failures and auto-analysis is on, delivery waits
 * (bounded) for the AI run summary so the message can say *why* it failed.
 */
const SUMMARY_WAIT_MS = 90_000;
const SEND_TIMEOUT_MS = 10_000;

const pct = (run) => {
  const executed = run.passed + run.failed + run.errored;
  return executed ? Math.round((run.passed / executed) * 1000) / 10 : 0;
};
const PROVIDERS = { gemini: 'Gemini', claude: 'Claude' };
const providerLabel = (source) => (source === 'heuristic' ? 'AI' : (PROVIDERS[source] ?? 'AI'));
const seconds = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);

export function shouldNotify(channel, run) {
  if (!channel.enabled) return false;
  if (channel.scope === 'scheduled' && run.trigger !== 'schedule') return false;
  if (channel.notifyOn === 'failures' && run.status !== 'failed') return false;
  return true;
}

/** Build the platform-specific request body. Exported for tests. */
export function buildPayload(type, { run, failures, link, isTest = false }) {
  const ok = run.status === 'passed';
  const icon = isTest ? '🔔' : ok ? '✅' : run.status === 'cancelled' ? '⏹️' : '❌';
  const title = isTest ? 'TestForge AI test notification' : `${icon} ${run.name}: ${run.status.toUpperCase()}`;
  const stats = `${run.passed}/${run.total} passed · ${run.failed} failed · ${run.errored} errors · ${pct(run)}% pass rate · ${seconds(run.durationMs)}`;
  const summary = run.aiSummary;
  const failureLines = failures.slice(0, 6).map((f) => `• ${f.displayName ?? f.testName}${f.analysis?.categoryLabel ? ` (${f.analysis.categoryLabel})` : ''}: ${f.analysis?.summary ?? f.errorMessage ?? ''}`);
  if (failures.length > 6) failureLines.push(`…and ${failures.length - 6} more`);
  const ai = summary && !ok ? `${providerLabel(summary.source)} summary: ${summary.headline}${summary.riskLevel ? ` (release risk: ${summary.riskLevel})` : ''}` : null;
  const text = isTest ? 'Notifications from TestForge AI are configured correctly.' : [stats, ai, ...failureLines].filter(Boolean).join('\n');

  if (type === 'slack') {
    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: isTest ? text : `*${stats}*${run.environmentName ? `\nEnvironment: ${run.environmentName}` : ''}` } },
    ];
    if (ai) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:sparkles: *${ai}*${summary.recommendations?.[0] ? `\nNext step: ${summary.recommendations[0]}` : ''}` } });
    if (failureLines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: failureLines.join('\n').slice(0, 2900) } });
    if (link) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open run' }, url: link }] });
    return { text: `${title}\n${text}`, blocks };
  }

  if (type === 'teams') {
    const body = [
      { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: title, wrap: true },
      { type: 'TextBlock', text: isTest ? text : stats, wrap: true, spacing: 'Small' },
    ];
    if (run.environmentName && !isTest) body.push({ type: 'TextBlock', text: `Environment: ${run.environmentName}`, isSubtle: true, wrap: true, spacing: 'None' });
    if (ai) body.push({ type: 'TextBlock', text: ai, weight: 'Bolder', wrap: true });
    if (failureLines.length) body.push({ type: 'TextBlock', text: failureLines.join('\n\n'), wrap: true });
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body,
            actions: link ? [{ type: 'Action.OpenUrl', title: 'Open run', url: link }] : [],
          },
        },
      ],
    };
  }

  return {
    event: isTest ? 'test' : 'run.finished',
    run: {
      id: run.id,
      name: run.name,
      status: run.status,
      trigger: run.trigger,
      environment: run.environmentName,
      total: run.total,
      passed: run.passed,
      failed: run.failed,
      errored: run.errored,
      skipped: run.skipped,
      flaky: run.flaky,
      passRate: pct(run),
      durationMs: run.durationMs,
      finishedAt: run.finishedAt,
    },
    summary: summary ?? null,
    failures: failures.map((f) => ({ test: f.displayName ?? f.testName, status: f.status, error: f.errorMessage, category: f.analysis?.category ?? null, diagnosis: f.analysis?.summary ?? null })),
    url: link,
  };
}

export class Notifier {
  constructor({ store, bus, publicUrl }) {
    this.store = store;
    this.bus = bus;
    this.publicUrl = publicUrl;
    bus.on('event', (e) => {
      if (e.type === 'run:finished') this.#onRunFinished(e.data).catch((err) => console.error('[notify]', err.message));
    });
  }

  async #onRunFinished(run) {
    const channels = this.store.listChannels().filter((c) => shouldNotify(c, run));
    if (!channels.length) return;
    if (run.failed + run.errored > 0 && this.store.getSettings().autoAnalyze && !this.store.getRun(run.id)?.aiSummary) {
      await this.#waitForSummary(run.id);
    }
    const fresh = this.store.getRun(run.id);
    if (!fresh) return;
    await Promise.all(channels.map((c) => this.send(c, fresh)));
  }

  #waitForSummary(runId) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.bus.off('event', onEvent);
        resolve();
      };
      const onEvent = (e) => e.type === 'run-analysis:updated' && e.data.runId === runId && done();
      const timer = setTimeout(done, SUMMARY_WAIT_MS);
      this.bus.on('event', onEvent);
    });
  }

  async send(channel, run, { isTest = false } = {}) {
    const failures = isTest ? [] : this.store.listResults(run.id).filter((r) => r.status === 'failed' || r.status === 'error');
    const base = this.publicUrl();
    const link = isTest || !base ? (base || null) : `${base}/runs/${run.id}`;
    const payload = buildPayload(channel.type, { run, failures, link, isTest });
    let ok = false;
    let error = null;
    try {
      const res = await fetch(channel.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'TestForge-AI' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      ok = res.ok;
      if (!ok) error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch (err) {
      error = err.name === 'TimeoutError' ? 'Timed out after 10s' : (err.cause?.code ?? err.message);
    }
    this.store.recordDelivery(channel.id, { ok, error });
    this.bus.publish('channel:updated', this.store.getChannel(channel.id));
    return { ok, error };
  }

  sendTest(channel) {
    const sample = { id: 0, name: 'Test notification', status: 'passed', trigger: 'manual', total: 0, passed: 0, failed: 0, errored: 0, skipped: 0, flaky: 0, durationMs: 0 };
    return this.send(channel, sample, { isTest: true });
  }
}
