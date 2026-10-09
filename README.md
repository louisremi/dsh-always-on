# @louisremi/dsh-docker-adapter

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adapts the web UI for running the Harness inside a Docker container.

When the Harness runs on a NAS, a server or in Docker, the stock "show file location" and "Open in app" buttons have no desktop to act on. This plugin replaces them with things that work through your browser:

- **Download file** buttons that save a file to your computer.
- **Show files**, which opens the sidebar file explorer.
- **Edit**, which opens a text file in an in-sidebar code editor ([Monaco](https://microsoft.github.io/monaco-editor/), the editor behind VS Code) and saves it back to the Harness host.

## Install

```sh
dsh plugin --profile web add @louisremi/dsh-docker-adapter
```

Use the name of the profile your Harness runs with. The plugin loads live; restart the Harness only if the command says a restart is required.

Installing from a git URL builds the plugin on install (`prepare` runs `npm run build`). If your profile is managed by pnpm it may block build scripts until you approve them (`allowBuilds`); a skipped build leaves the plugin without its `dist/`.

## Usage

Nothing to configure.

**Download.** The download button appears wherever the folder button used to be: file cards under an agent reply (`present`) and in the changed-files review tab, the toolbar of a file open in the sidebar preview, and the empty state of a file the preview can't render.

**Show files.** The workspace folder button in the session header becomes a single **Show files** button. It opens (or focuses) the sidebar's Files tab. Inside that tab the button is hidden, since it would do nothing.

**Edit.** Open a text file in the sidebar preview and press **Edit** (pencil icon, next to Download). The file opens in its own editor tab:

- `Ctrl/Cmd+S` or the **Save** button writes the file; a dot on the tab and filename marks unsaved changes.
- If the file changed on disk after you opened it, saving is refused and you choose **Reload from disk**, **Overwrite**, or **Keep editing**. Nothing is overwritten silently.
- Closing a tab (or the browser page) with unsaved changes asks for confirmation.
- Line endings (LF/CRLF) and a leading UTF-8 byte-order mark are preserved.
- Text files up to 1 MiB. Binary files and invalid UTF-8 are refused, not corrupted.
- Saving follows the session's sandbox mode: it fails in read-only mode and outside the workspace in workspace-write mode, exactly like the agent's own file tools.

## How it works

The plugin adds two authenticated routes to the Harness, `GET /api/download.file` and `POST /api/save.file`, and registers its buttons in the same UI slots as the stock ones, shadowing them (disable the plugin and the stock buttons return). "Show files" calls the sidebar's public `openTab('files')`; the editor is a sidebar tab type registered through the public sidebar API. Downloads stream straight to disk, so large files are fine. Saves go through the Harness's own filesystem layer with the session's sandbox policy and a version check.

### The editor and the CDN

To keep the package small (~69 kB), Monaco is **not bundled**. On the first Edit it is loaded from [jsDelivr](https://www.jsdelivr.com/) at a pinned version (`monaco-editor@0.52.2`).

- It runs in a **sandboxed iframe** (`sandbox="allow-scripts"`, no `allow-same-origin`) with a Content-Security-Policy that only permits the CDN. The CDN's code therefore cannot read the Harness page, your session cookie, local storage, or call the Harness API; it only exchanges messages with the editor wrapper.
- The loader script is checked with Subresource Integrity (SRI). Files the loader then pulls in are not individually pinned by hash, which is why the isolation above matters.
- **Your browser needs internet access to `cdn.jsdelivr.net`** (the Harness host does not). If it is unreachable or blocked, the editor falls back to a plain `<textarea>` with the same save, conflict and dirty-state behaviour, and says so.
- jsDelivr sees your IP address and user agent when Monaco loads.

## Limitations

- Download: single files only; folders are not downloadable.
- Edit: text files up to 1 MiB; no multi-user locking beyond the on-disk version check.
- Tested with DSH `0.2.0-rc.2`. It depends on the stock `open-in-app` and `sidebar-right` plugins' slot names and public API.

## Development

The source is TypeScript; `npm run build` compiles it to `dist/` (it also runs automatically via `prepare` on install and pack). The tests run `.ts` files directly through Node's native type stripping, so **developing** needs Node ≥ 22.18 (or ≥ 23.6) — the plugin itself still only requires Node ≥ 20 at runtime.

```sh
npm ci
npm run check      # TypeScript typecheck of src, tests and e2e
npm run build      # compile src/ to dist/
npm test           # host route unit tests (no browser needed)
npm run test:e2e   # opt-in: real headless Chromium + real Monaco from the CDN (builds first)
```

`test:e2e` needs Chromium, `playwright-core` and React 18 UMD builds; see the header of `e2e/browser.e2e.mts`.

## Uninstall

```sh
dsh plugin --profile web remove @louisremi/dsh-docker-adapter
```

## Releasing

Bump `version` in `package.json` (`npm version patch`), push, then publish a GitHub Release whose tag matches (`gh release create vX.Y.Z --generate-notes`). A workflow **stages** the package on npm (no 2FA needed in CI); it needs a stage-only `NPM_TOKEN` repository secret.

The maintainer then publishes the staged version with proof-of-presence:

```sh
npm stage list @louisremi/dsh-docker-adapter
npm stage approve <stage-id>
```

## License

MIT
