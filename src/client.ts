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
 *
 * This file is a classic script, not a module: dsh serves `exports["./client"]`
 * verbatim to the browser, which registers it through `window.__ModuleLoader__`.
 * It must keep no top-level `import`/`export`; TypeScript only adds types here
 * (see tsconfig: `erasableSyntaxOnly`).
 *
 * Slots keep one cell per `id` and the lowest `priority` wins, so registering
 * the stock id `open-in-app` at priority -1 shadows the stock control without
 * modifying it; disabling this plugin brings the stock buttons back.
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
    const STOCK_ID = 'open-in-app';
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
    };

    const CSS = `
.dlf-split{box-sizing:border-box;display:inline-flex;align-items:stretch;flex:none;align-self:center;height:24px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);font-family:var(--dsw-font-family)}
.dlf-main{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:3px 5px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}
.dlf-main:hover:not(:disabled),.dlf-main:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dlf-main:disabled{cursor:default}
.dlf-split[data-error] .dlf-main{color:var(--dsw-alias-state-error-primary)}
.dlf-split[data-size=large]{height:36px;border-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dlf-split[data-size=large] .dlf-main{gap:6px;padding:6px 14px;font-size:14px}
.dlf-ed{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px}
.dlf-ed-bar{display:flex;align-items:center;gap:8px;flex:none;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dlf-ed-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.dlf-ed-dot{color:var(--dsw-alias-state-warn-primary)}
.dlf-ed-spacer{flex:1}
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

    // ─────────────────────────── file addresses ───────────────────────────

    // Sidebar surface the buttons drive: tab switching, resource tabs, close guards.
    interface SidebarRight {
      openTab(tab: string): unknown;
      openResource(address: string, options: { kind: string }): unknown;
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
      readBytes(
        sessionId: string,
        path: string,
        options: { range?: { offset: number; length: number } },
        signal?: AbortSignal,
      ): Promise<
        | { ok: true; value: { data: Uint8Array; eof: boolean; bytes?: number; version: string } }
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
      | { reason?: undefined; text: string; eol: string; version: string }
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
      const { data, eof, bytes, version } = result.value;
      if (!eof || (bytes ?? data.byteLength) > MAX_EDIT_BYTES) return { reason: 'tooLarge' };
      const decoded = decodeText(data);
      if (decoded.reason !== undefined) return { reason: decoded.reason };
      return { text: decoded.text, eol: dominantEol(decoded.text), version };
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
        return loaded;
      }, [remote, sessionId, path, tab.signal]);

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
        [save.state, sessionId, path],
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

    /** The client context cordis assembles from the `inject` list below. */
    interface ClientCtx {
      effect(callback: () => unknown, label?: string): unknown;
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
        // Inside the Files tab a "Show files" button would be a no-op: render nothing.
        const HiddenInFilesTab = () => null;

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
            ctx.slots.register(
              {
                name,
                id: STOCK_ID,
                priority: -1,
                locale: NS,
              },
              component,
            ),
          );
        }
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: STOCK_ID,
              order: -10,
              priority: -1,
              locale: NS,
            },
            SessionShowFiles,
          ),
        );
        ctx.slots.inject('sidebar.right.tab.files.actions', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.tab.files.actions',
              id: STOCK_ID,
              priority: -1,
              locale: NS,
            },
            HiddenInFilesTab,
          ),
        );

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
