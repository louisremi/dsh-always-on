/**
 * Client half of dsh-docker-adapter. Registers "Download file" buttons in the
 * four slots where the stock open-in-app plugin renders "Show file location",
 * and replaces the stock directory "Open in app" control (Files / Cursor) with
 * "Show files", which switches to the sidebar file explorer.
 * Slots keep one cell per `id` and the lowest `priority` wins, so registering
 * the stock id `open-in-app` at priority -1 shadows the stock control without
 * modifying it; disabling this plugin brings the stock buttons back.
 */
window.__ModuleLoader__.load({
  id: '@louisremi/dsh-docker-adapter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'download-files';
    const ROUTE = 'api/download.file';
    const STOCK_ID = 'open-in-app';
    const ERROR_MS = 4000;
    const APPS_ROUTE = 'open-in-app/apps';
    const OPEN_ROUTE = 'open-in-app/open';
    const FILE_MANAGERS = new Set(['filemanager', 'finder', 'explorer']);
    const APP_NAMES = {
      cursor: 'Cursor', vscode: 'VS Code', vscodeinsiders: 'VS Code Insiders',
      windsurf: 'Windsurf', zed: 'Zed', sublimetext: 'Sublime Text',
    };
    const ICON_ROUTE = 'open-in-app/icon';

    const en = {
      'download.title': 'Download file',
      'download.error': 'Could not download the file. Try again.',
      'files.show': 'Show files',
      'files.more': 'More ways to open',
      'files.default': '{app} (default)',
      'files.openError': 'Could not open. Try again.',
      'app.cursor': 'Cursor',
    };
    const zh = {
      'download.title': '下载文件',
      'download.error': '无法下载文件，请重试',
      'files.show': '显示文件',
      'files.more': '更多打开方式',
      'files.default': '{app}（默认）',
      'files.openError': '打开失败，请重试',
      'app.cursor': 'Cursor',
    };

    const CSS = `
.dlf-split{box-sizing:border-box;display:inline-flex;align-items:stretch;flex:none;align-self:center;height:24px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);font-family:var(--dsw-font-family)}
.dlf-main{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:3px 5px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}
.dlf-main:hover:not(:disabled),.dlf-main:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dlf-main:disabled{cursor:default}
.dlf-split[data-error] .dlf-main{color:var(--dsw-alias-state-error-primary)}
.dlf-split[data-size=large]{height:36px;border-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dlf-split[data-size=large] .dlf-main{gap:6px;padding:6px 14px;font-size:14px}
.dlf-menuAnchor{flex:none;align-self:center;display:inline-flex}
.dlf-chevron{display:inline-flex;align-items:center;justify-content:center;padding:3px 4px 3px 3px;border:0;border-left:.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dlf-chevron:hover:not(:disabled),.dlf-chevron:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dlf-chevron:disabled{cursor:default}
.dlf-appIcon{object-fit:contain}
`;

    function DownloadIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', strokeWidth: 1,
      },
        h('path', { d: 'M8 1.95317V10.0469', stroke: 'currentColor' }),
        h('path', { d: 'M4.25 6.29688L8 10.0469L11.75 6.29688', stroke: 'currentColor' }),
        h('path', {
          d: 'M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469',
          stroke: 'currentColor',
        }));
    }

    /** Trigger a browser download of `url` without buffering it in JS memory. */
    function startDownload(url) {
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
    async function preflight(url) {
      try {
        return (await fetch(url, { method: 'HEAD' })).ok;
      } catch {
        return false;
      }
    }

    function DownloadButton({ url, large, t }) {
      const [state, setState] = React.useState('idle');
      const timer = React.useRef(undefined);
      React.useEffect(() => () => { clearTimeout(timer.current); }, []);
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
        timer.current = setTimeout(() => { setState('idle'); }, ERROR_MS);
      };
      const size = large ? 18 : 13;
      return h('div', {
        className: 'dlf-split',
        'data-size': large ? 'large' : 'compact',
        'data-download-file': '',
        'data-error': state === 'error' ? '' : undefined,
      }, h('button', {
        type: 'button',
        className: 'dlf-main',
        disabled: state === 'busy',
        title: label,
        'aria-label': large ? undefined : label,
        role: state === 'error' ? 'alert' : undefined,
        onClick,
      }, h(DownloadIcon, { size }), large && h('span', null, label)));
    }

    function FilesIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', strokeWidth: 1,
      },
        h('path', {
          d: 'M1.5 3.5C1.5 2.948 1.948 2.5 2.5 2.5H6L7.5 4.25H13.5C14.052 4.25 14.5 4.698 14.5 5.25V12.5C14.5 13.052 14.052 13.5 13.5 13.5H2.5C1.948 13.5 1.5 13.052 1.5 12.5V3.5Z',
          stroke: 'currentColor',
        }));
    }

    function ChevronIcon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', strokeWidth: 1,
      }, h('path', { d: 'M4 6L8 10L12 6', stroke: 'currentColor' }));
    }

    /** App icon from the stock open-in-app route, with a generic fallback glyph. */
    function AppIcon({ id, size }) {
      const [failed, setFailed] = React.useState(false);
      if (failed) return h(FilesIcon, { size });
      return h('img', {
        src: new URL(`${ICON_ROUTE}/${id}`, document.baseURI).href,
        width: size, height: size, className: 'dlf-appIcon', alt: '', draggable: false,
        onError: () => { setFailed(true); },
      });
    }

    /** Page-lifetime read of the editors the Host can launch (file managers excluded). */
    let appsRead;
    function readApps() {
      appsRead ??= (async () => {
        try {
          const response = await fetch(new URL(APPS_ROUTE, document.baseURI).href, {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) return [];
          const payload = await response.json();
          return Array.isArray(payload.apps)
            ? payload.apps.filter((id) => typeof id === 'string' && !FILE_MANAGERS.has(id)) : [];
        } catch {
          return [];
        }
      })();
      return appsRead;
    }

    function useApps() {
      const [apps, setApps] = React.useState([]);
      React.useEffect(() => {
        let alive = true;
        readApps().then((ids) => { if (alive) setApps(ids); });
        return () => { alive = false; };
      }, []);
      return apps;
    }

    /**
     * Directory-level replacement for the stock "Open in app" control. The
     * default action reveals the sidebar file explorer; remaining launchable
     * editors (e.g. Cursor) stay in the menu. `appsOnly` (inside the Files tab,
     * where "Show files" would be a no-op) renders just the first editor.
     */
    function DirectoryOpen({ cwd, appsOnly, sidebarRight, Menu, t }) {
      const apps = useApps();
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [state, setState] = React.useState('idle');
      const timer = React.useRef(undefined);
      React.useEffect(() => () => { clearTimeout(timer.current); }, []);

      const launch = async (app) => {
        setMenuOpen(false);
        if (state === 'busy' || !cwd) return;
        clearTimeout(timer.current);
        setState('busy');
        let ok = false;
        try {
          ok = (await fetch(new URL(OPEN_ROUTE, document.baseURI).href, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ app, path: cwd }),
          })).ok;
        } catch { /* reported below */ }
        if (ok) { setState('idle'); return; }
        setState('error');
        timer.current = setTimeout(() => { setState('idle'); }, ERROR_MS);
      };
      const showFiles = () => {
        setMenuOpen(false);
        try { sidebarRight.openTab('files'); } catch (error) {
          console.warn('show files rejected:', error);
        }
      };

      const first = apps[0];
      if (appsOnly && first === undefined) return null;
      const error = state === 'error';
      const label = error ? t('files.openError')
        : appsOnly ? `${APP_NAMES[first] ?? first}` : t('files.show');
      const hasMenu = !appsOnly && apps.length > 0 && Menu !== undefined;
      const body = h('div', {
        className: 'dlf-split',
        'data-size': 'compact',
        'data-error': error ? '' : undefined,
        'data-state': state === 'busy' ? 'busy' : 'idle',
      },
      h('button', {
        type: 'button',
        className: 'dlf-main',
        disabled: state === 'busy',
        title: label,
        'aria-label': label,
        role: error ? 'alert' : undefined,
        onClick: appsOnly ? () => { launch(first); } : showFiles,
      }, appsOnly ? h(AppIcon, { id: first, size: 13 }) : h(FilesIcon, { size: 13 })),
      hasMenu && h('button', {
        type: 'button',
        className: 'dlf-chevron',
        disabled: state === 'busy',
        'aria-haspopup': 'menu',
        'aria-expanded': menuOpen,
        'aria-label': t('files.more'),
        onClick: () => { setMenuOpen((value) => !value); },
      }, h(ChevronIcon, { size: 10 })));
      if (!hasMenu) return body;
      return h(Menu, {
        className: 'dlf-menuAnchor',
        open: menuOpen && state !== 'busy',
        autoFocus: true,
        portal: true,
        dense: true,
        align: 'end',
        onClose: () => { setMenuOpen(false); },
        items: [
          { id: 'files', icon: h(FilesIcon, { size: 14 }), label: t('files.default', { app: t('files.show') }) },
          ...apps.map((id) => ({
            id: `app:${id}`, icon: h(AppIcon, { id, size: 14 }), label: APP_NAMES[id] ?? id,
          })),
        ],
        onSelect: (id) => {
          if (id === 'files') showFiles(); else launch(id.slice(4));
        },
        anchor: body,
      });
    }

    /** Download URL for a stock `api/present.open|changes.open?…` action URL. */
    function routeUrl(actionUrl) {
      const from = new URL(actionUrl, document.baseURI);
      const source = from.pathname.endsWith('/changes.open') ? 'changes'
        : from.pathname.endsWith('/present.open') ? 'present' : undefined;
      if (source === undefined) return undefined;
      const to = new URL(ROUTE, document.baseURI);
      to.searchParams.set('source', source);
      for (const key of ['sessionId', 'seq', 'index']) {
        const value = from.searchParams.get(key);
        if (value !== null) to.searchParams.set(key, value);
      }
      return to.href;
    }

    function pathUrl(absolutePath) {
      const to = new URL(ROUTE, document.baseURI);
      to.searchParams.set('path', absolutePath);
      return to.href;
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'download-files: dictionaries');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = 'dsh-docker-adapter';
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => { style.remove(); };
        }, 'download-files: styles');
        const t = ctx.locale.bind(NS);

        // Same primitive the stock control uses; if a future Harness stops
        // exposing it, the editors menu degrades away and "Show files" stays.
        let Menu;
        try { Menu = require('@deepseek-ai/dsh-client-ui-primitives').Menu; } catch { /* no menu */ }

        const cwdOf = (props) => props.useSessions((state) => state.byId[props.sessionId]?.cwd);
        const SessionDirectoryOpen = (props) => h(DirectoryOpen, {
          cwd: cwdOf(props), sidebarRight: ctx.sidebarRight, Menu, t,
        });
        const FilesTabDirectoryOpen = (props) => h(DirectoryOpen, {
          cwd: cwdOf(props), appsOnly: true, sidebarRight: ctx.sidebarRight, Menu, t,
        });

        const FileRouteDownload = (props) => {
          const url = routeUrl(props.actionUrl);
          return url === undefined ? null : h(DownloadButton, { url, t });
        };
        const PathDownload = (props) => (
          typeof props.absolutePath === 'string'
            ? h(DownloadButton, { url: pathUrl(props.absolutePath), t }) : null);
        const PathDownloadProminent = (props) => (
          typeof props.absolutePath === 'string'
            ? h(DownloadButton, { url: pathUrl(props.absolutePath), large: true, t }) : null);

        const slots = {
          'deliverables.file.actions': FileRouteDownload,
          'deliverables.review.file.actions': FileRouteDownload,
          'sidebar.right.tab.document.actions': PathDownload,
          'sidebar.right.tab.document.unpreviewable': PathDownloadProminent,
        };
        for (const [name, component] of Object.entries(slots)) {
          ctx.slots.inject(name, () => ctx.slots.register({
            name, id: STOCK_ID, priority: -1, locale: NS,
          }, component));
        }
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities', id: STOCK_ID, order: -10,
          priority: -1, locale: NS,
        }, SessionDirectoryOpen));
        ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({
          name: 'sidebar.right.tab.files.actions', id: STOCK_ID, priority: -1, locale: NS,
        }, FilesTabDirectoryOpen));
      },
    };
  },
});
