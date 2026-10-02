/**
 * Client half of dsh-docker-adapter. Registers "Download file" buttons in the
 * four slots where the stock open-in-app plugin renders "Show file location".
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

    const en = {
      'download.title': 'Download file',
      'download.error': 'Could not download the file. Try again.',
    };
    const zh = {
      'download.title': '下载文件',
      'download.error': '无法下载文件，请重试',
    };

    const CSS = `
.dlf-split{box-sizing:border-box;display:inline-flex;align-items:stretch;flex:none;align-self:center;height:24px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);font-family:var(--dsw-font-family)}
.dlf-main{display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:3px 5px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer}
.dlf-main:hover:not(:disabled),.dlf-main:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dlf-main:disabled{cursor:default}
.dlf-split[data-error] .dlf-main{color:var(--dsw-alias-state-error-primary)}
.dlf-split[data-size=large]{height:36px;border-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dlf-split[data-size=large] .dlf-main{gap:6px;padding:6px 14px;font-size:14px}
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
      inject: ['slots', 'locale'],
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
      },
    };
  },
});
