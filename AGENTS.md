# dsh-always-on

A DeepSeek Harness plugin for harnesses running in a container with no access to your local file system: download buttons instead of "Show file location", a "Show files" shortcut, New file / New folder / Rename / Delete (with restore) / Download as .zip for files and folders, and an in-sidebar Monaco file editor, all through the browser.

## Development

The source is TypeScript. `npm run build` compiles `src/` to `dist/`; the tests run `.ts` files through Node's native type stripping. Developing and running both need Node ≥ 24.9, the same as DSH (`engines.node` in package.json follows DSH's).

```sh
npm ci
npm run check      # typecheck src, tests and e2e (no emit)
npm run build      # compile src/ to dist/
npm run lint       # biome check
npm test           # host route unit tests (no browser needed)
npm run test:e2e   # opt-in: real headless Chromium + real Monaco from the CDN
```

Changes land on `main` as pull requests, so each GitHub Release can describe itself — see **Releasing** in `README.md`. The client bundle is injected into the DSH web app; `README.md` explains the CDN and `cordis.patch.yml` wiring.

## Agent skills

These repo conventions are read by the Matt Pocock engineering skills (`/triage`, `/to-spec`, `/to-tickets`, `/wayfinder`, `/grill-with-docs`, `/domain-modeling`). The skills themselves are installed outside this repo (in the Harness's user skill root, shared by every workspace); these config files are repo content.

### Issue tracker

Issues and specs live as GitHub issues on `louisremi/dsh-always-on`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped onto this repo's existing labels (`ready-for-human` → `needs-human`), kept separate from the maintainer agent's `agent-*` workflow labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
