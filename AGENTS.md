# Repository Guidelines

## Project Structure

The repository currently consists of `ExpenseV2.js`, a single-file Cloudflare Worker for a Persian-language finance bot. It handles Telegram webhooks and callbacks, stores records in Notion, and keeps conversational state in Cloudflare D1. There are no separate source, test, or asset directories; keep related changes in this file unless the project grows enough to justify modules.

## Development and Deployment

The Worker is configured in `wrangler.jsonc` and is deployed with Wrangler. After each completed user-requested code change, run `node --check ExpenseV2.js`, commit the change, then deploy the latest committed Worker with `wrangler deploy` from the repository root. Report any deployment failure and its reason. Do not deploy unrelated uncommitted changes; check `git status` first.

Configure the Worker with `TELEGRAM_TOKEN`, `NOTION_TOKEN`, `WEBHOOK_SECRET`, `ALLOWED_USER_ID`, and the Notion database IDs documented at the top of `ExpenseV2.js`. Bind the D1 database as `DB`. For PDF reports, add a Browser Rendering binding named `BROWSER`, or set `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with Browser Rendering Write access. `BOT_API_BASE` is optional. Protect secrets and never commit token values. The `/setup` endpoint requires the webhook secret; `/health` provides a basic availability check.

## Coding Style

Use modern JavaScript and the existing two-space indentation. Preserve the current organization: constants and Notion schemas first, followed by the Worker entry point and grouped helpers. Keep function and variable names descriptive in English, and preserve Persian user-facing text and Notion property names. Money entered and displayed by the bot is in toman; Notion stores rial (10 rial per toman). Maintain that conversion consistently.

## Testing and Validation

There is no checked-in test framework or coverage requirement. For changes, run `node --check ExpenseV2.js` when available, then validate relevant behavior in a configured Worker environment: `/health`, authenticated webhook handling, and affected Telegram/Notion flows. Avoid real financial writes when checking integrations; use safe test data or isolated services.

## Changes and Reviews

Commit every completed user-requested change before handing it back. Use a short, imperative commit subject (for example, `Improve category selection`) and keep each commit focused on the requested change. Do not include secrets, `.dev.vars`, local Wrangler state, or generated output. In review descriptions, summarize behavior changes, configuration needs, and manual checks; include screenshots only when a change affects a visible interface.
