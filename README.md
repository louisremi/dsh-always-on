# @louisremi/dsh-docker-adapter

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adapts the web UI for running the Harness inside a Docker container.

When the Harness runs on a NAS, a server or in Docker, "show file location" has no file manager to open on your machine. This plugin replaces those buttons with **Download file** buttons that save the file through your browser instead.

## Install

```sh
dsh plugin --profile web add @louisremi/dsh-docker-adapter
```

Use the name of the profile your Harness runs with. The plugin loads live; restart the Harness only if the command says a restart is required.

## Usage

Nothing to configure. The download button (with a download icon) appears wherever the folder button used to be:

- file cards under an agent reply (`present`) and in the changed-files review tab
- the toolbar of a file open in the sidebar preview
- the empty state of a file the preview can't render

The workspace folder's "Open in app" button (session header, and the sidebar Files tab) gets a **Show files** default that opens the sidebar file explorer. Editors the Harness can launch, such as Cursor, stay in its dropdown. Inside the Files tab itself, where "Show files" would do nothing, only the editor shortcut remains.

## How it works

The plugin adds an authenticated `GET /api/download.file` route to the Harness and registers its buttons in the same UI slots as the stock ones, shadowing them. "Show files" calls the sidebar's public `openTab('files')`. Downloads stream straight to disk by the browser, so large files are fine. Files are served under the same access rules as the Harness's own file preview.

## Limitations

- Single files only; folders are not downloadable.
- Editors in the dropdown still launch on the Harness host, so they only work if that host has a display.
- Tested with DSH `0.2.0-rc.2`. It depends on the stock `open-in-app` plugin's slot names.

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
