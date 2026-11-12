# dsh-always-on

A DeepSeek Harness plugin for harnesses running in a container with no access to your local file system: download buttons instead of "Show file location", a "Show files" shortcut, and an in-sidebar Monaco file editor, all through the browser.

## Development

```bash
npm run build     # tsc for server + client bundles into dist/
npm run check     # typecheck both, no emit
npm run lint      # biome check
npm run test      # node --test on test/*.test.ts
```

The client bundle is injected into the DSH web app; see `README.md` for how the CDN and `dsh.bundle.patch` wiring work.

## Agent skills

These repo conventions are read by the Matt Pocock engineering skills (`/triage`, `/to-spec`, `/to-tickets`, `/wayfinder`, `/grill-with-docs`, `/domain-modeling`). The skills themselves are a local-only install and are gitignored; these config files are repo content.

### Issue tracker

Issues and specs live as GitHub issues on `louisremi/dsh-always-on`; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped onto this repo's existing labels (`ready-for-human` → `needs-human`), kept separate from the maintainer agent's `agent-*` workflow labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
