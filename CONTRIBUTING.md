# Contributing to TestForge AI

Thanks for helping out! Here's how to get productive quickly.

## Setup

```bash
npm install
npm run dev     # API on :4000, UI on :5173
npm test        # must pass before you open a PR
```

Requires Node.js 22.13+ (Node 24 recommended).

## Guidelines

- **Keep it dependency-light.** The server uses only Express and the Anthropic SDK, with `node:sqlite`, `node:test`, `fetch` and worker threads from the standard library. Discuss new runtime dependencies in an issue first.
- **Tests:** add or extend a `test/*.test.js` file for any behaviour change. API-level tests boot the real app against a temp database (see `test/api.test.js`).
- **UI:** reuse the design tokens in `client/src/styles.css` (purple/pink brand, glass cards, pill buttons). Status must always show an icon + label, never color alone. Check both light and dark themes and a 390px-wide viewport.
- **AI analysis:** new failure categories go in `server/ai/categories.js`, so the heuristic engine, the Claude schema and the UI stay in sync.
- **Commits:** small and focused, with an imperative subject line ("Add webhook notifications").

## Reporting bugs

Open an issue with steps to reproduce, the expected and actual behaviour, and your Node version. For failing test runs, attach the JSON report (`Report → JSON`) with any secrets removed.
