const PROVIDER_LABELS = { gemini: 'Gemini', claude: 'Claude' };

/** Display name for an analysis/generator source ("gemini" → "Gemini"). */
export const providerName = (source) => PROVIDER_LABELS[source] ?? 'AI';

/** True when a result came from an AI provider rather than the rule-based engines. */
export const isAI = (source) => Boolean(source) && source !== 'heuristic' && source !== 'rules';
