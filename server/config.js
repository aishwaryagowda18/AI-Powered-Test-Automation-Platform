import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int(process.env.PORT, 4000),
  dbPath: process.env.DB_PATH
    ? path.resolve(ROOT_DIR, process.env.DB_PATH)
    : path.join(ROOT_DIR, 'data', 'testforge.db'),
  clientDist: path.join(ROOT_DIR, 'client', 'dist'),
  seedDemoRuns: int(process.env.SEED_DEMO_RUNS, 4),
  // Base URL used in notification links (e.g. https://testforge.example.com).
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  ai: resolveAI(process.env),
};

/**
 * Pick the AI provider. AI_PROVIDER=gemini|claude|none forces a choice;
 * otherwise ("auto") Gemini is used when GEMINI_API_KEY is set, then Claude
 * when ANTHROPIC_API_KEY is set, else the heuristic engine only.
 */
function resolveAI(env) {
  const geminiKey = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim();
  const claudeKey = (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const requested = (env.AI_PROVIDER || 'auto').toLowerCase();
  let provider = null;
  if (requested === 'gemini') provider = geminiKey ? 'gemini' : null;
  else if (requested === 'claude') provider = claudeKey ? 'claude' : null;
  else if (requested === 'auto') provider = geminiKey ? 'gemini' : claudeKey ? 'claude' : null;
  return {
    provider,
    enabled: Boolean(provider),
    gemini: {
      apiKey: geminiKey,
      model: env.GEMINI_MODEL || 'gemini-3.5-flash',
      fallbackModels: (env.GEMINI_FALLBACK_MODELS ?? 'gemini-flash-lite-latest')
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
      baseUrl: env.GEMINI_BASE_URL,
    },
    claude: {
      // The Anthropic SDK reads ANTHROPIC_API_KEY itself.
      model: env.CLAUDE_MODEL || env.AI_MODEL || 'claude-opus-5-5',
      effort: env.AI_EFFORT || 'medium',
      fallbacks: (env.AI_FALLBACKS || 'default').toLowerCase() !== 'off',
    },
  };
}
