# Repository Guidelines

- **Quality Gate:** Run `npm run check` (`node --check bin/atc.mjs && node --test test/*.test.mjs`) before pushing or merging any changes.
- **Zero Runtime Dependencies:** Keep all code in `bin/` and `src/` pure Node.js (>= 20 ESM) using only built-in `node:*` modules.
- **Strict Lock Boundary:** Never spawn external subprocesses (`android`, `adb`, `ps`, etc.) while holding `atc.lock`.
