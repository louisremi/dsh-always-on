/**
 * Client half of dsh-always-on, for a Harness running in a container or on a
 * remote host (NAS, Docker, server) with no access to your local file system,
 * where native "open in app" actions cannot work.
 *
 *  - "Download file" replaces the stock "Show file location" buttons.
 *  - "Show files" replaces the stock directory "Open in app" control and
 *    switches to the sidebar file explorer.
 *  - "Edit" opens a file in a sidebar editor tab (Monaco, loaded from a CDN
 *    inside a sandboxed iframe; plain textarea when the CDN is unreachable).
 *  - "New file" / "New folder" in the Files tab toolbar; "Rename or move",
 *    "Delete" (to a trash, with a 10-second Restore toast) and, for folders,
 *    "Download as .zip" in the stock context menu of the Files tree
 *    (DSH >= 0.2.2-rc.1; feature-detected, absent on older Harnesses).
 *
 * This file is a classic script, not a module: dsh serves `exports["./client"]`
 * verbatim to the browser, which registers it through `window.__ModuleLoader__`.
 * It must keep no top-level `import`/`export`; TypeScript only adds types here
 * (see tsconfig: `erasableSyntaxOnly`).
 *
 * The stock "Open in app" / "Show file location" controls are not shadowed
 * here: the bundle patch (cordis.patch.yml) tells the Harness it has no
 * desktop, and the stock controls then render nothing by themselves.
 */

/** The loader dsh's page runtime installs before loading plugin clients. */
interface DlfModuleLoader {
  load(entry: { id: string; factory(require: DlfAmdRequire): unknown }): void;
}

/** The bundle's CommonJS-style require inside the factory; the AMD loader's require inside the iframe. */
interface DlfAmdRequire {
  (specifier: string): any;
  (deps: string[], success?: (installed?: unknown) => void, error?: (error: unknown) => void): void;
  config(options: Record<string, unknown>): void;
}

// This file compiles as a classic script (module: preserve in
// tsconfig.client.json; with no import/export the emit is the plain script
// dsh serves to the browser), so these top-level declarations are global:
// the interface below merges with lib.dom's `Window`, giving
// `window.__ModuleLoader__` its type.
// biome-ignore lint/correctness/noUnusedVariables: declaration merging — nothing here references Window by name
interface Window {
  __ModuleLoader__: DlfModuleLoader;
  /** Set by the sandboxed iframe's own worker bootstrap; `monaco` by the AMD loader there. */
  MonacoEnvironment?: unknown;
  monaco?: any;
}

window.__ModuleLoader__.load({
  id: '@louisremi/dsh-always-on',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'always-on';
    const ROUTE = 'api/download.file';
    const SAVE_ROUTE = 'api/save.file';
    const CREATE_FILE_ROUTE = 'api/create.file';
    const CREATE_FOLDER_ROUTE = 'api/create.folder';
    const RENAME_FILE_ROUTE = 'api/rename.file';
    const DELETE_FILE_ROUTE = 'api/delete.file';
    const RENAME_FOLDER_ROUTE = 'api/rename.folder';
    const DELETE_FOLDER_ROUTE = 'api/delete.folder';
    const RESTORE_ROUTE = 'api/restore.entry';
    const SUMMARY_ROUTE = 'api/folder.summary';
    const DOWNLOAD_FOLDER_ROUTE = 'api/download.folder';
    /** Slot-entry id prefix of every control this plugin registers. */
    const OWN_ID = '@louisremi/dsh-always-on';
    const ERROR_MS = 4000;

    const EDITOR_ID = '@louisremi/dsh-always-on/editor';
    const EDITOR_KIND = 'dlf-editor';
    /** Largest file the editor opens; keep in step with MAX_SAVE_BYTES in src/save-route.ts. */
    const MAX_EDIT_BYTES = 1024 * 1024;
    const FRAME_LOAD_TIMEOUT_MS = 15000;
    const FRAME_REPLY_TIMEOUT_MS = 5000;

    /**
     * Monaco is loaded from this pinned jsDelivr build. 0.52.x is the last
     * line with the classic AMD layout this loader code targets; the loader
     * itself is integrity-checked (SRI). Bump both together.
     */
    const MONACO_VERSION = '0.52.2';
    const MONACO_ORIGIN = 'https://cdn.jsdelivr.net';
    const MONACO_BASE = `${MONACO_ORIGIN}/npm/monaco-editor@${MONACO_VERSION}/min/vs`;
    const MONACO_LOADER_SRI =
      'sha384-pHG02SG8pId94Np3AbPmBEJ1yPqaH0IkJGLSNGXYmuGhkazT8Lr/57WYpbkGjJtu';

    /** Extensions the editor never offers (the editor also refuses binary content itself). */
    const BINARY_EXTENSIONS =
      /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic|pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|exe|dll|so|dylib|bin|class|o|a|wasm|mp3|mp4|m4a|mov|avi|mkv|webm|wav|flac|ogg|woff2?|ttf|otf|eot|sqlite3?|db|pyc|iso|dmg)$/i;

    type Translate = (key: string, params?: Record<string, unknown>) => string;

    const en = {
      'download.title': 'Download file',
      'download.error': 'Could not download the file. Try again.',
      'files.show': 'Show files',
      'edit.title': 'Edit file',
      'editor.save': 'Save',
      'editor.saving': 'Saving…',
      'editor.saved': 'Saved',
      'editor.unsaved': 'Unsaved changes',
      'editor.loading': 'Opening…',
      'editor.plain': 'Plain-text mode (code editor unavailable)',
      'editor.discard': 'Discard unsaved changes to {name}?',
      'editor.conflict': 'This file changed on disk after you opened it.',
      'editor.reload': 'Reload from disk',
      'editor.overwrite': 'Overwrite',
      'editor.keep': 'Keep editing',
      'editor.tooLarge': 'Too large to edit here (limit {limit}).',
      'editor.notText': 'This file is not editable text.',
      'editor.loadError': 'Could not open the file.',
      'editor.saveError': 'Could not save the file.',
      'editor.denied': "Saving is not permitted in this session's sandbox mode.",
      'editor.gone': 'The file no longer exists.',
      'editor.noRoute':
        'Saving is unavailable: the Harness has no save route (restart the Harness to load the updated plugin).',
      'editor.retry': 'Try again',
      'editor.info': '{size} · modified {modified}',
      'create.file': 'New file',
      'create.fileHint': 'Use / to create it in a new folder, e.g. notes/todo.md',
      'create.folder': 'New folder',
      'create.folderHint': 'Use / to create nested folders, e.g. docs/drafts',
      'create.create': 'Create',
      'create.cancel': 'Cancel',
      'create.exists': 'Something with that name already exists here.',
      'create.invalid': 'Enter a name without \\, control characters, or . and .. parts.',
      'create.denied': "This is not permitted in this session's sandbox mode.",
      'create.failed': 'Could not create it. Try again.',
      'rename.title': 'Rename or move',
      'rename.hint': 'Use / to move it into a folder, or type an absolute path.',
      'rename.confirm': 'Rename',
      'rename.missing': 'The file no longer exists.',
      'create.noFolder': 'That folder no longer exists.',
      'mutation.noSession': 'This session no longer exists.',
      'mutation.unmapped': 'Not possible here: this file is not on the Harness host.',
      'rename.folderTitle': 'Rename or move folder',
      'rename.missingFolder': 'That folder no longer exists.',
      'rename.intoItself': 'A folder cannot be moved into itself.',
      'delete.title': 'Delete file',
      'delete.folderTitle': 'Delete folder',
      'delete.question': 'Delete {name}?',
      'delete.folderQuestion': 'Delete the folder {name} and everything in it?',
      'delete.emptyFolderQuestion': 'Delete the empty folder {name}?',
      'delete.folderContents': 'Delete {name} and its {files} files, {folders} folders ({size})?',
      'delete.folderMany': 'Delete {name} and its more than {files} files and {folders} folders?',
      'delete.counting': 'Counting what is inside…',
      'delete.trashNote':
        'It moves to a .tmp/deleted/ folder on the same disk, where it is kept for 30 days.',
      'delete.mounts':
        'Careful: it holds a mounted volume ({mounts}); everything on that volume goes to the trash too.',
      'delete.confirm': 'Delete',
      'delete.trash': 'This is the trash (or holds it); it empties itself after 30 days.',
      'delete.doneFile': 'Deleted {name}',
      'delete.doneFolder': 'Deleted folder {name}',
      'restore.file': 'Restore deleted file',
      'restore.folder': 'Restore deleted folder',
      'restore.done': 'Restored {name}',
      'restore.taken':
        'Cannot restore {name}: something with that name exists again. It is still in .tmp/deleted/.',
      'restore.gone': 'Cannot restore {name}: it is no longer in the trash.',
      'toast.dismiss': 'Dismiss',
      'menu.rename': 'Rename or move…',
      'menu.delete': 'Delete…',
      'menu.downloadZip': 'Download as .zip',
      'menu.downloadFailed': 'Could not download the folder (limit {files} files, {size}).',
      'menu.failed': 'That did not work. Try again.',
      'entry.dirty': 'This file has unsaved edits in the editor. Save or discard them first.',
      'entry.dirtyFolder':
        'A file in this folder has unsaved edits in the editor. Save or discard them first.',
      'entry.noMv': 'Moving folders needs GNU coreutils mv on the Harness host.',
      'entry.crossDevice':
        'Not possible: this is on another filesystem (a mount) than where it would go.',
      'entry.mountPoint': 'This is a mount point, so it cannot be deleted. Unmount it first.',
    };
    const zh = {
      'download.title': '下载文件',
      'download.error': '无法下载文件，请重试',
      'files.show': '显示文件',
      'edit.title': '编辑文件',
      'editor.save': '保存',
      'editor.saving': '正在保存',
      'editor.saved': '已保存',
      'editor.unsaved': '有未保存的修改',
      'editor.loading': '正在打开',
      'editor.plain': '纯文本模式（代码编辑器不可用）',
      'editor.discard': '要放弃对 {name} 的未保存修改吗？',
      'editor.conflict': '打开此文件后，磁盘上的内容已发生变化。',
      'editor.reload': '从磁盘重新加载',
      'editor.overwrite': '覆盖',
      'editor.keep': '继续编辑',
      'editor.tooLarge': '文件过大，无法在此编辑（上限 {limit}）。',
      'editor.notText': '此文件不是可编辑的文本。',
      'editor.loadError': '无法打开文件。',
      'editor.saveError': '无法保存文件。',
      'editor.denied': '当前会话的沙箱模式不允许保存。',
      'editor.gone': '文件已不存在。',
      'editor.noRoute': '无法保存：Harness 没有保存接口（请重启 Harness 以加载更新后的插件）。',
      'editor.retry': '重试',
      'editor.info': '{size} · 修改于 {modified}',
      'create.file': '新建文件',
      'create.fileHint': '可用 / 在新文件夹中创建，例如 notes/todo.md',
      'create.folder': '新建文件夹',
      'create.folderHint': '可用 / 创建多级文件夹，例如 docs/drafts',
      'create.create': '创建',
      'create.cancel': '取消',
      'create.exists': '此处已存在同名项目。',
      'create.invalid': '名称不能包含 \\、控制字符，或 . 和 .. 路径段。',
      'create.denied': '当前会话的沙箱模式不允许此操作。',
      'create.failed': '无法创建，请重试。',
      'rename.title': '重命名或移动',
      'rename.hint': '可用 / 移动到文件夹中，或输入绝对路径。',
      'rename.confirm': '重命名',
      'rename.missing': '文件已不存在。',
      'create.noFolder': '该文件夹已不存在。',
      'mutation.noSession': '此会话已不存在。',
      'mutation.unmapped': '此处无法操作：该文件不在 Harness 主机上。',
      'rename.folderTitle': '重命名或移动文件夹',
      'rename.missingFolder': '该文件夹已不存在。',
      'rename.intoItself': '不能把文件夹移动到它自身之中。',
      'delete.title': '删除文件',
      'delete.folderTitle': '删除文件夹',
      'delete.question': '要删除 {name} 吗？',
      'delete.folderQuestion': '要删除文件夹 {name} 及其全部内容吗？',
      'delete.emptyFolderQuestion': '要删除空文件夹 {name} 吗？',
      'delete.folderContents':
        '要删除 {name} 及其中的 {files} 个文件、{folders} 个文件夹（{size}）吗？',
      'delete.folderMany': '要删除 {name} 及其中超过 {files} 个文件和 {folders} 个文件夹吗？',
      'delete.counting': '正在统计内容…',
      'delete.trashNote': '它会移到同一磁盘上的 .tmp/deleted/ 文件夹，保留 30 天。',
      'delete.mounts': '注意：其中包含一个挂载的卷（{mounts}），该卷上的全部内容也会移到回收站。',
      'delete.confirm': '删除',
      'delete.trash': '这是回收站（或包含回收站），30 天后会自动清空。',
      'delete.doneFile': '已删除 {name}',
      'delete.doneFolder': '已删除文件夹 {name}',
      'restore.file': '恢复已删除的文件',
      'restore.folder': '恢复已删除的文件夹',
      'restore.done': '已恢复 {name}',
      'restore.taken': '无法恢复 {name}：同名项目已再次存在。它仍在 .tmp/deleted/ 中。',
      'restore.gone': '无法恢复 {name}：它已不在回收站中。',
      'toast.dismiss': '关闭',
      'menu.rename': '重命名或移动…',
      'menu.delete': '删除…',
      'menu.downloadZip': '下载为 .zip',
      'menu.downloadFailed': '无法下载该文件夹（上限 {files} 个文件、{size}）。',
      'menu.failed': '操作失败，请重试。',
      'entry.dirty': '此文件在编辑器中有未保存的修改，请先保存或放弃。',
      'entry.dirtyFolder': '此文件夹中有文件在编辑器中有未保存的修改，请先保存或放弃。',
      'entry.noMv': '移动文件夹需要 Harness 主机上有 GNU coreutils mv。',
      'entry.crossDevice': '无法操作：它与目标位置位于不同的文件系统（挂载点）。',
      'entry.mountPoint': '这是一个挂载点，无法删除。请先卸载。',
    };

    // The last rule hides the stock "This Host has no desktop…" note above presented
    // files: in a container that is the normal case, and Download replaces opening.
    const CSS = `
.dlf-split{box-sizing:border-box;display:inline-flex;align-items:stretch;flex:none;align-self:center;height:24px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);font-family:var(--dsw-font-family)}
.dlf-main{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:3px 5px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}
.dlf-main:hover:not(:disabled),.dlf-main:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dlf-main:disabled{cursor:default}
.dlf-split[data-error] .dlf-main{color:var(--dsw-alias-state-error-primary)}
.dlf-split[data-size=large]{height:36px;border-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dlf-split[data-size=large] .dlf-main{gap:6px;padding:6px 14px;font-size:14px}
.dlf-ed{container-type:inline-size;box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px}
.dlf-ed-bar{display:flex;align-items:center;gap:8px;flex:none;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dlf-ed-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.dlf-ed-dot{color:var(--dsw-alias-state-warn-primary)}
.dlf-ed-spacer{flex:1}
.dlf-ed-info{flex:none;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
@container (max-width:420px){.dlf-ed-info{display:none}}
.dlf-ed-status{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dlf-ed-status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dlf-ed-status[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}
.dlf-ed-btn{padding:3px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dlf-ed-btn:hover:not(:disabled),.dlf-ed-btn:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dlf-ed-btn:disabled{opacity:.5;cursor:default}
.dlf-ed-banner{display:flex;align-items:center;flex-wrap:wrap;gap:8px;flex:none;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-warn-primary)}
.dlf-ed-note{flex:none;padding:4px 10px;color:var(--dsw-alias-label-secondary);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dlf-ed-body{position:relative;flex:1;min-height:0}
.dlf-ed-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent}
.dlf-ed-text{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;margin:0;padding:8px 10px;resize:none;border:0;outline:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4;white-space:pre}
.dlf-ed-titleIcon{flex:none}
.dlf-ed-msg{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:16px 12px;color:var(--dsw-alias-label-secondary)}
.dlf-tool{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);line-height:1;cursor:pointer}
.dlf-tool:hover,.dlf-tool:focus-visible{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dlf-dlg-back{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-start;justify-content:center;padding-top:18vh;background:rgba(0,0,0,.28)}
.dlf-dlg{box-sizing:border-box;width:min(420px,calc(100vw - 32px));display:flex;flex-direction:column;gap:10px;padding:16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.dlf-dlg-title{margin:0;font-size:14px;font-weight:600}
.dlf-dlg-where{color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.dlf-dlg-input{box-sizing:border-box;width:100%;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:inherit;font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:0}
.dlf-dlg-input:focus{border-color:var(--dsw-alias-label-secondary)}
.dlf-dlg-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.dlf-dlg-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dlf-dlg-actions{display:flex;justify-content:flex-end;gap:8px}
.dlf-dlg .dlf-ed-btn[data-primary]{background:var(--dsw-alias-interactive-bg-hover)}
.dlf-dlg .dlf-ed-btn[data-danger]{color:var(--dsw-alias-state-error-primary)}
span:has(+[data-presented-files-row]){display:none}
.dlf-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483001;box-sizing:border-box;width:max-content;max-width:min(560px,calc(100vw - 32px));display:flex;align-items:center;gap:12px;padding:8px 8px 8px 14px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-label-primary,#222);color:var(--dsw-alias-bg-base,#fff);font-family:var(--dsw-font-family);font-size:13px;box-shadow:0 8px 28px rgba(0,0,0,.3)}
.dlf-toast[data-tone=error]{background:var(--dsw-alias-state-error-primary,#b42318)}
.dlf-toast-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dlf-toast-btn{flex:none;padding:4px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;font-weight:600;text-decoration:underline;cursor:pointer}
.dlf-toast-btn:hover:not(:disabled),.dlf-toast-btn:focus-visible,.dlf-toast-close:hover,.dlf-toast-close:focus-visible{background:rgba(127,127,127,.25)}
.dlf-toast-btn:disabled{opacity:.6;cursor:default}
.dlf-toast-close{flex:none;width:24px;height:24px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer}
`;

    // ───────────────────────────── icons ─────────────────────────────

    function Svg({ size, children }: { size: number; children?: any }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          strokeWidth: 1,
        },
        children,
      );
    }

    function DownloadIcon({ size }: { size: number }) {
      return h(
        Svg,
        { size },
        h('path', { d: 'M8 1.95317V10.0469', stroke: 'currentColor' }),
        h('path', { d: 'M4.25 6.29688L8 10.0469L11.75 6.29688', stroke: 'currentColor' }),
        h('path', {
          d: 'M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469',
          stroke: 'currentColor',
        }),
      );
    }

    function FilesIcon({ size }: { size: number }) {
      return h(
        Svg,
        { size },
        h('path', {
          d: 'M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6L7.5 4.25H13.5C14.052 4.25 14.5 4.698 14.5 5.25V12.5C14.5 13.052 14.052 13.5 13.5 13.5H2.5C1.948 13.5 1.5 13.052 1.5 12.5V3.5Z',
          stroke: 'currentColor',
        }),
      );
    }

    function EditIcon({ size }: { size: number }) {
      return h(
        Svg,
        { size },
        h('path', { d: 'M10.5 2.5L13.5 5.5L5.5 13.5H2.5V10.5L10.5 2.5Z', stroke: 'currentColor' }),
        h('path', { d: 'M9 4L12 7', stroke: 'currentColor' }),
      );
    }

    function NewFileIcon({ size }: { size: number }) {
      return h(
        Svg,
        { size },
        h('path', {
          d: 'M9 1.5H3.5C2.948 1.5 2.5 1.948 2.5 2.5V13.5C2.5 14.052 2.948 14.5 3.5 14.5H12.5C13.052 14.5 13.5 14.052 13.5 13.5V6L9 1.5Z',
          stroke: 'currentColor',
        }),
        h('path', { d: 'M9 1.5V6H13.5', stroke: 'currentColor' }),
        h('path', { d: 'M8 8.5V12.5M6 10.5H10', stroke: 'currentColor' }),
      );
    }

    function NewFolderIcon({ size }: { size: number }) {
      return h(
        Svg,
        { size },
        h('path', {
          d: 'M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6L7.5 4.25H13.5C14.052 4.25 14.5 4.698 14.5 5.25V12.5C14.5 13.052 14.052 13.5 13.5 13.5H2.5C1.948 13.5 1.5 13.052 1.5 12.5V3.5Z',
          stroke: 'currentColor',
        }),
        h('path', { d: 'M8 6.5V11M5.75 8.75H10.25', stroke: 'currentColor' }),
      );
    }

    function RenameIcon({ size }: { size: number }) {
      return h(
        Svg,
        { size },
        h('path', { d: 'M2 5.5H14M2 10.5H9', stroke: 'currentColor' }),
        h('path', { d: 'M11.5 8.5L14 10.5L11.5 12.5', stroke: 'currentColor' }),
      );
    }

    function DeleteIcon({ size }: { size: number }) {
      return h(
        Svg,
        { size },
        h('path', { d: 'M2.5 4H13.5M6 4V2.5H10V4', stroke: 'currentColor' }),
        h('path', {
          d: 'M3.75 4L4.5 13.5C4.5 13.776 4.724 14 5 14H11C11.276 14 11.5 13.776 11.5 13.5L12.25 4',
          stroke: 'currentColor',
        }),
        h('path', { d: 'M6.75 6.5V11.5M9.25 6.5V11.5', stroke: 'currentColor' }),
      );
    }

    // ─────────────────────────── file addresses ───────────────────────────

    // Sidebar surface the buttons drive: tab switching, resource tabs, close guards.
    interface SidebarRight {
      openTab(tab: string): unknown;
      /** Open tab records of a session (present on the stock controller). */
      tabsIn?(sessionId: string): readonly { id: string; kind: string; contentId: string }[];
      /** Close one tab of a session, running its close handler. */
      closeIn?(sessionId: string, tabId: string): void;
      openResource(address: string, options: { kind?: string }): unknown;
      registerCloseHandler(
        kind: string,
        handler: (sessionId: string, tab: { id: string; title: string }) => void,
      ): unknown;
    }

    // Same grammar as the stock `dsh-resource://file/session/<id>/<path>` address.
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';
    const encodeSegment = (segment: string) => encodeURIComponent(segment).replace(/%3A/gi, ':');

    function sessionFileAddress(sessionId: string, path: string): string {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${normalized.split('/').map(encodeSegment).join('/')}`;
    }

    /** { sessionId, path } of a session file address, or undefined. */
    function parseFileAddress(address: unknown): { sessionId: string; path: string } | undefined {
      try {
        if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX))
          return undefined;
        const end = address.search(/[?#]/);
        const [scope, id, ...segments] = address
          .slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
          .split('/');
        if (scope !== 'session' || !id || segments.length === 0) return undefined;
        return {
          sessionId: decodeURIComponent(id),
          path: segments.map(decodeURIComponent).join('/'),
        };
      } catch {
        return undefined;
      }
    }

    const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

    // ───────────────────────── download buttons ─────────────────────────

    /** Trigger a browser download of `url` without buffering it in JS memory. */
    function startDownload(url: string) {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    /**
     * Check the route answers before handing the URL to the browser, so a
     * failure is shown on the button instead of as a failed download.
     */
    async function preflight(url: string): Promise<boolean> {
      try {
        return (await fetch(url, { method: 'HEAD' })).ok;
      } catch {
        return false;
      }
    }

    function DownloadButton({ url, large, t }: { url: string; large?: boolean; t: Translate }) {
      const [state, setState] = React.useState('idle');
      const timer = React.useRef(undefined);
      React.useEffect(
        () => () => {
          clearTimeout(timer.current);
        },
        [],
      );
      const label = state === 'error' ? t('download.error') : t('download.title');
      const onClick = async () => {
        if (state === 'busy') return;
        clearTimeout(timer.current);
        setState('busy');
        if (await preflight(url)) {
          startDownload(url);
          setState('idle');
          return;
        }
        setState('error');
        timer.current = setTimeout(() => {
          setState('idle');
        }, ERROR_MS);
      };
      const size = large ? 18 : 13;
      return h(
        'div',
        {
          className: 'dlf-split',
          'data-size': large ? 'large' : 'compact',
          'data-download-file': '',
          'data-error': state === 'error' ? '' : undefined,
        },
        h(
          'button',
          {
            type: 'button',
            className: 'dlf-main',
            disabled: state === 'busy',
            title: label,
            'aria-label': large ? undefined : label,
            role: state === 'error' ? 'alert' : undefined,
            onClick,
          },
          h(DownloadIcon, { size }),
          large && h('span', null, label),
        ),
      );
    }

    /**
     * Directory-level replacement for the stock "Open in app" control: one
     * button that opens the sidebar file explorer through the sidebar's public
     * `openTab('files')`, which works without a desktop on the Harness host.
     */
    function ShowFiles({ sidebarRight, t }: { sidebarRight: SidebarRight; t: Translate }) {
      const label = t('files.show');
      return h(
        'div',
        { className: 'dlf-split', 'data-size': 'compact', 'data-show-files': '' },
        h(
          'button',
          {
            type: 'button',
            className: 'dlf-main',
            title: label,
            'aria-label': label,
            onClick: () => {
              try {
                sidebarRight.openTab('files');
              } catch (error) {
                console.warn('show files rejected:', error);
              }
            },
          },
          h(FilesIcon, { size: 13 }),
        ),
      );
    }

    /** Opens a previewed file in the sidebar editor tab. */
    function EditButton({
      sessionId,
      absolutePath,
      sidebarRight,
      t,
    }: {
      sessionId?: unknown;
      absolutePath?: unknown;
      sidebarRight: SidebarRight;
      t: Translate;
    }) {
      if (
        typeof sessionId !== 'string' ||
        typeof absolutePath !== 'string' ||
        BINARY_EXTENSIONS.test(absolutePath)
      )
        return null;
      const label = t('edit.title');
      return h(
        'div',
        { className: 'dlf-split', 'data-size': 'compact', 'data-edit-file': '' },
        h(
          'button',
          {
            type: 'button',
            className: 'dlf-main',
            title: label,
            'aria-label': label,
            onClick: () => {
              try {
                sidebarRight.openResource(sessionFileAddress(sessionId, absolutePath), {
                  kind: EDITOR_KIND,
                });
              } catch (error) {
                console.warn('edit file rejected:', error);
              }
            },
          },
          h(EditIcon, { size: 13 }),
        ),
      );
    }

    /** Download URL for a stock `api/present.open|changes.open?…` action URL. */
    function routeUrl(actionUrl: unknown): string | undefined {
      if (typeof actionUrl !== 'string') return undefined;
      const from = new URL(actionUrl, document.baseURI);
      const source = from.pathname.endsWith('/changes.open')
        ? 'changes'
        : from.pathname.endsWith('/present.open')
          ? 'present'
          : undefined;
      if (source === undefined) return undefined;
      const to = new URL(ROUTE, document.baseURI);
      to.searchParams.set('source', source);
      for (const key of ['sessionId', 'seq', 'index']) {
        const value = from.searchParams.get(key);
        if (value !== null) to.searchParams.set(key, value);
      }
      return to.href;
    }

    function pathUrl(absolutePath: string): string {
      const to = new URL(ROUTE, document.baseURI);
      to.searchParams.set('path', absolutePath);
      return to.href;
    }

    // ───────────────────────── dialogs & mutations ─────────────────────────

    /** Same rule as the Host's nameSegments() in src/paths.ts. */
    function validName(name: string): boolean {
      if (name.length === 0 || name.length > 1024) return false;
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
      if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
      return name
        .split('/')
        .every((s) => s.length > 0 && s !== '.' && s !== '..' && s.trim() === s);
    }

    /**
     * Message key for a failed mutation response. A 404 means a missing session
     * (the Host says so in `error`), else the folder a create targets or the
     * file a rename/delete acts on.
     */
    function mutationErrorKey(
      response: { status: number; body: any },
      target: 'folder' | 'file',
    ): string {
      const { status, body } = response;
      if (status === 409) return 'create.exists';
      if (status === 404) {
        if (body?.error === 'session not found') return 'mutation.noSession';
        return target === 'folder' ? 'create.noFolder' : 'rename.missing';
      }
      if (status === 422) return 'mutation.unmapped';
      if (status === 400) return 'create.invalid';
      if (status === 403) return 'create.denied';
      return 'create.failed';
    }

    /** POST a JSON body to one of the plugin's routes; returns the status and parsed body. */
    async function postJson(
      route: string,
      body: unknown,
    ): Promise<{ status: number; ok: boolean; body: any }> {
      const response = await fetch(new URL(route, document.baseURI).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const parsed = await response.json().catch(() => ({}));
      return { status: response.status, ok: response.ok, body: parsed };
    }

    let ReactDOM: any;
    try {
      ReactDOM = require('react-dom');
    } catch {
      /* rendered inline instead of in a portal */
    }

    /**
     * A small modal asking for a name (or just a confirmation when `initial`
     * is undefined). `submit` returns an error message key to keep the dialog
     * open with that message, or undefined to close it.
     */
    function NameDialog({
      title,
      where,
      hint,
      initial,
      confirm,
      danger,
      t,
      submit,
      onClose,
    }: {
      title: string;
      where?: string | undefined;
      hint?: string | undefined;
      initial?: string | undefined;
      confirm: string;
      danger?: boolean;
      t: Translate;
      submit: (name: string) => Promise<string | undefined>;
      onClose: () => void;
    }) {
      const [value, setValue] = React.useState(initial ?? '');
      const [error, setError] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false);
      const input = React.useRef(null);
      const asksName = initial !== undefined;
      React.useEffect(() => {
        const el = input.current;
        if (el === null) return;
        el.focus();
        // Select the stem, not the extension, like file managers do.
        const dot = el.value.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
      }, []);
      React.useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
          if (event.key === 'Escape' && !busy) onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [busy, onClose]);
      const name = value.trim();
      const invalid = asksName && name.length > 0 && !validName(name);
      const run = async () => {
        if (busy || (asksName && (name.length === 0 || invalid))) return;
        setBusy(true);
        setError(undefined);
        let key: string | undefined;
        try {
          key = await submit(name);
        } catch {
          key = 'create.failed';
        }
        setBusy(false);
        if (key === undefined) onClose();
        else setError(key);
      };
      const dialog = h(
        'div',
        {
          className: 'dlf-dlg-back',
          onMouseDown: (event: MouseEvent) => {
            if (event.target === event.currentTarget && !busy) onClose();
          },
        },
        h(
          'form',
          {
            className: 'dlf-dlg',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            'data-dlf-dialog': '',
            onSubmit: (event: Event) => {
              event.preventDefault();
              run();
            },
          },
          h('h2', { className: 'dlf-dlg-title' }, title),
          where && h('div', { className: 'dlf-dlg-where' }, where),
          asksName &&
            h('input', {
              ref: input,
              className: 'dlf-dlg-input',
              value,
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': title,
              'aria-invalid': invalid || error !== undefined ? 'true' : undefined,
              onChange: (event: any) => {
                setValue(event.target.value);
                setError(undefined);
              },
            }),
          (invalid || error !== undefined) &&
            h(
              'div',
              { className: 'dlf-dlg-error', role: 'alert' },
              t(invalid ? 'create.invalid' : (error as string)),
            ),
          hint && !invalid && error === undefined && h('div', { className: 'dlf-dlg-hint' }, hint),
          h(
            'div',
            { className: 'dlf-dlg-actions' },
            h(
              'button',
              { type: 'button', className: 'dlf-ed-btn', disabled: busy, onClick: onClose },
              t('create.cancel'),
            ),
            h(
              'button',
              {
                type: 'submit',
                className: 'dlf-ed-btn',
                'data-primary': danger ? undefined : '',
                'data-danger': danger ? '' : undefined,
                disabled: busy || (asksName && (name.length === 0 || invalid)),
              },
              confirm,
            ),
          ),
        ),
      );
      return ReactDOM?.createPortal ? ReactDOM.createPortal(dialog, document.body) : dialog;
    }

    /** What differs between New file and New folder. */
    const CREATE_KINDS = {
      file: {
        label: 'create.file',
        hint: 'create.fileHint',
        marker: 'data-new-file',
        icon: NewFileIcon,
        route: CREATE_FILE_ROUTE,
        opensEditor: true,
      },
      folder: {
        label: 'create.folder',
        hint: 'create.folderHint',
        marker: 'data-new-folder',
        icon: NewFolderIcon,
        route: CREATE_FOLDER_ROUTE,
        opensEditor: false,
      },
    } as const;

    /**
     * "New file" / "New folder" in the Files tab toolbar. A new file opens in
     * the editor; a new folder simply appears in the tree (it watches the disk).
     */
    function CreateButton({
      kind,
      sessionId,
      absolutePath,
      sidebarRight,
      t,
    }: {
      kind: keyof typeof CREATE_KINDS;
      sessionId?: unknown;
      absolutePath?: unknown;
      sidebarRight: SidebarRight;
      t: Translate;
    }) {
      const [open, setOpen] = React.useState(false);
      if (typeof sessionId !== 'string' || typeof absolutePath !== 'string') return null;
      const spec = CREATE_KINDS[kind];
      const label = t(spec.label);
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dlf-tool',
            title: label,
            'aria-label': label,
            [spec.marker]: '',
            onClick: () => setOpen(true),
          },
          h(spec.icon, { size: 16 }),
        ),
        open &&
          h(NameDialog, {
            title: label,
            where: absolutePath,
            hint: t(spec.hint),
            initial: '',
            confirm: t('create.create'),
            t,
            onClose: () => setOpen(false),
            submit: async (name: string) => {
              const res = await postJson(spec.route, { sessionId, directory: absolutePath, name });
              if (!res.ok) return mutationErrorKey(res, 'folder');
              if (spec.opensEditor) {
                try {
                  sidebarRight.openResource(sessionFileAddress(sessionId, res.body.absolutePath), {
                    kind: EDITOR_KIND,
                  });
                } catch (error) {
                  console.warn('open new file rejected:', error);
                }
              }
              return undefined;
            },
          }),
      );
    }

    /**
     * Open sidebar tabs (preview or editor) showing a Host file, or any file
     * under a Host folder (`folder: true`). Tab addresses hold an absolute path
     * or one relative to the session's workspace: with the workspace root
     * (`cwd`) known it is joined to it; without it, a relative path whose
     * suffix fits is resolved by the Host (`workspaceFiles.stat`), so `a.txt`
     * never matches `/ws/sub/a.txt`. Only on a Harness without that call does
     * the suffix alone decide, erring towards "this file".
     */
    async function tabsShowing(
      sidebarRight: SidebarRight,
      remote: { workspaceFiles: RemoteWorkspaceFiles },
      sessionId: string,
      absolutePath: string,
      options: { cwd?: string | undefined; folder?: boolean } = {},
    ) {
      let tabs: readonly { id: string; kind: string; contentId: string }[] = [];
      try {
        tabs = sidebarRight.tabsIn?.(sessionId) ?? [];
      } catch {
        return [];
      }
      const covers = (path: string) =>
        path === absolutePath ||
        (options.folder === true && path.startsWith(`${absolutePath.replace(/\/+$/, '')}/`));
      const shows = async (path: string) => {
        if (path.startsWith('/')) return covers(path);
        if (options.cwd !== undefined) return covers(resolveWorkspacePath(options.cwd, path));
        if (options.folder !== true && !absolutePath.endsWith(`/${path}`)) return false;
        const stat = remote.workspaceFiles.stat;
        if (typeof stat !== 'function') return options.folder !== true;
        try {
          const result = await stat.call(remote.workspaceFiles, sessionId, path);
          return result.ok && covers(result.value.absolutePath);
        } catch {
          return false;
        }
      };
      const matches = await Promise.all(
        tabs.map((tab) => {
          const path = parseFileAddress(tab.contentId)?.path;
          return path === undefined ? false : shows(path);
        }),
      );
      return tabs.filter((_tab, i) => matches[i]);
    }

    /** Close the given tabs; best effort (a newer Harness may lack closeIn). */
    function closeTabs(sidebarRight: SidebarRight, sessionId: string, ids: string[]) {
      for (const id of ids) {
        try {
          sidebarRight.closeIn?.(sessionId, id);
        } catch (error) {
          console.warn('close tab rejected:', error);
        }
      }
    }

    /** Same as the stock resolveWorkspacePath: a relative path joined to the workspace root. */
    function resolveWorkspacePath(cwd: string | undefined, path: string): string {
      if (path.startsWith('/') || cwd === undefined || cwd === '') return path;
      return `${cwd.replace(/\/+$/, '')}/${path.replace(/^(?:\.?\/)+/, '')}`;
    }

    /** What a folder download may hold; keep in step with FOLDER_LIMITS in src/folder-route.ts. */
    const FOLDER_LIMITS = { files: '20,000', size: '2 GiB' };
    /** How long the Restore button stays after a delete. */
    const RESTORE_MS = 10_000;

    /** A file or folder a menu action acts on. */
    interface EntryTarget {
      kind: 'file' | 'folder';
      sessionId: string;
      absolutePath: string;
      cwd?: string | undefined;
    }

    /** The open dialog (rename/delete) and the toast after a delete, shared by all menus. */
    type EntryDialog = { action: 'rename' | 'delete'; target: EntryTarget } | undefined;
    interface EntryToast {
      id: number;
      name: string;
      kind: 'file' | 'folder';
      state: 'deleted' | 'restoring' | 'restored' | 'failed';
      error?: string | undefined;
      sessionId: string;
      restoreToken?: string | undefined;
      /** Tabs the delete closed, reopened by a restore. */
      reopen: string[];
    }
    const entryUi = {
      dialog: undefined as EntryDialog,
      toast: undefined as EntryToast | undefined,
      listeners: new Set<() => void>(),
      revision: 0,
      set(change: { dialog?: EntryDialog; toast?: EntryToast | undefined }) {
        if ('dialog' in change) entryUi.dialog = change.dialog;
        if ('toast' in change) entryUi.toast = change.toast;
        entryUi.revision += 1;
        for (const listener of entryUi.listeners) listener();
      },
      subscribe: (listener: () => void) => {
        entryUi.listeners.add(listener);
        return () => {
          entryUi.listeners.delete(listener);
        };
      },
      snapshot: () => entryUi.revision,
    };
    let toastIds = 0;

    /** Routes and labels that differ between files and folders. */
    const ENTRY_KINDS = {
      file: {
        rename: RENAME_FILE_ROUTE,
        delete: DELETE_FILE_ROUTE,
        deleteTitle: 'delete.title',
        dirty: 'entry.dirty',
      },
      folder: {
        rename: RENAME_FOLDER_ROUTE,
        delete: DELETE_FOLDER_ROUTE,
        deleteTitle: 'delete.folderTitle',
        dirty: 'entry.dirtyFolder',
      },
    } as const;

    /** Message key for a failed rename/delete/restore. */
    function entryErrorKey(res: { status: number; body: any }, kind: 'file' | 'folder'): string {
      if (res.status === 501) return 'entry.noMv';
      if (res.status === 422 && /mount point/.test(String(res.body?.error)))
        return 'entry.mountPoint';
      if (res.status === 422 && /filesystem/.test(String(res.body?.error)))
        return 'entry.crossDevice';
      if (res.status === 400 && /into itself/.test(String(res.body?.error)))
        return 'rename.intoItself';
      if (res.status === 403 && /trash/.test(String(res.body?.error))) return 'delete.trash';
      if (res.status === 404 && kind === 'folder' && res.body?.error !== 'session not found')
        return 'rename.missingFolder';
      return mutationErrorKey(res, 'file');
    }

    /** "3 files, 2 folders (1.2 MiB)" for the folder delete question. */
    async function folderSummary(absolutePath: string) {
      try {
        const url = new URL(SUMMARY_ROUTE, document.baseURI);
        url.searchParams.set('path', absolutePath);
        const res = await fetch(url.href);
        if (!res.ok) return undefined;
        return (await res.json()) as {
          files: number;
          folders: number;
          bytes: number;
          truncated: boolean;
          mounts?: string[];
          downloadable: boolean;
        };
      } catch {
        return undefined;
      }
    }

    /** The rename or delete dialog the menus open (mounted once, on shell.overlay). */
    function EntryDialogView({
      dialog,
      sidebarRight,
      remote,
      t,
    }: {
      dialog: NonNullable<EntryDialog>;
      sidebarRight: SidebarRight;
      remote: { workspaceFiles: RemoteWorkspaceFiles };
      t: Translate;
    }) {
      const { action, target } = dialog;
      const { kind, sessionId, absolutePath, cwd } = target;
      const spec = ENTRY_KINDS[kind];
      const name = baseName(absolutePath);
      const [summary, setSummary] = React.useState(undefined);
      React.useEffect(() => {
        if (action !== 'delete' || kind !== 'folder') return;
        let live = true;
        folderSummary(absolutePath).then((s) => {
          if (live) setSummary(s ?? null);
        });
        return () => {
          live = false;
        };
      }, [action, kind, absolutePath]);
      const onClose = () => entryUi.set({ dialog: undefined });
      /** Open tabs of the entry, and the error key when one holds unsaved edits. */
      const entryTabs = async () => {
        const tabs = await tabsShowing(sidebarRight, remote, sessionId, absolutePath, {
          cwd,
          folder: kind === 'folder',
        });
        const dirty = tabs.some((tab) => dirtyTabs.ids.has(dirtyKey(sessionId, tab.id)));
        return { tabs, blocked: dirty ? spec.dirty : undefined };
      };
      if (action === 'rename') {
        return h(NameDialog, {
          title: t(kind === 'file' ? 'rename.title' : 'rename.folderTitle'),
          where: absolutePath,
          hint: t('rename.hint'),
          initial: name,
          confirm: t('rename.confirm'),
          t,
          onClose,
          submit: async (destination: string) => {
            const { tabs, blocked } = await entryTabs();
            if (blocked !== undefined) return blocked;
            const res = await postJson(spec.rename, { sessionId, path: absolutePath, destination });
            if (!res.ok) return entryErrorKey(res, kind);
            const moved = res.body.absolutePath;
            if (moved !== absolutePath) {
              closeTabs(
                sidebarRight,
                sessionId,
                tabs.map((tab) => tab.id),
              );
              // A renamed file reopens; a folder's files reopen at their new place.
              for (const tab of kind === 'file' ? [{ contentId: '' }] : tabs) {
                const old = parseFileAddress(tab.contentId)?.path;
                const path =
                  kind === 'file'
                    ? moved
                    : `${moved}${resolveWorkspacePath(cwd, old ?? '').slice(absolutePath.length)}`;
                if (kind === 'folder' && old === undefined) continue;
                try {
                  sidebarRight.openResource(sessionFileAddress(sessionId, path), {});
                } catch (error) {
                  console.warn('open renamed file rejected:', error);
                }
              }
            }
            return undefined;
          },
        });
      }
      const question =
        kind === 'file'
          ? t('delete.question', { name })
          : summary === undefined
            ? t('delete.counting')
            : summary === null
              ? t('delete.folderQuestion', { name })
              : summary.files + summary.folders === 0
                ? t('delete.emptyFolderQuestion', { name })
                : t(summary.truncated ? 'delete.folderMany' : 'delete.folderContents', {
                    name,
                    files: summary.files,
                    folders: summary.folders,
                    size: formatSize(summary.bytes),
                  });
      return h(NameDialog, {
        title: t(spec.deleteTitle),
        where: absolutePath,
        hint: [
          question,
          t('delete.trashNote'),
          summary?.mounts?.length ? t('delete.mounts', { mounts: summary.mounts.join(', ') }) : '',
        ]
          .filter(Boolean)
          .join(' '),
        confirm: t('delete.confirm'),
        danger: true,
        t,
        onClose,
        submit: async () => {
          const { tabs, blocked } = await entryTabs();
          if (blocked !== undefined) return blocked;
          const res = await postJson(spec.delete, { sessionId, path: absolutePath });
          if (!res.ok) return entryErrorKey(res, kind);
          closeTabs(
            sidebarRight,
            sessionId,
            tabs.map((tab) => tab.id),
          );
          // Only the last deletion can be restored: this toast replaces any other.
          entryUi.set({
            toast: {
              id: ++toastIds,
              name,
              kind,
              state: 'deleted',
              sessionId,
              restoreToken: res.body.restoreToken,
              reopen: tabs.map((tab) => tab.contentId),
            },
          });
          return undefined;
        },
      });
    }

    /**
     * "Deleted <name> · Restore", for {@link RESTORE_MS} after a delete, like
     * Gmail's undo. The timer pauses while the pointer or focus is on it.
     */
    function EntryToastView({
      toast,
      sidebarRight,
      t,
    }: {
      toast: EntryToast;
      sidebarRight: SidebarRight;
      t: Translate;
    }) {
      const [held, setHeld] = React.useState(false);
      const settled = toast.state === 'restored' || toast.state === 'failed';
      React.useEffect(() => {
        if (held || toast.state === 'restoring') return;
        const timer = setTimeout(
          () => {
            if (entryUi.toast?.id === toast.id) entryUi.set({ toast: undefined });
          },
          settled ? ERROR_MS : RESTORE_MS,
        );
        return () => clearTimeout(timer);
      }, [held, toast.id, toast.state, settled]);
      const restore = async () => {
        if (toast.restoreToken === undefined) return;
        entryUi.set({ toast: { ...toast, state: 'restoring' } });
        let res: { status: number; ok: boolean; body: any };
        try {
          res = await postJson(RESTORE_ROUTE, {
            sessionId: toast.sessionId,
            restoreToken: toast.restoreToken,
          });
        } catch {
          res = { status: 0, ok: false, body: {} };
        }
        if (entryUi.toast?.id !== toast.id) return;
        if (!res.ok) {
          const error =
            res.status === 409
              ? 'restore.taken'
              : res.status === 404
                ? 'restore.gone'
                : entryErrorKey(res, toast.kind);
          entryUi.set({ toast: { ...toast, state: 'failed', error } });
          return;
        }
        for (const address of toast.reopen) {
          try {
            sidebarRight.openResource(address, {});
          } catch (error) {
            console.warn('reopen restored file rejected:', error);
          }
        }
        entryUi.set({ toast: { ...toast, state: 'restored', restoreToken: undefined } });
      };
      const text =
        toast.state === 'restored'
          ? t('restore.done', { name: toast.name })
          : toast.state === 'failed'
            ? t(toast.error ?? 'create.failed', { name: toast.name })
            : t(toast.kind === 'file' ? 'delete.doneFile' : 'delete.doneFolder', {
                name: toast.name,
              });
      const dialog = h(
        'div',
        {
          className: 'dlf-toast',
          role: toast.state === 'failed' ? 'alert' : 'status',
          'aria-live': 'polite',
          'data-dlf-toast': toast.state,
          'data-tone': toast.state === 'failed' ? 'error' : undefined,
          onMouseEnter: () => setHeld(true),
          onMouseLeave: () => setHeld(false),
          onFocus: () => setHeld(true),
          onBlur: () => setHeld(false),
        },
        h('span', { className: 'dlf-toast-text' }, text),
        !settled &&
          h(
            'button',
            {
              type: 'button',
              className: 'dlf-toast-btn',
              'data-dlf-restore': '',
              disabled: toast.state === 'restoring',
              onClick: restore,
            },
            t(toast.kind === 'file' ? 'restore.file' : 'restore.folder'),
          ),
        h(
          'button',
          {
            type: 'button',
            className: 'dlf-toast-close',
            'aria-label': t('toast.dismiss'),
            onClick: () => entryUi.set({ toast: undefined }),
          },
          '×',
        ),
      );
      return ReactDOM?.createPortal ? ReactDOM.createPortal(dialog, document.body) : dialog;
    }

    /** The dialog and toast the menu actions drive; mounted once on shell.overlay. */
    function EntryOverlay({
      sidebarRight,
      remote,
      t,
    }: {
      sidebarRight: SidebarRight;
      remote: { workspaceFiles: RemoteWorkspaceFiles };
      t: Translate;
    }) {
      React.useSyncExternalStore(entryUi.subscribe, entryUi.snapshot);
      const { dialog, toast } = entryUi;
      return h(
        React.Fragment,
        null,
        dialog !== undefined &&
          h(EntryDialogView, {
            key: `${dialog.action}:${dialog.target.absolutePath}`,
            dialog,
            sidebarRight,
            remote,
            t,
          }),
        toast !== undefined && h(EntryToastView, { key: toast.id, toast, sidebarRight, t }),
      );
    }

    /** Download a folder as .zip; rejects (the menu shows the failure) when too large or gone. */
    async function downloadFolder(absolutePath: string): Promise<void> {
      const summary = await folderSummary(absolutePath);
      if (summary === undefined) throw new Error('folder unavailable');
      if (!summary.downloadable) throw new Error('folder too large');
      const url = new URL(DOWNLOAD_FOLDER_ROUTE, document.baseURI);
      url.searchParams.set('path', absolutePath);
      startDownload(url.href);
    }

    // ─────────────────────── text helpers (pure) ───────────────────────

    /** Dominant line ending of `text`. */
    function dominantEol(text: string): string {
      const crlf = (text.match(/\r\n/g) ?? []).length;
      const lf = (text.match(/\n/g) ?? []).length - crlf;
      return crlf > lf ? '\r\n' : '\n';
    }

    const toLf = (text: string) => text.replace(/\r\n/g, '\n');
    const withEol = (text: string, eol: string) =>
      eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;

    /**
     * Decode a file's bytes as strict UTF-8, keeping a leading BOM so a save
     * writes it back. Returns { text } or { reason: 'notText' }.
     */
    function decodeText(
      bytes: Uint8Array,
    ): { reason?: undefined; text: string } | { reason: 'notText'; text?: undefined } {
      if (bytes.subarray(0, 8192).includes(0)) return { reason: 'notText' };
      try {
        return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
      } catch {
        return { reason: 'notText' };
      }
    }

    const formatBytes = (n: number) =>
      n >= 1024 * 1024 ? `${n / 1024 / 1024} MiB` : `${Math.round(n / 1024)} KiB`;

    /** Human size for the editor header: exact bytes below 1 KiB, one decimal above. */
    function formatSize(n: number): string {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
      return `${(n / 1024 / 1024).toFixed(1)} MiB`;
    }

    /** Short local date-time, with the date only when it is not today. */
    function formatModified(date: Date): string {
      const now = new Date();
      const sameDay = date.toDateString() === now.toDateString();
      return sameDay
        ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString(undefined, {
            year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
    }

    interface FileInfo {
      size?: number;
      modified?: Date;
    }

    /** Size and modification time of a Host file, from the download route's headers. */
    async function fetchFileInfo(absolutePath: string): Promise<FileInfo | undefined> {
      try {
        const response = await fetch(pathUrl(absolutePath), { method: 'HEAD' });
        if (!response.ok) return undefined;
        const length = Number(response.headers.get('content-length'));
        const modified = new Date(response.headers.get('last-modified') ?? '');
        return {
          size: Number.isSafeInteger(length) && length >= 0 ? length : undefined,
          modified: Number.isNaN(modified.getTime()) ? undefined : modified,
        };
      } catch {
        return undefined;
      }
    }

    // ─────────────────── Monaco in a sandboxed iframe ───────────────────

    /**
     * Runs INSIDE the sandboxed iframe (it is stringified into the frame
     * document, so it must not reference anything from this closure).
     * Protocol, frame → parent: loaded, ready, dirty, save, content, error.
     * Parent → frame: init, getContent, setContent, markSaved, theme, focus.
     */
    function frameMain(config: { base: string }) {
      const send = (message: unknown) => {
        parent.postMessage(message, '*');
      };
      const fail = (message: unknown) => {
        send({ type: 'error', message: String(message) });
      };
      window.addEventListener('error', (event: ErrorEvent) => {
        fail(event.message);
      });
      if (typeof require === 'undefined' || typeof require.config !== 'function') {
        fail('loader unavailable');
        return;
      }
      const workerSource = `self.MonacoEnvironment={baseUrl:${JSON.stringify(config.base.replace(/vs$/, ''))}};importScripts(${JSON.stringify(`${config.base}/base/worker/workerMain.js`)});`;
      const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
      self.MonacoEnvironment = { getWorkerUrl: () => workerUrl };
      require.config({ paths: { vs: config.base } });

      let monaco: any;
      let editor: any;
      let model: any;
      let savedId = 0;
      let lastDirty = false;
      const report = () => {
        const dirty = model.getAlternativeVersionId() !== savedId;
        if (dirty !== lastDirty) {
          lastDirty = dirty;
          send({ type: 'dirty', dirty });
        }
      };

      const handlers: Record<string, (message: any) => void> = {
        init(message: any) {
          model = monaco.editor.createModel(
            message.content,
            undefined,
            monaco.Uri.file(message.fileName),
          );
          editor = monaco.editor.create(document.getElementById('c'), {
            model,
            theme: message.dark ? 'vs-dark' : 'vs',
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
          });
          savedId = model.getAlternativeVersionId();
          model.onDidChangeContent(report);
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            send({ type: 'save' });
          });
          send({ type: 'ready' });
        },
        getContent(message: any) {
          send({
            type: 'content',
            id: message.id,
            content: model.getValue(),
            token: model.getAlternativeVersionId(),
          });
        },
        setContent(message: any) {
          model.setValue(message.content);
          savedId = model.getAlternativeVersionId();
          report();
        },
        markSaved(message: any) {
          savedId = message.token;
          report();
        },
        theme(message: any) {
          monaco.editor.setTheme(message.dark ? 'vs-dark' : 'vs');
        },
        focus() {
          editor.focus();
        },
      };

      window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== parent) return;
        const message = event.data;
        const handler =
          message !== null && typeof message === 'object' ? handlers[message.type] : undefined;
        if (handler === undefined || (message.type !== 'init' && editor === undefined)) return;
        try {
          handler(message);
        } catch (error) {
          fail(error);
        }
      });

      require(['vs/editor/editor.main'], () => {
        monaco = window.monaco;
        send({ type: 'loaded' });
      }, (error: unknown) => {
        fail(error);
      });
    }

    /** The iframe document: pinned loader with SRI, a CSP limiting everything to the CDN. */
    function frameDocument() {
      const csp = [
        "default-src 'none'",
        `script-src 'unsafe-inline' ${MONACO_ORIGIN} blob:`,
        `style-src 'unsafe-inline' ${MONACO_ORIGIN}`,
        `font-src ${MONACO_ORIGIN} data:`,
        `img-src data: blob: ${MONACO_ORIGIN}`,
        'worker-src blob:',
        `connect-src ${MONACO_ORIGIN}`,
      ].join('; ');
      const main = `(${frameMain.toString()})(${JSON.stringify({ base: MONACO_BASE }).replace(/</g, '\\u003c')});`;
      return (
        '<!doctype html><html><head><meta charset="utf-8">' +
        `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
        '<style>html,body,#c{margin:0;width:100%;height:100%;overflow:hidden}</style></head>' +
        '<body><div id="c"></div>' +
        `<script src="${MONACO_BASE}/loader.js" integrity="${MONACO_LOADER_SRI}" crossorigin="anonymous"></script>` +
        `<script>${main}</script></body></html>`
      );
    }

    let cachedFrameDocument: string | undefined;
    const frameHtml = () => (cachedFrameDocument ??= frameDocument());

    // ───────────────────────────── editors ─────────────────────────────
    // Both implement: getContent() → { content, token }, setContent(text),
    // markSaved(token), focus().

    const MonacoFrame = React.forwardRef(function MonacoFrame(
      {
        fileName,
        initial,
        dark,
        onDirty,
        onSave,
        onFail,
      }: {
        fileName: string;
        initial: string;
        dark: boolean;
        onDirty: (dirty: boolean) => void;
        onSave: () => void;
        onFail: (reason: unknown) => void;
      },
      ref: any,
    ) {
      const frame = React.useRef(null);
      const replies = React.useRef(new Map());
      const sequence = React.useRef(0);
      const first = React.useRef({ fileName, content: initial, dark });
      const callbacks = React.useRef({ onDirty, onSave, onFail });
      callbacks.current = { onDirty, onSave, onFail };

      const post = React.useCallback((message: unknown) => {
        frame.current?.contentWindow?.postMessage(message, '*');
      }, []);

      React.useEffect(() => {
        // Once the editor is up, its text may be unsaved: a late error is only
        // logged, never a reason to swap the editor out from under the user.
        let ready = false;
        const failed = (reason: unknown) => {
          if (ready) console.warn('monaco frame error after ready:', reason);
          else callbacks.current.onFail(reason);
        };
        const timer = setTimeout(() => {
          failed('timeout');
        }, FRAME_LOAD_TIMEOUT_MS);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== frame.current?.contentWindow) return;
          const message = event.data;
          if (message === null || typeof message !== 'object') return;
          switch (message.type) {
            case 'loaded':
              post({ type: 'init', ...first.current });
              break;
            case 'ready':
              ready = true;
              clearTimeout(timer);
              break;
            case 'dirty':
              callbacks.current.onDirty(message.dirty === true);
              break;
            case 'save':
              callbacks.current.onSave();
              break;
            case 'content': {
              const pending = replies.current.get(message.id);
              replies.current.delete(message.id);
              pending?.resolve({ content: message.content, token: message.token });
              break;
            }
            case 'error':
              clearTimeout(timer);
              failed(message.message);
              break;
            default:
              break;
          }
        };
        window.addEventListener('message', onMessage);
        return () => {
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          for (const pending of replies.current.values())
            pending.reject(new Error('editor closed'));
          replies.current.clear();
        };
      }, [post]);

      React.useEffect(() => {
        post({ type: 'theme', dark });
      }, [dark, post]);

      React.useImperativeHandle(
        ref,
        () => ({
          getContent: () =>
            new Promise<{ content: string; token: unknown }>((resolve, reject) => {
              sequence.current += 1;
              const id = sequence.current;
              const timer = setTimeout(() => {
                replies.current.delete(id);
                reject(new Error('editor did not answer'));
              }, FRAME_REPLY_TIMEOUT_MS);
              replies.current.set(id, {
                resolve: (value: unknown) => {
                  clearTimeout(timer);
                  resolve(value as { content: string; token: unknown });
                },
                reject: (error: unknown) => {
                  clearTimeout(timer);
                  reject(error);
                },
              });
              post({ type: 'getContent', id });
            }),
          setContent: (content: string) => {
            post({ type: 'setContent', content });
          },
          markSaved: (token: unknown) => {
            post({ type: 'markSaved', token });
          },
          focus: () => {
            post({ type: 'focus' });
          },
        }),
        [post],
      );

      return h('iframe', {
        ref: frame,
        className: 'dlf-ed-frame',
        title: fileName,
        // Opaque origin: the CDN code cannot reach the Harness page, its cookies or its API.
        sandbox: 'allow-scripts',
        srcDoc: frameHtml(),
      });
    });

    const TextEditor = React.forwardRef(function TextEditor(
      {
        initial,
        eol,
        onDirty,
        onSave,
      }: {
        initial: string;
        eol: string;
        onDirty: (dirty: boolean) => void;
        onSave: () => void;
      },
      ref: any,
    ) {
      const area = React.useRef(null);
      const saved = React.useRef(toLf(initial));
      React.useImperativeHandle(
        ref,
        () => ({
          getContent: async () => {
            const value = area.current.value;
            return { content: withEol(value, eol), token: value };
          },
          setContent: (content: string) => {
            const value = toLf(content);
            area.current.value = value;
            saved.current = value;
            onDirty(false);
          },
          markSaved: (token: unknown) => {
            saved.current = token;
            onDirty(area.current.value !== saved.current);
          },
          focus: () => {
            area.current?.focus();
          },
        }),
        [eol, onDirty],
      );
      return h('textarea', {
        ref: area,
        className: 'dlf-ed-text',
        defaultValue: toLf(initial),
        spellCheck: false,
        'aria-label': 'editor',
        onChange: () => {
          onDirty(area.current.value !== saved.current);
        },
        onKeyDown: (event: KeyboardEvent) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            onSave();
          }
        },
      });
    });

    // ──────────────────────── dirty tracking store ────────────────────────

    /** Tab ids are only unique within a session's layout. */
    const dirtyKey = (sessionId: string, tabId: string) => `${sessionId}\u0000${tabId}`;

    const dirtyTabs = {
      ids: new Set<string>(),
      listeners: new Set<() => void>(),
      revision: 0,
      set(id: string, dirty: boolean) {
        if (this.ids.has(id) === dirty) return;
        if (dirty) this.ids.add(id);
        else this.ids.delete(id);
        this.revision += 1;
        for (const listener of this.listeners) listener();
      },
      subscribe: (listener: () => void) => {
        dirtyTabs.listeners.add(listener);
        return () => {
          dirtyTabs.listeners.delete(listener);
        };
      },
      snapshot: () => dirtyTabs.revision,
    };

    // ───────────────────────────── editor tab ─────────────────────────────

    const LOAD_ERROR_KEYS: Record<string, string> = {
      tooLarge: 'editor.tooLarge',
      notText: 'editor.notText',
      gone: 'editor.gone',
      failed: 'editor.loadError',
    };

    interface RemoteWorkspaceFiles {
      /** Absolute path of a workspace file; optional on older Harnesses. */
      stat?(
        sessionId: string,
        path: string,
        signal?: AbortSignal,
      ): Promise<{ ok: true; value: { absolutePath: string } } | { ok: false }>;
      readBytes(
        sessionId: string,
        path: string,
        options: { range?: { offset: number; length: number } },
        signal?: AbortSignal,
      ): Promise<
        | {
            ok: true;
            value: {
              data: Uint8Array;
              eof: boolean;
              bytes?: number;
              version: string;
              absolutePath?: string;
            };
          }
        | { ok: false; error?: { code?: string } }
      >;
    }

    /** What a tab pane's `useTabInfo()` reports for this plugin's tabs. */
    interface ClientTab {
      id: string;
      contentId?: string;
      title: string;
      signal: AbortSignal;
      actions: { bindCommands(commands: Record<string, () => void>): () => void };
    }

    interface EditorPaneProps {
      useTabInfo(): { tab: ClientTab };
      sessionId: string;
    }

    interface ClientTheme {
      getTheme(): { active: { colorScheme?: string } };
      subscribe(listener: () => void): () => void;
    }

    type LoadError = 'tooLarge' | 'notText' | 'gone' | 'failed';
    type LoadedFile =
      | { reason?: undefined; text: string; eol: string; version: string; absolutePath?: string }
      | { reason: LoadError };
    type SaveState =
      | { state: 'idle' | 'saving' | 'saved' | 'conflict' }
      | { state: 'error'; key: string };

    /** Read the whole file as bytes (not lines) so line endings and the trailing newline survive a save. */
    async function readFile(
      remote: { workspaceFiles: RemoteWorkspaceFiles },
      sessionId: string,
      path: string,
      signal: AbortSignal,
    ): Promise<LoadedFile> {
      let result: Awaited<ReturnType<RemoteWorkspaceFiles['readBytes']>>;
      try {
        result = await remote.workspaceFiles.readBytes(
          sessionId,
          path,
          { range: { offset: 0, length: MAX_EDIT_BYTES + 1 } },
          signal,
        );
      } catch {
        return { reason: 'failed' };
      }
      if (!result.ok) {
        const code = result.error?.code;
        if (code === 'workspace-file/too-large') return { reason: 'tooLarge' };
        if (code === 'workspace-file/not-found') return { reason: 'gone' };
        return { reason: 'failed' };
      }
      const { data, eof, bytes, version, absolutePath } = result.value;
      if (!eof || (bytes ?? data.byteLength) > MAX_EDIT_BYTES) return { reason: 'tooLarge' };
      const decoded = decodeText(data);
      if (decoded.reason !== undefined) return { reason: decoded.reason };
      return { text: decoded.text, eol: dominantEol(decoded.text), version, absolutePath };
    }

    function EditorBody({
      props,
      remote,
      theme,
      t,
    }: {
      props: EditorPaneProps;
      remote: { workspaceFiles: RemoteWorkspaceFiles };
      theme: ClientTheme;
      t: Translate;
    }) {
      const { tab } = props.useTabInfo();
      const address = parseFileAddress(tab.contentId);
      const sessionId = address?.sessionId ?? props.sessionId;
      const path = address?.path ?? '';
      const name = baseName(path);

      const [file, setFile] = React.useState(null);
      const [loadError, setLoadError] = React.useState(null);
      const [engine, setEngine] = React.useState('monaco');
      const [dirty, setDirtyState] = React.useState(false);
      const [save, setSave] = React.useState({ state: 'idle' });
      const [dark, setDark] = React.useState(() => theme.getTheme().active.colorScheme === 'dark');
      const editor = React.useRef(null);
      const version = React.useRef('');
      const [info, setInfo] = React.useState(undefined);
      const absolutePath = React.useRef(undefined);
      const refreshInfo = React.useCallback(() => {
        const at = absolutePath.current;
        if (at === undefined) return;
        fetchFileInfo(at).then((next: FileInfo | undefined) => {
          if (!tab.signal.aborted && absolutePath.current === at) setInfo(next);
        });
      }, [tab.signal]);

      const key = dirtyKey(props.sessionId, tab.id);
      const setDirty = React.useCallback(
        (value: boolean) => {
          setDirtyState(value);
          dirtyTabs.set(key, value);
          if (value)
            setSave((current: SaveState) =>
              current.state === 'saved' ? { state: 'idle' } : current,
            );
        },
        [key],
      );
      React.useEffect(
        () => () => {
          dirtyTabs.set(key, false);
        },
        [key],
      );
      React.useEffect(() => {
        const sync = () => {
          setDark(theme.getTheme().active.colorScheme === 'dark');
        };
        sync();
        return theme.subscribe(sync);
      }, [theme]);

      const load = React.useCallback(async (): Promise<LoadedFile | undefined> => {
        const loaded = await readFile(remote, sessionId, path, tab.signal);
        if (tab.signal.aborted) return undefined;
        if (loaded.reason !== undefined) {
          setLoadError(loaded.reason);
          return undefined;
        }
        version.current = loaded.version;
        absolutePath.current = loaded.absolutePath;
        refreshInfo();
        return loaded;
      }, [remote, sessionId, path, tab.signal, refreshInfo]);

      React.useEffect(() => {
        let alive = true;
        setLoadError(null);
        load().then((loaded: LoadedFile | undefined) => {
          if (alive && loaded !== undefined) setFile(loaded);
        });
        return () => {
          alive = false;
        };
      }, [load]);

      const reload = React.useCallback(async () => {
        const loaded = await load();
        if (loaded === undefined) return;
        setLoadError(null);
        setSave({ state: 'idle' });
        setFile(loaded);
        editor.current?.setContent(loaded.text);
        setDirty(false);
      }, [load, setDirty]);

      const confirmDiscard = React.useCallback(
        () => !dirtyTabs.ids.has(key) || window.confirm(t('editor.discard', { name })),
        [key, t, name],
      );

      React.useEffect(
        () =>
          tab.actions.bindCommands({
            refresh: () => {
              if (confirmDiscard()) reload();
            },
          }),
        [tab.actions, confirmDiscard, reload],
      );

      const doSave = React.useCallback(
        async (force: boolean) => {
          if (save.state === 'saving' || editor.current === null) return;
          setSave({ state: 'saving' });
          try {
            const { content, token } = await editor.current.getContent();
            const response = await fetch(new URL(SAVE_ROUTE, document.baseURI).href, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                force
                  ? { sessionId, path, content, force: true }
                  : { sessionId, path, content, expectedVersion: version.current },
              ),
            });
            if (response.ok) {
              version.current = (await response.json()).version;
              editor.current.markSaved(token);
              refreshInfo();
              setSave({ state: 'saved' });
              // Clicking the Save button took keyboard focus; hand it back to the text.
              editor.current.focus();
              return;
            }
            // Only our route answers with JSON { error }; a 404 without it comes from
            // the server's router (route not registered), not from a missing file.
            const answered = (response.headers.get('content-type') ?? '').includes(
              'application/json',
            );
            if (response.status === 409) setSave({ state: 'conflict' });
            else if (response.status === 403) setSave({ state: 'error', key: 'editor.denied' });
            else if (response.status === 404 || response.status === 405) {
              setSave({
                state: 'error',
                key: answered && response.status === 404 ? 'editor.gone' : 'editor.noRoute',
              });
            } else if (response.status === 413) setSave({ state: 'error', key: 'editor.tooLarge' });
            else setSave({ state: 'error', key: 'editor.saveError' });
          } catch {
            setSave({ state: 'error', key: 'editor.saveError' });
          }
        },
        [save.state, sessionId, path, refreshInfo],
      );

      const onSave = React.useCallback(() => {
        doSave(false);
      }, [doSave]);
      const onFrameFail = React.useCallback((reason: unknown) => {
        console.warn('monaco unavailable, using plain text:', reason);
        setEngine((current: 'monaco' | 'text') => (current === 'monaco' ? 'text' : current));
      }, []);

      if (loadError !== null) {
        return h(
          'div',
          { className: 'dlf-ed', 'data-dlf-editor': '' },
          h(
            'div',
            { className: 'dlf-ed-msg' },
            h('span', null, t(LOAD_ERROR_KEYS[loadError], { limit: formatBytes(MAX_EDIT_BYTES) })),
            (loadError === 'failed' || loadError === 'gone') &&
              h(
                'button',
                {
                  type: 'button',
                  className: 'dlf-ed-btn',
                  onClick: () => {
                    reload();
                  },
                },
                t('editor.retry'),
              ),
          ),
        );
      }
      if (file === null) {
        return h(
          'div',
          { className: 'dlf-ed', 'data-dlf-editor': '' },
          h('div', { className: 'dlf-ed-msg' }, t('editor.loading')),
        );
      }

      const status: { text: string; tone?: string } | undefined =
        save.state === 'saving'
          ? { text: t('editor.saving') }
          : save.state === 'error'
            ? { text: t(save.key, { limit: formatBytes(MAX_EDIT_BYTES) }), tone: 'error' }
            : save.state === 'saved' && !dirty
              ? { text: t('editor.saved'), tone: 'ok' }
              : dirty
                ? { text: t('editor.unsaved') }
                : undefined;

      return h(
        'div',
        { className: 'dlf-ed', 'data-dlf-editor': '' },
        h(
          'div',
          { className: 'dlf-ed-bar' },
          h(
            'span',
            { className: 'dlf-ed-name', title: path },
            name,
            dirty && h('span', { className: 'dlf-ed-dot' }, ' ●'),
          ),
          h('span', { className: 'dlf-ed-spacer' }),
          info !== undefined &&
            (info.size !== undefined || info.modified !== undefined) &&
            h(
              'span',
              {
                className: 'dlf-ed-info',
                'data-dlf-info': '',
                title: info.modified?.toLocaleString(),
              },
              info.size !== undefined && info.modified !== undefined
                ? t('editor.info', {
                    size: formatSize(info.size),
                    modified: formatModified(info.modified),
                  })
                : info.size !== undefined
                  ? formatSize(info.size)
                  : formatModified(info.modified as Date),
            ),
          status &&
            h(
              'span',
              {
                className: 'dlf-ed-status',
                'data-tone': status.tone,
                role: status.tone === 'error' ? 'alert' : undefined,
              },
              status.text,
            ),
          h(
            'button',
            {
              type: 'button',
              className: 'dlf-ed-btn',
              disabled: !dirty || save.state === 'saving',
              onClick: onSave,
            },
            t('editor.save'),
          ),
        ),
        save.state === 'conflict' &&
          h(
            'div',
            { className: 'dlf-ed-banner', role: 'alert' },
            h('span', null, t('editor.conflict')),
            h(
              'button',
              {
                type: 'button',
                className: 'dlf-ed-btn',
                onClick: () => {
                  reload();
                },
              },
              t('editor.reload'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dlf-ed-btn',
                onClick: () => {
                  doSave(true);
                },
              },
              t('editor.overwrite'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dlf-ed-btn',
                onClick: () => {
                  setSave({ state: 'idle' });
                },
              },
              t('editor.keep'),
            ),
          ),
        engine === 'text' && h('div', { className: 'dlf-ed-note' }, t('editor.plain')),
        h(
          'div',
          { className: 'dlf-ed-body' },
          engine === 'monaco'
            ? h(MonacoFrame, {
                ref: editor,
                fileName: name,
                initial: file.text,
                dark,
                onDirty: setDirty,
                onSave,
                onFail: onFrameFail,
              })
            : h(TextEditor, {
                ref: editor,
                initial: file.text,
                eol: file.eol,
                onDirty: setDirty,
                onSave,
              }),
        ),
      );
    }

    // ───────────────────────────── plugin body ─────────────────────────────

    /** One entry of the stock context menu (`@deepseek-ai/dsh-client-ui-context-menu`). */
    interface MenuAction {
      id: string;
      label: string;
      icon?: { key: string };
      danger?: boolean;
      disabled?: boolean;
      separatorBefore?: boolean;
      failureLabel?: string;
      run?: () => void | Promise<void>;
    }
    /** The parts of `ctx.contextMenus` (DSH ≥ 0.2.2-rc.1) the plugin uses. */
    interface ContextMenus {
      register(contribution: {
        id: string;
        target: 'file' | 'directory';
        order: number;
        resolve(
          target: { sessionId: string; path: string },
          signal: AbortSignal,
        ): readonly MenuAction[] | Promise<readonly MenuAction[]>;
      }): () => void;
    }
    /** The parts of the Client `sessions` service the menus use: a session's workspace root. */
    interface ClientSessions {
      list: { getSnapshot(): { byId: Record<string, { cwd?: string | undefined } | undefined> } };
    }

    /** The client context cordis assembles from the `inject` list below. */
    interface ClientCtx {
      effect(callback: () => unknown, label?: string): unknown;
      /** Run `callback` in a child scope once these optional services exist. */
      inject?(deps: string[], callback: (scope: ClientCtx) => void): unknown;
      contextMenus?: ContextMenus;
      sessions?: ClientSessions;
      slots: {
        inject(name: string, factory: () => unknown): unknown;
        register(
          registration: {
            name: string;
            id?: string;
            key?: string;
            order?: number;
            priority?: number;
            locale?: string;
          },
          component: any,
        ): unknown;
      };
      locale: {
        register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown;
        bind(namespace: string): Translate;
      };
      sidebarRight: SidebarRight;
      sidebarRightTabs: {
        register(tabType: {
          id: string;
          kind: string;
          priority: string;
          keepMounted: boolean;
          canOpen: (address: string) => boolean;
          title: (address: string) => string;
        }): unknown;
      };
      remote: { workspaceFiles: RemoteWorkspaceFiles };
      theme: { getTheme(): { active: { colorScheme?: string } } };
      on(event: 'theme/change', listener: () => void): () => void;
    }

    return {
      inject: [
        'slots',
        'locale',
        'sidebarRight',
        'sidebarRightTabs',
        'remote',
        'remote.workspaceFiles',
        'theme',
      ],
      apply(ctx: ClientCtx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'always-on: dictionaries');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'dsh-always-on';
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => {
            style.remove();
          };
        }, 'always-on: styles');
        const t = ctx.locale.bind(NS);

        // ── download + show files ──
        const SessionShowFiles = () => h(ShowFiles, { sidebarRight: ctx.sidebarRight, t });
        const FilesTabNewFile = (props: { sessionId?: unknown; absolutePath?: unknown }) =>
          h(CreateButton, { ...props, kind: 'file', sidebarRight: ctx.sidebarRight, t });
        const FilesTabNewFolder = (props: { sessionId?: unknown; absolutePath?: unknown }) =>
          h(CreateButton, { ...props, kind: 'folder', sidebarRight: ctx.sidebarRight, t });

        const FileRouteDownload = (props: { actionUrl?: unknown }) => {
          const url = routeUrl(props.actionUrl);
          return url === undefined ? null : h(DownloadButton, { url, t });
        };
        const PathActions = (props: { sessionId?: unknown; absolutePath?: unknown }) =>
          typeof props.absolutePath === 'string'
            ? h(
                React.Fragment,
                null,
                h(EditButton, {
                  sessionId: props.sessionId,
                  absolutePath: props.absolutePath,
                  sidebarRight: ctx.sidebarRight,
                  t,
                }),
                h(DownloadButton, { url: pathUrl(props.absolutePath), t }),
              )
            : null;
        const PathDownloadProminent = (props: { absolutePath?: unknown }) =>
          typeof props.absolutePath === 'string'
            ? h(DownloadButton, { url: pathUrl(props.absolutePath), large: true, t })
            : null;

        const slots: Record<string, (props: any) => any> = {
          'deliverables.file.actions': FileRouteDownload,
          'deliverables.review.file.actions': FileRouteDownload,
          'sidebar.right.tab.document.actions': PathActions,
          'sidebar.right.tab.document.unpreviewable': PathDownloadProminent,
        };
        for (const [name, component] of Object.entries(slots)) {
          ctx.slots.inject(name, () =>
            ctx.slots.register({ name, id: `${OWN_ID}/download`, locale: NS }, component),
          );
        }
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: `${OWN_ID}/show-files`,
              order: -10,
              locale: NS,
            },
            SessionShowFiles,
          ),
        );
        ctx.slots.inject('sidebar.right.tab.files.actions', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.files.actions',
              id: `${EDITOR_ID}/new-file`,
              order: 10,
              locale: NS,
            },
            FilesTabNewFile,
          ),
        );
        ctx.slots.inject('sidebar.right.tab.files.actions', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.files.actions',
              id: `${EDITOR_ID}/new-folder`,
              order: 11,
              locale: NS,
            },
            FilesTabNewFolder,
          ),
        );

        // ── file and folder actions: the Files tree's right-click menu ──
        // The dialogs and the Restore toast, mounted once for every menu.
        const Overlay = () =>
          h(EntryOverlay, { sidebarRight: ctx.sidebarRight, remote: ctx.remote, t });
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: `${EDITOR_ID}/entry-actions`, locale: NS },
            Overlay,
          ),
        );
        // The menus need the stock context menu (DSH >= 0.2.2-rc.1); without it,
        // everything else still loads.
        const registerMenus = (scope: ClientCtx) => {
          const menus = scope.contextMenus as ContextMenus;
          const sessions = scope.sessions as ClientSessions;
          // A generator registers several entries under one inject, like the stock plugins do.
          scope.slots.inject('contextMenu.icon', function* () {
            for (const [key, Icon] of [
              ['always-on.rename', RenameIcon],
              ['always-on.delete', DeleteIcon],
              ['always-on.zip', DownloadIcon],
            ] as const) {
              yield scope.slots.register({ name: 'contextMenu.icon', key }, () =>
                h(Icon, { size: 16 }),
              );
            }
          });
          const targetOf = (kind: 'file' | 'folder', sessionId: string, path: string) => {
            const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
            const absolutePath = resolveWorkspacePath(cwd, path);
            return { kind, sessionId, absolutePath, cwd } as EntryTarget;
          };
          const entryActions = (target: EntryTarget): MenuAction[] => {
            const root =
              target.cwd !== undefined &&
              target.absolutePath.replace(/\/+$/, '') === target.cwd.replace(/\/+$/, '');
            const open = (action: 'rename' | 'delete') => () => {
              entryUi.set({ dialog: { action, target } });
            };
            return [
              {
                id: 'rename',
                label: t('menu.rename'),
                icon: { key: 'always-on.rename' },
                separatorBefore: true,
                disabled: root || !target.absolutePath.startsWith('/'),
                run: open('rename'),
              },
              {
                id: 'delete',
                label: t('menu.delete'),
                icon: { key: 'always-on.delete' },
                danger: true,
                disabled: root || !target.absolutePath.startsWith('/'),
                run: open('delete'),
              },
            ];
          };
          scope.effect(
            () =>
              menus.register({
                id: 'always-on.directory',
                target: 'directory',
                order: 300,
                resolve: ({ sessionId, path }) => {
                  const target = targetOf('folder', sessionId, path);
                  return [
                    ...entryActions(target),
                    {
                      id: 'zip',
                      label: t('menu.downloadZip'),
                      icon: { key: 'always-on.zip' },
                      separatorBefore: true,
                      disabled: !target.absolutePath.startsWith('/'),
                      failureLabel: t('menu.downloadFailed', FOLDER_LIMITS),
                      run: () => downloadFolder(target.absolutePath),
                    },
                  ];
                },
              }),
            'always-on: folder menu',
          );
          scope.effect(
            () =>
              menus.register({
                id: 'always-on.file',
                target: 'file',
                order: 300,
                resolve: ({ sessionId, path }) => entryActions(targetOf('file', sessionId, path)),
              }),
            'always-on: file menu',
          );
        };
        if (typeof ctx.inject === 'function')
          ctx.inject(['contextMenus', 'sessions'], registerMenus);

        // ── sidebar editor tab ──
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: EDITOR_ID,
              kind: EDITOR_KIND,
              // Opened only on request (the Edit button); never claims files by itself.
              priority: 'fallback',
              // An editor must keep its unsaved text while another tab is in front.
              keepMounted: true,
              canOpen: (address: string) => parseFileAddress(address) !== undefined,
              title: (address: string) => baseName(parseFileAddress(address)?.path ?? address),
            }),
          'always-on: editor tab type',
        );

        const theme: ClientTheme = {
          getTheme: () => ctx.theme.getTheme(),
          subscribe: (listener: () => void) => ctx.on('theme/change', listener),
        };
        const Body = (props: EditorPaneProps) =>
          h(EditorBody, { props, remote: ctx.remote, theme, t });
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: EDITOR_ID,
                  locale: NS,
                },
                Body,
              ),
            ),
          'always-on: editor tab body',
        );

        // Same icon as the stock preview tab: FileTypeIcon + classifyFileType from the
        // shared primitives. If a future Harness stops exposing them, the tab simply
        // shows no icon rather than failing.
        let primitives: any;
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        } catch {
          /* no icon */
        }
        const FileTypeIcon = primitives?.FileTypeIcon;
        const classifyFileType = primitives?.classifyFileType;
        const Title = ({
          useTabInfo,
          sessionId,
        }: {
          useTabInfo: () => { tab: ClientTab };
          sessionId: string;
        }) => {
          const { tab } = useTabInfo();
          React.useSyncExternalStore(dirtyTabs.subscribe, dirtyTabs.snapshot);
          const icon =
            FileTypeIcon && classifyFileType
              ? h(FileTypeIcon, {
                  kind: classifyFileType(tab.title),
                  size: 16,
                  className: 'dlf-ed-titleIcon',
                })
              : null;
          return h(
            React.Fragment,
            null,
            icon,
            tab.title,
            dirtyTabs.ids.has(dirtyKey(sessionId, tab.id)) ? ' ●' : '',
          );
        };
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab.title',
                  key: EDITOR_ID,
                },
                Title,
              ),
            ),
          'always-on: editor tab title',
        );

        // Closing a tab with unsaved text asks first; throwing keeps the tab open.
        ctx.effect(
          () =>
            ctx.sidebarRight.registerCloseHandler(EDITOR_KIND, (sessionId, tab) => {
              const key = dirtyKey(sessionId, tab.id);
              if (
                dirtyTabs.ids.has(key) &&
                !window.confirm(t('editor.discard', { name: tab.title.replace(/ ●$/, '') }))
              ) {
                throw new Error('close cancelled: unsaved changes');
              }
              dirtyTabs.set(key, false);
            }),
          'always-on: editor close guard',
        );

        ctx.effect(() => {
          const guard = (event: BeforeUnloadEvent) => {
            if (dirtyTabs.ids.size === 0) return;
            event.preventDefault();
            event.returnValue = '';
          };
          window.addEventListener('beforeunload', guard);
          return () => {
            window.removeEventListener('beforeunload', guard);
          };
        }, 'always-on: unload guard');
      },
    };
  },
});
