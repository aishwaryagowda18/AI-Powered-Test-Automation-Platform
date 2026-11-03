import { CATEGORIES } from './categories.js';
import {
  FAILURE_SCHEMA,
  FAILURE_SYSTEM,
  FIX_SCHEMA,
  FIX_SYSTEM,
  GENERATION_SCHEMA,
  GENERATION_SYSTEM,
  RUN_SCHEMA,
  RUN_SYSTEM,
  failurePrompt,
  fixPrompt,
  generationPrompt,
  runPrompt,
} from './prompts.js';
import { ClaudeProvider } from './providers/claude.js';
import { AIError } from './providers/errors.js';
import { GeminiProvider } from './providers/gemini.js';

/**
 * The AI tasks the platform needs, implemented once on top of any provider
 * that offers `structured({ system, prompt, schema })`.
 */
export class AIClient {
  constructor(provider) {
    this.provider = provider;
  }

  get name() {
    return this.provider.name;
  }

  get label() {
    return this.provider.label;
  }

  get model() {
    return this.provider.model;
  }

  async analyzeFailure(ctx) {
    const { data, model, usage } = await this.provider.structured({ system: FAILURE_SYSTEM, prompt: failurePrompt(ctx), schema: FAILURE_SCHEMA });
    return {
      ...data,
      categoryLabel: CATEGORIES[data.category] ?? data.category,
      source: this.name,
      model,
      tokens: usage,
      analyzedAt: new Date().toISOString(),
    };
  }

  async summarizeRun(ctx) {
    const { data, model } = await this.provider.structured({ system: RUN_SYSTEM, prompt: runPrompt(ctx), schema: RUN_SCHEMA });
    return { ...data, source: this.name, model, analyzedAt: new Date().toISOString() };
  }

  async generateTests(params) {
    const { data, model } = await this.provider.structured({
      system: GENERATION_SYSTEM,
      prompt: generationPrompt(params),
      schema: GENERATION_SCHEMA,
      maxTokens: 32000,
      stream: true,
    });
    return { ...data, model };
  }

  async proposeFix(ctx) {
    const { data, model } = await this.provider.structured({ system: FIX_SYSTEM, prompt: fixPrompt(ctx), schema: FIX_SCHEMA });
    return { ...data, model };
  }
}

/** Build the configured client, or null when no provider is configured. */
export function createAIClient(aiConfig) {
  if (!aiConfig?.enabled || !aiConfig.provider) return null;
  if (aiConfig.provider === 'gemini') return new AIClient(new GeminiProvider(aiConfig.gemini));
  if (aiConfig.provider === 'claude') return new AIClient(new ClaudeProvider(aiConfig.claude));
  throw new AIError(`Unknown AI provider "${aiConfig.provider}"`);
}

export function describeAIError(err) {
  return err instanceof AIError ? err.message : (err?.message ?? String(err));
}
