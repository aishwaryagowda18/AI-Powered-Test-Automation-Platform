/** A provider failure with a user-facing message and retry hints. */
export class AIError extends Error {
  /**
   * @param {string} message  shown to users as-is
   * @param {object} [opts]
   * @param {number} [opts.status]        HTTP status, if any
   * @param {boolean} [opts.retryable]    worth retrying the same model
   * @param {boolean} [opts.tryNextModel] worth falling back to another model
   * @param {number} [opts.retryAfterMs]  server-suggested wait
   */
  constructor(message, { status, retryable = false, tryNextModel = false, retryAfterMs } = {}) {
    super(message);
    this.name = 'AIError';
    this.status = status;
    this.retryable = retryable;
    this.tryNextModel = tryNextModel;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse model output that should be JSON, tolerating a ```json fence. */
export function parseJsonOutput(text, providerLabel) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AIError(`${providerLabel} returned output that was not valid JSON`, { retryable: true });
  }
}
