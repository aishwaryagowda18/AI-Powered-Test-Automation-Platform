import { AIError, parseJsonOutput } from './errors.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 8000;

/** Seconds from a google.rpc.RetryInfo detail ("15s") → ms. */
function retryDelayMs(error) {
  const info = error?.details?.find((d) => String(d['@type']).endsWith('RetryInfo'));
  const seconds = Number.parseFloat(String(info?.retryDelay ?? '').replace(/s$/, ''));
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Google Gemini via the Generative Language REST API (generateContent) with
 * JSON-schema constrained output. Retries transient failures (429/5xx) with
 * backoff, then falls back through `fallbackModels` when a model is
 * overloaded, out of quota or unavailable.
 */
export class GeminiProvider {
  name = 'gemini';
  label = 'Gemini';

  constructor({ apiKey, model, fallbackModels = [], baseUrl, timeoutMs = 120_000, maxRetries = 2, backoffMs = 1000 }) {
    if (!apiKey) throw new AIError('GEMINI_API_KEY is not set');
    this.apiKey = apiKey;
    this.model = model;
    this.fallbackModels = fallbackModels.filter((m) => m && m !== model);
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.backoffMs = backoffMs;
  }

  async structured({ system, prompt, schema, maxTokens = 16384 }) {
    let lastError;
    for (const model of [this.model, ...this.fallbackModels]) {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          return await this.#generate(model, { system, prompt, schema, maxTokens });
        } catch (err) {
          lastError = err;
          if (!(err instanceof AIError)) throw err;
          const wait = err.retryAfterMs ?? this.backoffMs * 3 ** attempt;
          if (!err.retryable || attempt === this.maxRetries || wait > MAX_WAIT_MS) break;
          await sleep(wait);
        }
      }
      if (!lastError?.tryNextModel) break;
    }
    throw lastError;
  }

  async #generate(model, { system, prompt, schema, maxTokens }) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: maxTokens },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? `timed out after ${this.timeoutMs / 1000}s` : (err.cause?.code ?? err.message);
      throw new AIError(`Could not reach the Gemini API (${reason}). Check network/proxy settings.`, { retryable: true, tryNextModel: false });
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw this.#httpError(res.status, data.error, model);

    if (data.promptFeedback?.blockReason) {
      throw new AIError(`Gemini declined this input (${data.promptFeedback.blockReason})`, { status: 200 });
    }
    const candidate = data.candidates?.[0];
    const finish = candidate?.finishReason;
    if (finish === 'MAX_TOKENS') throw new AIError('Gemini response was truncated (output token limit). Try a smaller input.', { tryNextModel: false });
    if (finish && !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(finish)) {
      throw new AIError(`Gemini stopped without an answer (${finish})`, { status: 200 });
    }
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    if (!text) throw new AIError('Gemini returned an empty response', { retryable: true, tryNextModel: true });

    const usage = data.usageMetadata ?? {};
    return {
      data: parseJsonOutput(text, 'Gemini'),
      model: data.modelVersion || model,
      usage: { input: usage.promptTokenCount, output: usage.candidatesTokenCount, thinking: usage.thoughtsTokenCount },
    };
  }

  #httpError(status, error, model) {
    const detail = error?.message ? `: ${error.message.split('\n')[0].slice(0, 220)}` : '';
    switch (true) {
      case status === 400 && error?.status === 'FAILED_PRECONDITION':
        return new AIError(`Gemini is not available for this key or region (400)${detail}`, { status });
      case status === 400:
        return new AIError(`Gemini rejected the request (400)${detail}`, { status });
      case status === 401 || status === 403:
        return new AIError(`Gemini rejected the API key (${status})${detail}. Check GEMINI_API_KEY.`, { status });
      case status === 404:
        return new AIError(`Gemini model "${model}" is not available (404). Check GEMINI_MODEL.`, { status, tryNextModel: true });
      case status === 429:
        return new AIError(`Gemini quota or rate limit reached for "${model}" (429)${detail}`, {
          status,
          retryable: true,
          tryNextModel: true,
          retryAfterMs: retryDelayMs(error),
        });
      case status >= 500:
        return new AIError(`Gemini is temporarily unavailable for "${model}" (${status})${detail}`, { status, retryable: true, tryNextModel: true });
      default:
        return new AIError(`Gemini API error ${status}${detail}`, { status });
    }
  }
}
