import { isDeepStrictEqual } from 'node:util';
import { createAIClient, describeAIError } from './client.js';
import { proposeFixRuleBased } from './fixer.js';
import { GenerationError, draftsFromAI, testFromCurl, testsFromOpenApi } from './generator.js';
import { analyzeHeuristically, summarizeRunHeuristically } from './heuristics.js';

/**
 * Chooses between the AI provider (Gemini or Claude) and the heuristic engine, persists analyses, and
 * publishes updates. Every path degrades to the heuristic result, so analysis
 * never blocks on (or fails because of) the AI provider.
 */
export class Analyzer {
  constructor({ store, bus, aiConfig }) {
    this.store = store;
    this.bus = bus;
    this.aiConfig = aiConfig;
    this.ai = null;
    this.lastError = null;
    try {
      this.ai = createAIClient(aiConfig);
    } catch (err) {
      this.lastError = describeAIError(err);
    }
  }

  status() {
    const ai = this.ai;
    return {
      provider: ai ? ai.name : 'heuristic',
      providerLabel: ai ? ai.label : 'Heuristic engine',
      enabled: Boolean(ai),
      model: ai ? ai.model : null,
      fallbackModels: ai?.name === 'gemini' ? ai.provider.fallbackModels : [],
      effort: ai?.name === 'claude' ? ai.provider.effort : null,
      lastError: this.lastError,
    };
  }

  #context(result) {
    const testCase = result.testCaseId ? this.store.getTest(result.testCaseId) : null;
    // For data-driven tests, compare against the same row only, so one consistently bad row isn't read as flakiness.
    const row = result.iteration?.index ?? null;
    const history = result.testCaseId ? this.store.getTestHistory(result.testCaseId, 60).filter((h) => (h.iteration?.index ?? null) === row).slice(0, 15) : [];
    return { result, testCase, history };
  }

  /** Analyze one failed result. `useAI` falls back to heuristics when the AI provider is off or errors. */
  async analyzeResult(resultId, { useAI = true } = {}) {
    const result = this.store.getResult(resultId);
    if (!result) return null;
    if (result.status !== 'failed' && result.status !== 'error') {
      throw Object.assign(new Error('Only failed or errored results can be analyzed'), { status: 400 });
    }
    const ctx = this.#context(result);
    let analysis = analyzeHeuristically(ctx);

    if (useAI && this.ai) {
      try {
        analysis = await this.ai.analyzeFailure(ctx);
        this.lastError = null;
      } catch (err) {
        this.lastError = describeAIError(err);
        analysis = { ...analysis, aiError: this.lastError };
      }
    }

    const updated = this.store.updateResult(resultId, { analysis });
    this.bus.publish('analysis:updated', { resultId, runId: result.runId, analysis });
    return updated;
  }

  async summarizeRun(runId, { useAI = true } = {}) {
    const run = this.store.getRun(runId);
    if (!run) return null;
    let results = this.store.listResults(runId);
    // Make sure every failure has at least a heuristic diagnosis to summarize.
    for (const r of results) {
      if ((r.status === 'failed' || r.status === 'error') && !r.analysis) {
        this.store.updateResult(r.id, { analysis: analyzeHeuristically(this.#context(r)) });
      }
    }
    results = this.store.listResults(runId);

    let summary = summarizeRunHeuristically({ run, results });
    const hasFailures = run.failed + run.errored > 0;
    if (useAI && this.ai && hasFailures) {
      try {
        summary = await this.ai.summarizeRun({ run, results });
        this.lastError = null;
      } catch (err) {
        this.lastError = describeAIError(err);
        summary = { ...summary, aiError: this.lastError };
      }
    }
    const updated = this.store.updateRun(runId, { aiSummary: summary });
    this.bus.publish('run-analysis:updated', { runId, aiSummary: summary });
    return updated;
  }

  /**
   * Propose a fix for a failed result's test. The AI provider when available (and for
   * script tests), otherwise the rule-based fixer. Returns the proposal plus the
   * current definition so the client can diff and apply against `baseUpdatedAt`.
   */
  async proposeFix(resultId, { useAI = true } = {}) {
    const result = this.store.getResult(resultId);
    if (!result) return null;
    if (result.status !== 'failed' && result.status !== 'error') {
      throw Object.assign(new Error('Only failed or errored results can be fixed'), { status: 400 });
    }
    const test = result.testCaseId ? this.store.getTest(result.testCaseId) : null;
    if (!test) throw Object.assign(new Error('The test for this result was deleted'), { status: 404 });

    const row = result.iteration?.index ?? null;
    const previousPass = this.store
      .getTestHistory(test.id, 60)
      .find((h) => h.status === 'passed' && h.id < result.id && (h.iteration?.index ?? null) === row) ?? null;
    const ctx = { test, result, previousPass };

    let proposal;
    let source = 'rules';
    let model;
    let aiError;
    if (useAI && this.ai) {
      try {
        const out = await this.ai.proposeFix(ctx);
        proposal = { ...out, changes: [] };
        source = this.ai.name;
        model = out.model;
        this.lastError = null;
      } catch (err) {
        this.lastError = describeAIError(err);
        aiError = this.lastError;
      }
    }
    proposal ??= proposeFixRuleBased(ctx);

    const after =
      test.type === 'http'
        ? { ...test.config, assertions: proposal.assertions?.length ? proposal.assertions.map((a) => ({ ...a, target: a.target ?? '', expected: a.expected ?? '' })) : test.config.assertions }
        : { ...test.config, code: proposal.code || test.config.code };
    const changed = !isDeepStrictEqual(after, test.config);

    return {
      resultId,
      testId: test.id,
      testName: test.name,
      testType: test.type,
      baseUpdatedAt: test.updatedAt,
      staleRun: new Date(test.updatedAt) > new Date(result.finishedAt ?? result.startedAt ?? 0),
      source,
      model,
      aiError,
      fixable: Boolean(proposal.fixable && changed),
      summary: proposal.fixable && !changed ? 'No change needed in the test definition.' : proposal.summary,
      rationale: proposal.rationale,
      risk: proposal.risk,
      changes: proposal.changes ?? [],
      before: test.type === 'http' ? { assertions: test.config.assertions ?? [] } : { code: test.config.code },
      after: test.type === 'http' ? { assertions: after.assertions ?? [] } : { code: after.code },
      iteration: result.iteration,
      environmentId: this.store.getRun(result.runId)?.environmentId ?? null,
    };
  }

  /**
   * Generate test drafts. The AI provider is used when available and requested; OpenAPI
   * (JSON) and cURL fall back to the rule-based converters, descriptions need AI.
   */
  async generateTests({ source, input, useAI = true, variables = {} }) {
    if (!['openapi', 'curl', 'description'].includes(source)) throw new GenerationError('source must be openapi, curl or description');
    if (!String(input ?? '').trim()) throw new GenerationError('Paste something to generate tests from.');

    const rules = () => {
      if (source === 'curl') return testFromCurl(input, { baseUrl: variables.baseUrl });
      let spec;
      try {
        spec = JSON.parse(input);
      } catch {
        throw new GenerationError(
          this.ai ? 'Could not parse the spec as JSON. Switch on AI generation to use YAML.' : 'Could not parse the spec as JSON. YAML specs need an AI provider (set GEMINI_API_KEY), or convert the spec to JSON.',
        );
      }
      return testsFromOpenApi(spec);
    };

    if (source === 'description' && !this.ai) {
      throw new GenerationError('Generating from a plain-English description needs an AI provider. Set GEMINI_API_KEY (or ANTHROPIC_API_KEY), or use an OpenAPI spec or cURL command.');
    }

    if (useAI && this.ai) {
      try {
        const generated = await this.ai.generateTests({ source, input, variables });
        this.lastError = null;
        const warnings = generated.notes ? [generated.notes] : [];
        return { tests: draftsFromAI(generated), warnings, generator: this.ai.name, model: generated.model };
      } catch (err) {
        this.lastError = describeAIError(err);
        if (source === 'description') throw new GenerationError(`${this.ai.label} generation failed: ${this.lastError}`);
        const fallback = rules();
        return { ...fallback, warnings: [`${this.ai.label} unavailable (${this.lastError}). Used the rule-based converter instead.`, ...fallback.warnings], generator: 'rules' };
      }
    }
    return { ...rules(), generator: 'rules' };
  }

  /**
   * Post-run pass: instant heuristic analysis for every failure, then the AI provider
   * for up to `aiLimit` of them, then a run summary.
   */
  async autoAnalyzeRun(runId, { aiLimit = 5 } = {}) {
    const failures = this.store.listResults(runId).filter((r) => r.status === 'failed' || r.status === 'error');
    for (const r of failures) {
      const analysis = analyzeHeuristically(this.#context(r));
      this.store.updateResult(r.id, { analysis });
      this.bus.publish('analysis:updated', { resultId: r.id, runId, analysis });
    }
    if (this.ai && aiLimit > 0) {
      for (const r of failures.slice(0, aiLimit)) await this.analyzeResult(r.id, { useAI: true });
    }
    await this.summarizeRun(runId, { useAI: Boolean(this.ai) && aiLimit > 0 });
  }
}
