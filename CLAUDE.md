# Finora: rules for AI coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. The rule that matters most:

**Whatever you change, the user's existing bank and card connections must survive it.**

- Never run the real app (`server/index.js` or `electron/main.mjs` without `--dev`). Your tools may
  run inside a sandbox (the Claude desktop app is an MSIX package) that writes `%LOCALAPPDATA%` to a
  private copy; the user's next launch then finds an empty folder and every connection looks gone.
  The app refuses to start there; ask the user to open it from the Start menu instead.
- Tests and experiments use `--dev` with demo data or a lab `FINORA_DATA_DIR`, never the real folder.
- A change that touches the data folder, the key, the database format or the bank profiles needs a
  migration that keeps old data readable, plus a test with an existing folder (`server/test/safety.test.js`).
- Never delete or overwrite a user's data files. Set things aside instead, and say so.
- `npm test` must pass.
