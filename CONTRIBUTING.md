# Contributing to Finora

Thanks for your interest in improving Finora.

## Before you start
- For a bug, open an issue with the steps to reproduce it, what you expected, and what happened.
  **Never paste real account numbers, logins, amounts or screenshots of real data.** Use the demo data.
- For a new feature, open an issue first so we can agree on the direction.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Working on the code
1. Fork the repository and clone it.
2. `npm ci` (install with `npm ci` only; `.npmrc` enforces exact versions).
3. `npm start` runs the app in developer mode with demo data.
4. `npm test` must pass before you open a pull request. Add a test for any bug you fix.

## Ground rules
- **Every change keeps the user's existing connections.** An upgrade, rename, refactor or reinstall
  must open the same data folder with the same key, databases and bank profiles, and the connections
  must still sync afterwards. Never delete, move or re-create files in the data folder without a
  migration and a test that proves an existing folder survives it (see `server/safety.js` and
  `server/test/safety.test.js`). The data key labels (`MoneyCash/v1` and friends) are frozen.
- Never start the real app (without `--dev`) from an AI coding tool or any other sandbox: it can
  write the data where the user's own launch never looks, and the connections seem to vanish. The
  app refuses to start there; use `npm start -- --dev` with demo data.
- Finora is read-only towards the banks. Changes that perform actions on an account will not be accepted.
- Nothing may leave the user's computer except the sync with the banks and card companies themselves.
- Never log credentials, IDs or full account numbers; `server/errors.js` scrubs them, keep it that way.
- The interface is Hebrew-first and right-to-left. Keep new screens readable in light and dark themes.

By contributing you agree that your contribution is licensed under the GNU GPL v3, like the rest of the project.
