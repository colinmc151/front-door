# Code Review: Front Door (project + website)

Reviewed: server.js, worksome-client.js, github-client.js, github-scoring.js, worksome-scoring.js, slack-bot/bot-handler.js, public/index.html, public/why.html — June 10, 2026.

## Summary
Solid, well-organized prototype with thoughtful touches (rate limiting, GraphQL injection guard on account IDs, session TTLs, graceful fallbacks). But the API authentication is currently decorative, debug endpoints expose live PII, and there are a few correctness bugs. Fine for a sandbox demo; **not safe to deploy publicly as-is**.

## Critical Issues

| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | server.js | 50–52 | `/api/bootstrap` returns the API key to **anyone, unauthenticated**. The portal fetches it on load, which means every visitor (or script) gets the key and full API access. The auth middleware protects nothing. | 🔴 Critical |
| 2 | server.js | 480–707 | Four "temporary" debug endpoints (`/introspect`, `/debug-notes`, `/debug-types`, `/debug-mutations`) expose the full Worksome GraphQL schema **and live worker PII** (names, emails, day rates, totalPaid). Combined with #1, these are effectively public. Remove before any deployment. | 🔴 Critical |
| 3 | server.js | 680–688 | GraphQL injection: `req.query.type` and `req.query.filter` are interpolated raw into queries (`__type(name: "${req.query.type}")`). You guard account IDs in worksome-client.js but not here. | 🔴 Critical |
| 4 | server.js | 311–343, 415–477 | Given #1, anyone can call `/api/handoff/worksome` and `/api/worksome/invite` with arbitrary payloads → unauthenticated job creation and worker invites in your Worksome account