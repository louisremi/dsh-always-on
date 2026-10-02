# dsh-download-files

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that replaces the **Show file location** buttons with **Download file** buttons.

When the Harness runs on a NAS, a server or in Docker, "show file location" has no file manager to open on your machine. With this plugin the button downloads the file through your browser instead.

## Install

```sh
dsh plugin --profile web add dsh-download-files
```

Use the name of the profile your Harness runs with. The plugin loads live; restart the Harness only if the command says a restart is required.

## Usage

Nothing to configure. The download button (with a download icon) appears wherever the folder button used to be:

- file cards under an agent reply (`present`) and in the changed-files review tab
- the toolbar of a file open in the sidebar preview
- the empty state of a file the preview can't render

## How it works

The plugin adds an authenticated `GET /api/download.file` route to the Harness and registers its buttons in the same UI slots as the stock ones, shadowing them. Downloads stream straight to disk by the browser, so large files are fine. Files are served under the same access rules as the Harness's own file preview.

## Limitations

- Single files only; folders are not downloadable.
- The "Open in…" button for the workspace folder is not changed.
- Tested with DSH `0.1.7-rc.2`. It depends on the stock `open-in-app` plugin's slot names.

## Uninstall

```sh
dsh plugin --profile web remove dsh-download-files
```

## Releasing

Bump `version` in `package.json` (`npm version patch`), push, then publish a GitHub Release whose tag matches (`gh release create vX.Y.Z --generate-notes`). A workflow **stages** the package on npm (no 2FA needed in CI); it needs a stage-only `NPM_TOKEN` repository secret.

The maintainer then publishes the staged version with proof-of-presence:

```sh
npm stage list dsh-download-files
npm stage approve <stage-id>
```

## License

MIT
