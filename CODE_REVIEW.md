# Code Review: Front Door (hiring intake orchestrator + website)

## Summary
A well-structured Node/Express + React app: server orchestrates a Gemini-driven intake chat, routes to Worksome or a VMS, and discovers talent across the Worksome GraphQL API and GitHub. Code quality is generally good — parameterised GraphQL, timeouts, graceful fallbacks, account-ID validation, session TTLs. The headline problem is the API-key auth model, which is self-defeating, plus several debug endpoints and an in-browser Babel build that shouldn't ship to production. The website (`why.html`) is clean; `index.html` is solid but heavy.

## Critical Issues

| # | File | Line | Issue | Severity |
|---|------|------|-------|----------|
| 1 | server.js | 50–65 | ✅ **FIXED** — `/api/bootstrap` removed. The API key never leaves the server; the portal now authenticates via a short-lived (8h) HMAC-signed HttpOnly `SameSite=Strict` cookie issued when the page is served. Programmatic clients still use `x-api-key` (now timing-safe compared). Note: the portal itself remains public — full protection still needs a login/SSO layer. | 🔴 Critical |
| 2 | server.js | 479–707 | ✅ **FIXED** — All four `/api/worksome/debug-*` + `/introspect` endpoints deleted, along with the now-unused `introspectWorkerFields` and `graphqlRaw` exports in worksome-client.js. Verified: endpoints return 404. | 🔴 Critical |
| 3 | server.js | 233–259, 255–257 / 304, 369 | ✅ **FIXED** — All handlers now log `err.message` server-side and return generic, user-friendly error strings (rate-limit case kept distinguishable for the GitHub panel). | 🟠 High |

## Suggestions

| # | File | Line | Suggestion | Category |
|---|------|------|------------|----------|
| 1 | server.js | 18–19 | ✅ **FIXED** — `app.set("trust proxy", 1)` added; rate limiting and `req.secure` now see the real client behind one proxy hop. | Security/Correctness |
| 2 | server.js | 377, 415–432 | ✅ **FIXED** — `shortlists` now has a 2-hour TTL with 10-minute eviction sweeps, touched on every access (same pattern as Slack sessions). | Performance |
| 3 | index.html | 9 | ✅ **FIXED** — JSX source moved to `src/portal.src.html`; `npm run build` (scripts/build-portal.js) compiles it to `public/app.js` and emits `public/index.html`. No in-browser Babel. Re-run the build after editing the source. | Performance |
| 4 | index.html / why.html | head | ✅ **FIXED** — CSP + `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` set on all responses. CDN dependency removed entirely: React UMD bundles are self-hosted at `public/vendor/` (so SRI is moot) and `script-src 'self'` is enforced. | Security |
| 5 | server.js | 727–736 | ✅ **FIXED** — unused `signingSecret` removed from the socket-mode Slack init. | Maintainability |
| 6 | index.html | 360 | ✅ **FIXED** — parenthesised in both the portal source and bot-handler.js. | Maintainability |
| 7 | server.js / bot-handler.js | 226, 292 | ✅ **FIXED** — renamed to `callGemini`/`callGeminiWithMessages` (Slack bot) and `callAssistant` (portal); comments and log labels updated. | Maintainability |
| 8 | server.js | 50–52 | ✅ **FIXED** — resolved by the session-cookie auth change (Critical #1): the key never reaches the browser. | Security |

## What Looks Good
- GraphQL calls are parameterised with variables, and `safeAccountId()` (worksome-client.js:12) validates the one interpolated value with a strict allowlist regex — injection surface is well controlled.
- `AbortController` timeouts on all outbound fetches (worksome-client.js:44, github-client.js:20); GitHub rate-limit handling is explicit and surfaced cleanly to the UI.
- Session store has TTL eviction and the `set/get/delete` wrappers keep timestamps fresh (bot-handler.js:162–188).
- Graceful degradation throughout — missing tokens return friendly fallbacks rather than 500s; handoff failures don't block the user.
- Scoring engines are explainable and weight-based with sensible normalisation; React rendering is XSS-safe (no `dangerouslySetInnerHTML`, links target trusted GitHub/Worksome URLs).
- `.env`/`.env.*` are correctly gitignored and untracked.
- `why.html` is accessible, responsive, and free of obvious issues.

## Verdict
**All findings resolved** (criticals #1–#3 and suggestions #1–#8). Remaining known limitation: the portal itself is public — anyone who loads the page gets a session cookie. The API key can no longer leak, but truly restricting access requires a login/SSO layer.

**Workflow note:** the portal frontend is now built — edit `src/portal.src.html`, then run `npm run build` to regenerate `public/index.html` + `public/app.js`.
