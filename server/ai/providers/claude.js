import Anthropic from '@anthropic-ai/sdk';
import { AIError, parseJsonOutput } from './errors.js';

/** Anthropic Claude via the official SDK, with JSON-schema structured output. */
export class ClaudeProvider {
  name = 'claude';
  label = 'Claude';

  constructor({ model, effort, fallbacks }) {
    this.model = model;
    this.effort = effort;
    this.fallbacks = fallbacks;
    this.client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
  }

  /** `stream` is used for long outputs (test generation) to avoid HTTP timeouts. */
  async structured({ system, prompt, schema, maxTokens = 16000, stream = false }) {
    const params = {
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: this.effort, format: { type: 'json_schema', schema } },
    };
    if (this.fallbacks) {
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    let response;
    try {
      response = stream ? await this.client.beta.messages.stream(params).finalMessage() : await this.client.beta.messages.create(params);
    } catch (err) {
      throw toAIError(err);
    }
    if (response.stop_reason === 'refusal') {
      const detail = response.stop_details?.explanation;
      throw new AIError(`Claude declined this input${detail ? `: ${detail}` : ''}`);
    }
    if (response.stop_reason === 'max_tokens') throw new AIError('Claude response was truncated (max_tokens). Try a smaller input.');
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const usage = response.usage ?? {};
    return { data: parseJsonOutput(text, 'Claude'), model: response.model, usage: { input: usage.input_tokens, output: usage.output_tokens } };
  }
}

/** Map SDK errors to user-facing messages using the SDK's typed error classes. */
function toAIError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new AIError('Claude rejected the API key (401). Check ANTHROPIC_API_KEY.', { status: 401 });
  if (err instanceof Anthropic.PermissionDeniedError) return new AIError('This API key lacks permission for the configured Claude model (403).', { status: 403 });
  if (err instanceof Anthropic.NotFoundError) return new AIError('The configured Claude model was not found (404). Check CLAUDE_MODEL.', { status: 404 });
  if (err instanceof Anthropic.RateLimitError) return new AIError('Claude rate limit reached (429). Try again shortly.', { status: 429 });
  if (err instanceof Anthropic.BadRequestError) return new AIError(`Claude rejected the request (400): ${err.message}`, { status: 400 });
  if (err instanceof Anthropic.APIConnectionError) return new AIError('Could not connect to the Claude API. Check network/proxy settings.');
  if (err instanceof Anthropic.APIError) return new AIError(`Claude API error${err.status ? ` ${err.status}` : ''}: ${err.message}`, { status: err.status });
  return err;
}
