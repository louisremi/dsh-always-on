/**
 * Opt-in browser end-to-end suite: `npm run test:e2e`.
 *
 * Drives dist/client.js and the plugin's real Host routes (save, download, create,
 * rename, delete, restore, folder summary and zip; over a fake Harness fs) in headless Chromium against the
 * REAL Monaco build on jsDelivr (needs internet), including a CDN-blocked
 * run, edit conflicts and the iframe sandbox isolation. Not part of
 * `npm test` / CI because it needs a browser and network.
 *
 * Requires: a Chromium (CHROMIUM=/path, default /usr/bin/chromium),
 * `playwright-core` (PLAYWRIGHT_CORE=/path/to/playwright-core), and React 18
 * UMD builds (REACT_UMD / REACT_DOM_UMD, or `npm i --no-save react@18 react-dom@18`).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SaveContext } from '../src/context.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const REACT_UMD = process.env.REACT_UMD ?? require.resolve('react/umd/react.development.js');
const REACT_DOM_UMD =
  process.env.REACT_DOM_UMD ?? require.resolve('react-dom/umd/react-dom.development.js');
const { handleSave } = await import('../src/save-route.ts');
const { handleDownload } = await import('../src/download-route.ts');
const { handleCreateFile, handleCreateFolder } = await import('../src/create-route.ts');
const {
  handleRenameFile,
  handleDeleteFile,
  handleRenameFolder,
  handleDeleteFolder,
  handleRestore,
} = await import('../src/entry-route.ts');
const { handleFolderSummary, handleDownloadFolder } = await import('../src/folder-route.ts');

const dir = mkdtempSync(join(tmpdir(), 'dlf-e2e-'));
const versionOf = (p: string) => {
  const s = statSync(p, { bigint: true });
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`;
};
const writes: string[] = [];
const hostCtx: SaveContext = {
  fs: {
    processPathFromHostPath: (p) => p,
    resolve: async (p) => ({ displayPath: p }),
    stat: async (t) => {
      try {
        const s = statSync(t.displayPath!);
        return { type: s.isFile() ? 'file' : 'directory', size: s.size };
      } catch {
        return undefined;
      }
    },
    writeText: async (t, content, intent) => {
      if (intent?.kind === 'createIfAbsent') {
        mkdirSync(dirname(t.displayPath!), { recursive: true });
        writeFileSync(t.displayPath!, content, { flag: 'wx' });
        return { operation: 'create', version: versionOf(t.displayPath!) };
      }
      if (intent?.kind === 'replaceIfVersion' && intent.version !== versionOf(t.displayPath!))
        throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
      writeFileSync(t.displayPath!, content);
      writes.push(content);
      return { operation: 'update', version: versionOf(t.displayPath!) };
    },
  },
  sessions: { get: (id) => (id === 'sess' ? { id } : undefined) },
  get: () => undefined,
  sandboxPolicy: {
    defaultMode: 'workspace-write',
    workspaceRoot: dir,
    resolve: ({ session }) => ({
      mode: 'workspace-write',
      workspaceRoot: dir,
      sessionId: session.id,
    }),
  },
  workspaceFiles: {
    stat: async (scope, path) => ({
      absolutePath: path.startsWith('/') ? path : join(scope.workspaceRoot, path),
    }),
  },
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#111;--dsw-alias-border-l2:#ccc}
html,body{margin:0;height:100%} #root{width:600px;height:500px}</style></head><body><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/ft.js"></script>
<script>window.__ws=${JSON.stringify(dir)};window.__regs=[];window.__opened=[];window.__closeHandlers={};window.__tabTypes=[];
window.__menus=[];window.__ModuleLoader__={load:(m)=>{window.__mod=m;}};</script>
<script src="/client.js"></script>
<script>
const params=new URLSearchParams(location.search);
const t=(k,v)=>k+(v?JSON.stringify(v):'');
const ctx={effect:(f)=>f(),locale:{register:()=>()=>{},bind:()=>t},
 sidebarRight:{openResource:(a,o)=>window.__opened.push([a,o]),openTab:()=>{},registerCloseHandler:(k,f)=>{window.__closeHandlers[k]=f;return()=>{}},
  tabsIn:()=>window.__tabs||[],closeIn:(s,id)=>{(window.__closed=window.__closed||[]).push(id);}},
 sidebarRightTabs:{register:(d)=>{window.__tabTypes.push(d);return()=>{}}},
 theme:{getTheme:()=>({active:{colorScheme:params.get('dark')?'dark':'light'}})},
 on:()=>()=>{},
 remote:{workspaceFiles:{stat:async(sessionId,path)=>({ok:true,value:{absolutePath:path.startsWith('/')?path:window.__ws+'/'+path}}),readBytes:async(sessionId,path)=>{
   const r=await fetch('/fs/read?path='+encodeURIComponent(path)); if(r.status===404) return {ok:false,error:{code:'workspace-file/not-found'}};
   const j=await r.json(); const bin=atob(j.b64); const data=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)data[i]=bin.charCodeAt(i);
   return {ok:true,value:{data,eof:true,bytes:data.length,version:j.version,absolutePath:path}};}}},
 slots:{inject:(n,f)=>{const r=f();if(r&&typeof r.next==='function')for(const _ of r);},register:(o,c)=>{window.__regs.push([o,c]);}},
 contextMenus:{register:(c)=>{window.__menus.push(c);return()=>{}}},
 sessions:{list:{getSnapshot:()=>({byId:{sess:{cwd:window.__ws}}})}},
 inject:(deps,cb)=>{if(params.get('menus')!=='none')cb(ctx);}};
const exp=window.__mod.factory((s)=>{if(s==='react')return window.React;if(s==='@deepseek-ai/dsh-client-ui-primitives'){if(params.get('prim')==='none'||!window.__ft)throw new Error('missing');return window.__ft;}throw new Error(s)});
exp.apply(ctx);
const reg=(name,key,id)=>window.__regs.find(([o])=>o.name===name&&(key===undefined||o.key===key)&&(id===undefined||o.id===id))[1];
const h=React.createElement;
// The stock menu, reduced to what a plugin sees: resolve a target, run an action by id.
window.__menu=async(target,path)=>{const c=window.__menus.find((m)=>m.target===target);return c?(await c.resolve({sessionId:'sess',path},new AbortController().signal)).map(({run,...a})=>a):[];};
window.__run=async(target,path,id)=>{const c=window.__menus.find((m)=>m.target===target);const a=(await c.resolve({sessionId:'sess',path},new AbortController().signal)).find((x)=>x.id===id);try{await a.run();return 'ok';}catch(e){return 'failed:'+a.failureLabel;}};
{const o=document.createElement('div');o.id='overlay';document.body.appendChild(o);const Overlay=window.__regs.find(([r])=>r.name==='shell.overlay');if(Overlay)ReactDOM.createRoot(o).render(h(Overlay[1],{}));}
const info={tab:{id:'tab1',contentId:params.get('addr'),title:'x',signal:new AbortController().signal,actions:{bindCommands:()=>()=>{}}}};
window.__mountTitles=(titles)=>{
  const Title=reg('sidebar.right.pane.tab.title','@louisremi/dsh-always-on/editor');
  ReactDOM.createRoot(document.getElementById('root')).render(h('div',null,...titles.map((title,i)=>h('div',{key:i,'data-title':title,style:{display:'flex',gap:6,alignItems:'center',height:24}},h(Title,{useTabInfo:()=>({tab:{id:'t'+i,title}}),sessionId:'sess'})))));
};
window.__mount=(what)=>{
  const root=ReactDOM.createRoot(document.getElementById('root'));
  if(what==='editor') root.render(h(reg('sidebar.right.pane.tab',Object.keys({})[0]||'@louisremi/dsh-always-on/editor'),{useTabInfo:()=>info,sessionId:'sess'}));
  else if(what==='newfile'||what==='newfolder') root.render(h(reg('sidebar.right.tab.files.actions',undefined,'@louisremi/dsh-always-on/editor/new-'+what.slice(3)),{sessionId:'sess',absolutePath:params.get('abs')}));
  else root.render(h(reg('sidebar.right.tab.document.actions'),{sessionId:'sess',absolutePath:params.get('abs')}));
};
if(params.get('what')==='titles')window.__mountTitles((params.get('t')||'').split('|'));else window.__mount(params.get('what'));
</script></body></html>`;

// The real FileTypeIcon + classifyFileType source, cut out of the installed Harness' primitives
// bundle (its CSS-module/jsx helpers are shimmed). Absent => the icon test is skipped.
const PRIMITIVES =
  process.env.DSH_PRIMITIVES ??
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js';
let ftModule: string | undefined;
try {
  const lines = readFileSync(PRIMITIVES, 'utf8').split('\n');
  const from = lines.findIndex((l) =>
    l.startsWith('//#region lib/types/code-file-icon-artwork.js'),
  );
  const to = lines.findIndex((l) => l.startsWith('//#region lib/types/SiteGlyph.js'));
  if (from < 0 || to < from) throw new Error('layout changed');
  ftModule = `const React = window.React; const { useId, useMemo, useRef, useState, useEffect } = React;
const jsx = (type, props, key) => { const { children, ...rest } = props ?? {}; return React.createElement(type, key === undefined ? rest : { ...rest, key }, ...(children === undefined ? [] : [].concat(children))); };
const jsxs = jsx; const clsx = (...a) => a.flat(9).filter((x) => typeof x === 'string' && x).join(' ');
const css$20 = new Proxy({}, { get: (_, k) => 'ft-' + String(k) }); const css$21 = css$20; const css$19 = css$20; const css$18 = css$20;
${lines.slice(from, to).join('\n')}
window.__ft = { FileTypeIcon, classifyFileType };`;
} catch {
  ftModule = undefined;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (code: number, body: string | Buffer, type = 'text/plain') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  if (url.pathname === '/') return send(200, PAGE, 'text/html');
  if (url.pathname === '/react.js') return send(200, readFileSync(REACT_UMD), 'text/javascript');
  if (url.pathname === '/react-dom.js')
    return send(200, readFileSync(REACT_DOM_UMD), 'text/javascript');
  if (url.pathname === '/ft.js') return send(200, ftModule ?? '', 'text/javascript');
  if (url.pathname === '/client.js')
    return send(
      200,
      readFileSync(new URL('../dist/client.js', import.meta.url)),
      'text/javascript',
    );
  if (url.pathname === '/fs/read') {
    const p = url.searchParams.get('path') ?? '';
    try {
      const b = readFileSync(p);
      return send(
        200,
        JSON.stringify({ b64: b.toString('base64'), version: versionOf(p) }),
        'application/json',
      );
    } catch {
      return send(404, 'nope');
    }
  }
  if (url.pathname === '/api/download.file') {
    const out = await handleDownload(
      {
        fs: {
          processPathFromHostPath: (p) => p,
          resolve: async (p) => ({ displayPath: p }),
          stat: hostCtx.fs.stat,
          readByteRange: async (t, { offset, length }) =>
            readFileSync(t.displayPath!).subarray(offset, offset + length),
        },
        sandboxPolicy: hostCtx.sandboxPolicy,
        workspaceFiles: hostCtx.workspaceFiles,
        sessionQuery: { readEvent: async () => Promise.reject(new Error('unused')) },
        workspaceChanges: { summary: () => undefined },
      },
      new Request(`http://x${url.pathname}${url.search}`, { method: req.method }),
    );
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  const folderReads: Record<string, typeof handleFolderSummary> = {
    '/api/folder.summary': handleFolderSummary,
    '/api/download.folder': (c, r) => handleDownloadFolder(c, r),
  };
  if (url.pathname in folderReads) {
    const out = await folderReads[url.pathname](
      {
        fs: {
          processPathFromHostPath: (p) => p,
          resolve: async (p) => ({ displayPath: p }),
          stat: hostCtx.fs.stat,
          readByteRange: async () => new Uint8Array(),
        },
        sandboxPolicy: hostCtx.sandboxPolicy,
        workspaceFiles: hostCtx.workspaceFiles,
        sessionQuery: { readEvent: async () => Promise.reject(new Error('unused')) },
        workspaceChanges: { summary: () => undefined },
      },
      new Request(`http://x${url.pathname}${url.search}`, { method: req.method }),
    );
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  const mutations: Record<string, (ctx: SaveContext, r: Request) => Promise<Response>> = {
    '/api/rename.file': handleRenameFile,
    '/api/delete.file': handleDeleteFile,
    '/api/rename.folder': handleRenameFolder,
    '/api/delete.folder': handleDeleteFolder,
    '/api/restore.entry': handleRestore,
  };
  if (url.pathname in mutations) {
    const body = await new Promise<Buffer>((r) => {
      const c: Buffer[] = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => r(Buffer.concat(c)));
    });
    const out = await mutations[url.pathname](
      hostCtx,
      new Request(`http://x${url.pathname}`, { method: 'POST', body: new Uint8Array(body) }),
    );
    return send(out.status, await out.text(), 'application/json');
  }
  if (url.pathname === '/api/create.file' || url.pathname === '/api/create.folder') {
    const body = await new Promise<Buffer>((r) => {
      const c: Buffer[] = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => r(Buffer.concat(c)));
    });
    const handle = url.pathname === '/api/create.file' ? handleCreateFile : handleCreateFolder;
    const out = await handle(
      hostCtx,
      new Request(`http://x${url.pathname}`, { method: 'POST', body: new Uint8Array(body) }),
    );
    return send(out.status, await out.text(), 'application/json');
  }
  if (url.pathname === '/api/save.file') {
    const body = await new Promise<Buffer>((r) => {
      const c: Buffer[] = [];
      req.on('data', (d) => c.push(d));
      req.on('end', () => r(Buffer.concat(c)));
    });
    const out = await handleSave(
      hostCtx,
      new Request('http://x/api/save.file', {
        method: req.method,
        body: body.length ? new Uint8Array(body) : undefined,
      }),
    );
    return send(out.status, await out.text(), 'application/json');
  }
  send(404, 'not found');
});
await new Promise<void>((r) => {
  server.listen(0, '127.0.0.1', () => r());
});
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--no-sandbox'],
});
const results: [string, string, string?, string[]?][] = [];
const check = async (name: string, fn: (page: any, logs: string[]) => Promise<void>) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const logs: string[] = [];
  page.on('console', (m: any) => {
    if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e: any) => logs.push(`pageerror: ${e.message}`));
  try {
    await fn(page, logs);
    results.push(['PASS', name]);
  } catch (e) {
    results.push([
      'FAIL',
      name,
      (e as Error).message.split('\n').slice(0, 8).join(' / '),
      logs.slice(0, 6),
    ]);
  }
  await context.close();
};
const addr = (file: string) =>
  `dsh-resource://file/session/sess/${encodeURIComponent(file).replace(/%2F/g, '/')}`;
const open = (page: any, file: string, extra = '') =>
  page.goto(`${base}/?what=editor&addr=${encodeURIComponent(addr(file))}${extra}`);
const monacoFrame = async (page: any) => {
  const handle = await page.waitForSelector('iframe.dlf-ed-frame', { timeout: 15000 });
  const frame = await handle.contentFrame();
  await frame.waitForSelector('.monaco-editor', { timeout: 60000 });
  return frame;
};

await check('Edit button opens the editor tab type with a session file address', async (page) => {
  const f = join(dir, 'btn.txt');
  writeFileSync(f, 'x');
  await page.goto(`${base}/?what=button&abs=${encodeURIComponent(f)}`);
  await page.waitForSelector('[data-edit-file] button');
  assert.ok(await page.$('[data-download-file] button'), 'download button also present');
  await page.click('[data-edit-file] button');
  const [[address, opts]] = await page.evaluate(() => window.__opened);
  assert.equal(opts.kind, 'dlf-editor');
  assert.equal(address, addr(f));
  const tabType = await page.evaluate(() => ({
    kind: window.__tabTypes[0].kind,
    priority: window.__tabTypes[0].priority,
    keep: window.__tabTypes[0].keepMounted,
    patterns: window.__tabTypes[0].patterns,
  }));
  assert.deepEqual(tabType, {
    kind: 'dlf-editor',
    priority: 'fallback',
    keep: true,
    patterns: undefined,
  });
});

await check('Edit button hidden for binary extensions', async (page) => {
  await page.goto(`${base}/?what=button&abs=${encodeURIComponent('/w/pic.PNG')}`);
  await page.waitForSelector('[data-download-file] button');
  assert.equal(await page.$('[data-edit-file]'), null);
});

await check(
  'real Monaco loads from the CDN inside the sandboxed iframe, edits and saves with Ctrl+S',
  async (page, logs) => {
    const f = join(dir, 'real.js');
    writeFileSync(f, 'const a = 1;\r\nconst b = 2;\r\n');
    await open(page, f);
    const frame = await monacoFrame(page);
    const sandbox = await page.getAttribute('iframe.dlf-ed-frame', 'sandbox');
    assert.equal(sandbox, 'allow-scripts');
    assert.equal(await page.$('.dlf-ed-note'), null, 'no plain-text notice when Monaco works');
    await frame.waitForFunction(
      () =>
        /const a = 1;/.test(
          document.querySelector('.view-lines')!.textContent!.replace(/\u00a0/g, ' '),
        ),
      null,
      { timeout: 15000 },
    );
    await frame.click('.monaco-editor .view-lines');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('// edited');
    await page.waitForFunction(() => document.querySelector('.dlf-ed-dot'), null, {
      timeout: 5000,
    });
    assert.equal(await page.isDisabled('.dlf-ed-bar .dlf-ed-btn'), false);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(
      () => /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''),
      null,
      { timeout: 8000 },
    );
    const onDisk = readFileSync(f, 'utf8');
    assert.match(onDisk, /\/\/ edited/);
    assert.ok(
      onDisk.includes('\r\n') && !/[^\r]\n/.test(onDisk),
      `CRLF line endings preserved: ${JSON.stringify(onDisk)}`,
    );
    assert.equal(await page.$('.dlf-ed-dot'), null, 'dirty marker cleared after save');
    const csp = logs.filter((l) => /Content Security Policy|Refused/.test(l));
    assert.deepEqual(csp, [], 'no CSP violations');
  },
);

await check('Save button saves; second edit after save uses the fresh version', async (page) => {
  const f = join(dir, 'twice.txt');
  writeFileSync(f, 'one');
  await open(page, f, '&dark=1');
  const frame = await monacoFrame(page);
  await frame.click('.monaco-editor .view-lines');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' two');
  await page.click('.dlf-ed-bar .dlf-ed-btn');
  await page.waitForFunction(
    () => /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''),
    null,
    { timeout: 8000 },
  );
  assert.equal(readFileSync(f, 'utf8'), 'one two');
  // No re-click: focus must already be back in the editor after pressing the Save button.
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' three');
  await page.waitForFunction(() => document.querySelector('.dlf-ed-dot'));
  await page.click('.dlf-ed-bar .dlf-ed-btn');
  await page.waitForFunction(
    () => /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''),
    null,
    { timeout: 8000 },
  );
  assert.equal(readFileSync(f, 'utf8'), 'one two three');
  assert.equal(
    await frame.evaluate(() =>
      document.querySelector('.monaco-editor')!.classList.contains('vs-dark'),
    ),
    true,
    'dark theme applied',
  );
});

await check(
  'editor header shows size and modification time, refreshed after save',
  async (page) => {
    const f = join(dir, 'info.txt');
    writeFileSync(f, 'x'.repeat(2048));
    // Plain-text editor (CDN blocked): fast and network-independent.
    await page.route('https://cdn.jsdelivr.net/**', (route: any) => route.abort());
    await open(page, f);
    await page.waitForSelector('[data-dlf-info]', { timeout: 15000 });
    const first = await page.textContent('[data-dlf-info]');
    assert.match(first, /^editor\.info\{"size":"2\.0 KiB","modified":"[^"]+"\}$/);
    await page.waitForSelector('textarea.dlf-ed-text', { timeout: 30000 });
    await page.click('textarea.dlf-ed-text');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('yy');
    await page.click('.dlf-ed-bar .dlf-ed-btn');
    await page.waitForFunction(
      () =>
        /"size":"2\.0 KiB"/.test(document.querySelector('[data-dlf-info]')?.textContent ?? '') &&
        /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''),
      null,
      { timeout: 8000 },
    );
    assert.equal(readFileSync(f, 'utf8').length, 2050);
    await page.waitForFunction(
      () => (document.querySelector('[data-dlf-info]')?.getAttribute('title') ?? '') !== '',
    );
  },
);

await check(
  'New file: dialog validates, refuses an existing name, creates and opens the editor',
  async (page) => {
    writeFileSync(join(dir, 'exists.txt'), 'keep');
    await page.goto(`${base}/?what=newfile&abs=${encodeURIComponent(dir)}`);
    await page.click('[data-new-file]');
    await page.waitForSelector('[data-dlf-dialog] input');
    // Invalid name: inline error, Create disabled, nothing sent.
    await page.fill('[data-dlf-dialog] input', '../escape.txt');
    await page.waitForSelector('[data-dlf-dialog] [role=alert]');
    assert.equal(await page.isDisabled('[data-dlf-dialog] button[type=submit]'), true);
    // Existing name: the Host answers 409, the dialog stays open with a message.
    await page.fill('[data-dlf-dialog] input', 'exists.txt');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await page.waitForFunction(() =>
      /create\.exists/.test(
        document.querySelector('[data-dlf-dialog] [role=alert]')?.textContent ?? '',
      ),
    );
    assert.equal(readFileSync(join(dir, 'exists.txt'), 'utf8'), 'keep');
    // A valid nested name: created empty, dialog closes, the editor opens on it.
    await page.fill('[data-dlf-dialog] input', 'made/new.md');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await page.waitForFunction(() => !document.querySelector('[data-dlf-dialog]'));
    assert.equal(readFileSync(join(dir, 'made/new.md'), 'utf8'), '');
    const opened = await page.evaluate(() => (window as any).__opened);
    assert.deepEqual(opened.at(-1), [
      `dsh-resource://file/session/sess/${join(dir, 'made/new.md').split('/').map(encodeURIComponent).join('/')}`,
      { kind: 'dlf-editor' },
    ]);
    // Escape closes without creating anything.
    await page.click('[data-new-file]');
    await page.fill('[data-dlf-dialog] input', 'never.txt');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-dlf-dialog]'));
    assert.throws(() => readFileSync(join(dir, 'never.txt')));
  },
);

await check(
  'New folder: creates nested folders, refuses existing names, opens no editor',
  async (page) => {
    await page.goto(`${base}/?what=newfolder&abs=${encodeURIComponent(dir)}`);
    await page.click('[data-new-folder]');
    await page.fill('[data-dlf-dialog] input', 'docs/drafts');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await page.waitForFunction(() => !document.querySelector('[data-dlf-dialog]'));
    assert.ok(statSync(join(dir, 'docs/drafts')).isDirectory());
    assert.deepEqual(await page.evaluate(() => (window as any).__opened), []);
    await page.click('[data-new-folder]');
    await page.fill('[data-dlf-dialog] input', 'docs');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await page.waitForFunction(() =>
      /create\.exists/.test(
        document.querySelector('[data-dlf-dialog] [role=alert]')?.textContent ?? '',
      ),
    );
  },
);

/** Pick an action of our menu contribution, as the stock context menu does on a click. */
const menuRun = (page: any, target: 'file' | 'directory', path: string, id: string) =>
  page.evaluate(([t, p, i]: string[]) => (window as any).__run(t, p, i), [target, path, id]);
const menuOf = (page: any, target: 'file' | 'directory', path: string) =>
  page.evaluate(([t, p]: string[]) => (window as any).__menu(t, p), [target, path]);

const fileAddr = (p: string) =>
  `dsh-resource://file/session/sess/${p.split('/').map(encodeURIComponent).join('/')}`;

await check(
  'Rename: moves the file, refuses taken names, reopens it and closes old tabs',
  async (page) => {
    const f = join(dir, 'ren.txt');
    writeFileSync(f, 'r');
    writeFileSync(join(dir, 'taken-ren.txt'), 'keep');
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(f)}`);
    await page.evaluate((a: string) => {
      (window as any).__tabs = [{ id: 'p1', kind: 'text', contentId: a }];
    }, fileAddr(f));
    await menuRun(page, 'file', f, 'rename');
    const value = await page.inputValue('[data-dlf-dialog] input');
    assert.equal(value, 'ren.txt');
    // Stem selected, extension not.
    assert.equal(
      await page.evaluate(() => {
        const i = document.querySelector('[data-dlf-dialog] input') as HTMLInputElement;
        return [i.selectionStart, i.selectionEnd].join(',');
      }),
      '0,3',
    );
    await page.fill('[data-dlf-dialog] input', 'taken-ren.txt');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await page.waitForFunction(() =>
      /create\.exists/.test(
        document.querySelector('[data-dlf-dialog] [role=alert]')?.textContent ?? '',
      ),
    );
    assert.equal(readFileSync(join(dir, 'taken-ren.txt'), 'utf8'), 'keep');
    await page.fill('[data-dlf-dialog] input', 'moved/ren2.txt');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await page.waitForFunction(() => !document.querySelector('[data-dlf-dialog]'));
    assert.equal(readFileSync(join(dir, 'moved/ren2.txt'), 'utf8'), 'r');
    assert.throws(() => readFileSync(f));
    assert.deepEqual(await page.evaluate(() => (window as any).__closed), ['p1']);
    assert.deepEqual((await page.evaluate(() => (window as any).__opened)).at(-1), [
      fileAddr(join(dir, 'moved/ren2.txt')),
      {},
    ]);
  },
);

await check(
  'Delete: confirms, deletes, closes tabs; blocked while an editor is dirty',
  async (page) => {
    const f = join(dir, 'del.txt');
    writeFileSync(f, 'd');
    // A dirty editor tab on this file blocks the delete.
    await page.route('https://cdn.jsdelivr.net/**', (route: any) => route.abort());
    await page.goto(`${base}/?what=editor&addr=${encodeURIComponent(fileAddr(f))}`);
    await page.waitForSelector('textarea.dlf-ed-text', { timeout: 30000 });
    await page.click('textarea.dlf-ed-text');
    await page.keyboard.type('x');
    await page.waitForFunction(() => document.querySelector('.dlf-ed-dot'));
    await page.evaluate(
      ([a, path]: string[]) => {
        (window as any).__tabs = [{ id: 'tab1', kind: 'dlf-editor', contentId: a }];
        const host = document.createElement('div');
        host.id = 'actions';
        document.body.appendChild(host);
        (window as any).ReactDOM.createRoot(host).render(
          (window as any).React.createElement(
            (window as any).__regs.find(
              ([o]: any) => o.name === 'sidebar.right.tab.document.actions',
            )[1],
            { sessionId: 'sess', absolutePath: path },
          ),
        );
      },
      [fileAddr(f), f],
    );
    await menuRun(page, 'file', f, 'delete');
    await page.click('[data-dlf-dialog] button[type=submit]');
    await page.waitForFunction(() =>
      /entry\.dirty/.test(
        document.querySelector('[data-dlf-dialog] [role=alert]')?.textContent ?? '',
      ),
    );
    assert.equal(readFileSync(f, 'utf8'), 'd');
    await page.keyboard.press('Escape');
    // A clean page (no dirty editor): deletes and closes the preview tab.
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(f)}`);
    await page.evaluate((a: string) => {
      (window as any).__tabs = [{ id: 'p9', kind: 'text', contentId: a }];
    }, fileAddr(f));
    await menuRun(page, 'file', f, 'delete');
    assert.match(
      await page.textContent('[data-dlf-dialog]'),
      /delete\.question\{"name":"del\.txt"\} delete\.trashNote/,
    );
    await page.click('[data-dlf-dialog] button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('[data-dlf-dialog]'));
    assert.throws(() => readFileSync(f));
    assert.deepEqual(await page.evaluate(() => (window as any).__closed), ['p9']);
    // The Restore toast brings it back and reopens its tab.
    await page.waitForSelector('[data-dlf-toast=deleted]');
    assert.match(await page.textContent('[data-dlf-toast]'), /delete\.doneFile.*restore\.file/);
    await page.click('[data-dlf-restore]');
    await page.waitForSelector('[data-dlf-toast=restored]');
    assert.equal(readFileSync(f, 'utf8'), 'd');
    assert.deepEqual((await page.evaluate(() => (window as any).__opened)).at(-1), [
      fileAddr(f),
      {},
    ]);
  },
);

await check(
  'Rename/Delete only touch tabs of THIS file: a relative tab of a same-named file elsewhere is kept',
  async (page) => {
    mkdirSync(join(dir, 'twin'), { recursive: true });
    const f = join(dir, 'twin', 'same.txt');
    writeFileSync(f, 's');
    writeFileSync(join(dir, 'same.txt'), 'other');
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(f)}`);
    await page.evaluate(
      ([mine, other]: string[]) => {
        (window as any).__tabs = [
          { id: 'mine', kind: 'text', contentId: mine },
          { id: 'other', kind: 'text', contentId: other },
        ];
      },
      [fileAddr('twin/same.txt'), fileAddr('same.txt')],
    );
    await menuRun(page, 'file', f, 'delete');
    await page.click('[data-dlf-dialog] button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('[data-dlf-dialog]'));
    assert.throws(() => readFileSync(f));
    assert.equal(readFileSync(join(dir, 'same.txt'), 'utf8'), 'other');
    assert.deepEqual(await page.evaluate(() => (window as any).__closed), ['mine']);
  },
);

await check(
  'Menus: file and folder entries, root folder protected, toolbar has no Rename/Delete',
  async (page) => {
    const f = join(dir, 'menu.txt');
    writeFileSync(f, 'm');
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(f)}`);
    const ids = (items: any[]) => items.map((i) => `${i.id}${i.disabled ? '!' : ''}`);
    assert.deepEqual(ids(await menuOf(page, 'file', f)), ['rename', 'delete']);
    // A relative tree path resolves against the session's workspace.
    assert.deepEqual(ids(await menuOf(page, 'file', 'menu.txt')), ['rename', 'delete']);
    assert.deepEqual(ids(await menuOf(page, 'directory', join(dir, 'twin'))), [
      'rename',
      'delete',
      'zip',
    ]);
    assert.deepEqual(ids(await menuOf(page, 'directory', dir)), ['rename!', 'delete!', 'zip']);
    const del = (await menuOf(page, 'file', f)).find((i: any) => i.id === 'delete');
    assert.equal(del.danger, true);
    assert.deepEqual(del.icon, { key: 'always-on.delete' });
    // The preview toolbar keeps Edit + Download only.
    assert.equal(
      await page.$$eval('[data-edit-file],[data-download-file]', (e: any[]) => e.length),
      2,
    );
    assert.equal(await page.$('[data-rename-file],[data-delete-file]'), null);
    // Without the stock context menu, the rest still loads.
    await page.goto(`${base}/?what=actions&menus=none&abs=${encodeURIComponent(f)}`);
    await page.waitForSelector('[data-download-file]');
    assert.equal(await page.evaluate(() => (window as any).__menus.length), 0);
  },
);

await check(
  'Stock "no desktop" note above presented files is hidden; own slot ids, no stock shadowing',
  async (page) => {
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(join(dir, 'menu.txt'))}`);
    const shown = await page.evaluate(() => {
      const box = document.createElement('div');
      box.innerHTML =
        '<span id="note">This Host has no desktop…</span><div data-presented-files-row></div><span id="other">x</span>';
      document.body.appendChild(box);
      const visible = (id: string) =>
        getComputedStyle(document.getElementById(id)!).display !== 'none';
      return [visible('note'), visible('other')];
    });
    assert.deepEqual(shown, [false, true]);
    const ids = await page.evaluate(() =>
      (window as any).__regs.map(([o]: any) => `${o.name}:${o.id ?? o.key}:${o.priority ?? ''}`),
    );
    assert.ok(!ids.some((i: string) => /:open-in-app:/.test(i)), ids.join(' '));
    assert.ok(
      ids.includes('conversation.session.header.utilities:@louisremi/dsh-always-on/show-files:'),
    );
  },
);

await check(
  'Folder rename: moves the tree, refuses taken names and moves into itself, retargets tabs',
  async (page) => {
    const d = join(dir, 'fold');
    mkdirSync(join(d, 'in'), { recursive: true });
    writeFileSync(join(d, 'in', 'x.txt'), 'x');
    mkdirSync(join(dir, 'fold-taken'));
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(join(d, 'in', 'x.txt'))}`);
    await page.evaluate(
      ([a, b]: string[]) => {
        (window as any).__tabs = [
          { id: 'abs', kind: 'text', contentId: a },
          { id: 'rel', kind: 'text', contentId: b },
          { id: 'sib', kind: 'text', contentId: 'dsh-resource://file/session/sess/fold-taken.txt' },
        ];
      },
      [fileAddr(join(d, 'in', 'x.txt')), fileAddr('fold/in/x.txt')],
    );
    await menuRun(page, 'directory', d, 'rename');
    assert.match(await page.textContent('[data-dlf-dialog] h2'), /rename\.folderTitle/);
    assert.equal(await page.inputValue('[data-dlf-dialog] input'), 'fold');
    for (const [name, error] of [
      ['fold-taken', /create\.exists/],
      ['fold/in/deeper', /rename\.intoItself/],
    ] as const) {
      await page.fill('[data-dlf-dialog] input', name);
      await page.press('[data-dlf-dialog] input', 'Enter');
      await page.waitForFunction(
        (src: string) =>
          new RegExp(src).test(
            document.querySelector('[data-dlf-dialog] [role=alert]')?.textContent ?? '',
          ),
        error.source,
      );
    }
    await page.fill('[data-dlf-dialog] input', 'moved/fold2');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await page.waitForFunction(() => !document.querySelector('[data-dlf-dialog]'));
    assert.equal(readFileSync(join(dir, 'moved/fold2/in/x.txt'), 'utf8'), 'x');
    assert.deepEqual(await page.evaluate(() => (window as any).__closed), ['abs', 'rel']);
    const opened = (await page.evaluate(() => (window as any).__opened)).slice(-2);
    assert.deepEqual(opened, [
      [fileAddr(join(dir, 'moved/fold2/in/x.txt')), {}],
      [fileAddr(join(dir, 'moved/fold2/in/x.txt')), {}],
    ]);
  },
);

await check(
  'Folder delete: counts the contents, refuses a dirty editor inside, trashes, restores',
  async (page) => {
    const d = join(dir, 'gone-dir');
    mkdirSync(join(d, 'sub'), { recursive: true });
    writeFileSync(join(d, 'a.txt'), 'aa');
    writeFileSync(join(d, 'sub', 'b.txt'), 'bbb');
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(join(d, 'a.txt'))}`);
    // A dirty editor tab on a file inside blocks the delete.
    await page.evaluate((a: string) => {
      (window as any).__tabs = [{ id: 'tab1', kind: 'dlf-editor', contentId: a }];
    }, fileAddr('gone-dir/sub/b.txt'));
    await page.route('https://cdn.jsdelivr.net/**', (route: any) => route.abort());
    await page.evaluate(
      (a: string) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const w = window as any;
        const Body = w.__regs.find(([o]: any) => o.name === 'sidebar.right.pane.tab')[1];
        const tab = {
          id: 'tab1',
          contentId: a,
          title: 'b.txt',
          signal: new AbortController().signal,
          actions: { bindCommands: () => () => {} },
        };
        w.ReactDOM.createRoot(host).render(
          w.React.createElement(Body, { useTabInfo: () => ({ tab }), sessionId: 'sess' }),
        );
      },
      fileAddr(join(d, 'sub', 'b.txt')),
    );
    await page.waitForSelector('textarea.dlf-ed-text', { timeout: 30000 });
    await page.click('textarea.dlf-ed-text');
    await page.keyboard.type('x');
    await page.waitForFunction(() => document.querySelector('.dlf-ed-dot'));
    await menuRun(page, 'directory', d, 'delete');
    await page.waitForFunction(() =>
      /delete\.folderContents\{"name":"gone-dir","files":2,"folders":1,"size":"5 B"\}/.test(
        document.querySelector('[data-dlf-dialog]')?.textContent ?? '',
      ),
    );
    await page.click('[data-dlf-dialog] button[type=submit]');
    await page.waitForFunction(() =>
      /entry\.dirtyFolder/.test(
        document.querySelector('[data-dlf-dialog] [role=alert]')?.textContent ?? '',
      ),
    );
    assert.equal(readFileSync(join(d, 'a.txt'), 'utf8'), 'aa');
    await page.keyboard.press('Escape');
    // Clean: deleted into the trash, tabs closed, Restore brings it back.
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(join(d, 'a.txt'))}`);
    await page.evaluate(
      (a: string) => {
        (window as any).__tabs = [{ id: 'in', kind: 'text', contentId: a }];
      },
      fileAddr(join(d, 'sub', 'b.txt')),
    );
    await menuRun(page, 'directory', d, 'delete');
    await page.waitForFunction(() =>
      /delete\.folderContents/.test(document.querySelector('[data-dlf-dialog]')?.textContent ?? ''),
    );
    await page.click('[data-dlf-dialog] button[type=submit]');
    await page.waitForSelector('[data-dlf-toast=deleted]');
    assert.throws(() => statSync(d));
    assert.deepEqual(await page.evaluate(() => (window as any).__closed), ['in']);
    assert.match(await page.textContent('[data-dlf-toast]'), /delete\.doneFolder.*restore\.folder/);
    await page.click('[data-dlf-restore]');
    await page.waitForSelector('[data-dlf-toast=restored]');
    assert.equal(readFileSync(join(d, 'sub', 'b.txt'), 'utf8'), 'bbb');
  },
);

await check('Delete: a folder holding a mounted volume names it in the dialog', async (page) => {
  const d = join(dir, 'holds-mount');
  mkdirSync(join(d, 'vol'), { recursive: true });
  await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(d)}`);
  await page.route('**/api/folder.summary*', (route: any) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: 0,
        folders: 1,
        bytes: 0,
        truncated: false,
        mounts: ['vol'],
        downloadable: true,
      }),
    }),
  );
  await menuRun(page, 'directory', d, 'delete');
  await page.waitForFunction(() =>
    /delete\.mounts\{"mounts":"vol"\}/.test(
      document.querySelector('[data-dlf-dialog]')?.textContent ?? '',
    ),
  );
  await page.keyboard.press('Escape');
  assert.ok(statSync(join(d, 'vol')).isDirectory());
});

await check('Delete: a mount point says so instead of blaming the Host path', async (page) => {
  const d = join(dir, 'mounted');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'f.txt'), 'f');
  await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(join(d, 'f.txt'))}`);
  await page.route('**/api/delete.folder', (route: any) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'a mount point cannot be moved to the trash' }),
    }),
  );
  await menuRun(page, 'directory', d, 'delete');
  await page.click('[data-dlf-dialog] button[type=submit]');
  await page.waitForFunction(() =>
    /entry\.mountPoint/.test(
      document.querySelector('[data-dlf-dialog] [role=alert]')?.textContent ?? '',
    ),
  );
  assert.equal(readFileSync(join(d, 'f.txt'), 'utf8'), 'f');
});

await check(
  'Restore toast: only the last deletion, gone after 10 s, held while hovered',
  async (page) => {
    for (const n of ['t1.txt', 't2.txt', 't3.txt']) writeFileSync(join(dir, n), n);
    mkdirSync(join(dir, 'empty-dir'), { recursive: true });
    await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(join(dir, 't1.txt'))}`);
    const del = async (target: 'file' | 'directory', path: string) => {
      await menuRun(page, target, path, 'delete');
      await page.click('[data-dlf-dialog] button[type=submit]');
      await page.waitForFunction(() => !document.querySelector('[data-dlf-dialog]'));
    };
    await del('file', join(dir, 't1.txt'));
    await del('directory', join(dir, 'empty-dir'));
    assert.equal(await page.$$eval('[data-dlf-toast]', (e: any[]) => e.length), 1);
    assert.match(await page.textContent('[data-dlf-toast]'), /empty-dir/);
    await page.click('[data-dlf-restore]');
    await page.waitForSelector('[data-dlf-toast=restored]');
    assert.ok(statSync(join(dir, 'empty-dir')).isDirectory());
    assert.throws(() => statSync(join(dir, 't1.txt')), 'only the last deletion is restored');
    // Hovered, it stays past 10 s; left alone, it goes.
    await del('file', join(dir, 't2.txt'));
    await page.hover('[data-dlf-toast]');
    await page.waitForTimeout(10_500);
    assert.ok(await page.$('[data-dlf-toast=deleted]'), 'held while hovered');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(10_500);
    assert.equal(await page.$('[data-dlf-toast]'), null);
    // Restoring onto a name taken again is refused, the file stays in the trash.
    await del('file', join(dir, 't3.txt'));
    writeFileSync(join(dir, 't3.txt'), 'new');
    await page.click('[data-dlf-restore]');
    await page.waitForSelector('[data-dlf-toast=failed]');
    assert.match(await page.textContent('[data-dlf-toast]'), /restore\.taken/);
    assert.equal(readFileSync(join(dir, 't3.txt'), 'utf8'), 'new');
  },
);

await check('Download as .zip: starts a download of the folder archive', async (page) => {
  const d = join(dir, 'zipped');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'z.txt'), 'z');
  await page.goto(`${base}/?what=actions&abs=${encodeURIComponent(join(d, 'z.txt'))}`);
  const [download, outcome] = await Promise.all([
    page.waitForEvent('download'),
    menuRun(page, 'directory', d, 'zip'),
  ]);
  assert.equal(outcome, 'ok');
  assert.equal(download.suggestedFilename(), 'zipped.zip');
  const gone = await menuRun(page, 'directory', join(dir, 'no-such-folder'), 'zip');
  assert.match(gone, /^failed:menu\.downloadFailed/);
});

await check(
  'New file: Host errors get specific messages (gone folder, gone session)',
  async (page) => {
    await page.goto(`${base}/?what=newfile&abs=${encodeURIComponent(join(dir, 'no-such-dir'))}`);
    const reply = (status: number, error: string) =>
      page.route('**/api/create.file', (route: any) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error }) }),
      );
    const alert = (re: RegExp) =>
      page.waitForFunction(
        (src: string) =>
          new RegExp(src).test(
            document.querySelector('[data-dlf-dialog] [role=alert]')?.textContent ?? '',
          ),
        re.source,
      );
    await page.click('[data-new-file]');
    await reply(404, 'not found');
    await page.fill('[data-dlf-dialog] input', 'x.txt');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await alert(/create\.noFolder/);
    await page.unroute('**/api/create.file');
    await reply(404, 'session not found');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await alert(/mutation\.noSession/);
    await page.unroute('**/api/create.file');
    await reply(422, 'path has no verified Host path');
    await page.press('[data-dlf-dialog] input', 'Enter');
    await alert(/mutation\.unmapped/);
  },
);

await check(
  'external change → 409 conflict banner; Overwrite then wins; file never clobbered silently',
  async (page) => {
    const f = join(dir, 'conflict.txt');
    writeFileSync(f, 'base');
    await open(page, f);
    const frame = await monacoFrame(page);
    writeFileSync(f, 'changed on disk by someone else');
    await frame.click('.monaco-editor .view-lines');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('!');
    await page.keyboard.press('Control+s');
    await page.waitForSelector('.dlf-ed-banner');
    assert.equal(readFileSync(f, 'utf8'), 'changed on disk by someone else');
    const buttons = await page.$$eval('.dlf-ed-banner button', (b: any[]) =>
      b.map((x) => x.textContent),
    );
    assert.deepEqual(buttons, ['editor.reload', 'editor.overwrite', 'editor.keep']);
    await page.click('.dlf-ed-banner button:nth-of-type(2)');
    // The banner goes as soon as the save STARTS; the file is written when it says Saved.
    await page.waitForFunction(
      () =>
        !document.querySelector('.dlf-ed-banner') &&
        /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''),
    );
    assert.equal(readFileSync(f, 'utf8'), 'base!');
  },
);

await check('conflict → Reload from disk replaces the buffer', async (page) => {
  const f = join(dir, 'reload.txt');
  writeFileSync(f, 'v1');
  await open(page, f);
  const frame = await monacoFrame(page);
  writeFileSync(f, 'v2 from disk');
  await frame.click('.monaco-editor .view-lines');
  await page.keyboard.type('zzz');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.dlf-ed-banner');
  await page.click('.dlf-ed-banner button:nth-of-type(1)');
  await page.waitForFunction(() => !document.querySelector('.dlf-ed-banner'));
  await frame.waitForFunction(
    () =>
      /v2 from disk/.test(
        document.querySelector('.view-lines')!.textContent!.replace(/\u00a0/g, ' '),
      ),
    null,
    { timeout: 15000 },
  );
  assert.equal(await page.$('.dlf-ed-dot'), null);
  assert.equal(readFileSync(f, 'utf8'), 'v2 from disk');
});

await check(
  'CDN unreachable → plain textarea fallback still edits and saves (CRLF kept)',
  async (page) => {
    const f = join(dir, 'plain.txt');
    writeFileSync(f, 'a\r\nb\r\n');
    await page.route('https://cdn.jsdelivr.net/**', (route: any) => route.abort());
    await open(page, f);
    await page.waitForSelector('textarea.dlf-ed-text', { timeout: 20000 });
    assert.ok(await page.$('.dlf-ed-note'), 'plain-text notice shown');
    await page.fill('textarea.dlf-ed-text', 'a\nb\nc\n');
    await page.waitForSelector('.dlf-ed-dot');
    await page.press('textarea.dlf-ed-text', 'Control+s');
    await page.waitForFunction(
      () => /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''),
      null,
      { timeout: 8000 },
    );
    assert.equal(readFileSync(f, 'utf8'), 'a\r\nb\r\nc\r\n');
  },
);

await check(
  'binary / oversized / missing files are refused with a message, never opened',
  async (page) => {
    const bin = join(dir, 'x.dat');
    writeFileSync(bin, Buffer.from([1, 2, 0, 3, 4]));
    await open(page, bin);
    await page.waitForSelector('.dlf-ed-msg');
    assert.match(await page.textContent('.dlf-ed-msg'), /editor\.notText/);
    const huge = join(dir, 'huge.txt');
    writeFileSync(huge, 'x'.repeat(1024 * 1024 + 5));
    await open(page, huge);
    await page.waitForFunction(() =>
      /editor\.tooLarge/.test(document.querySelector('.dlf-ed-msg')?.textContent ?? ''),
    );
    await open(page, join(dir, 'missing.txt'));
    await page.waitForFunction(() =>
      /editor\.gone/.test(document.querySelector('.dlf-ed-msg')?.textContent ?? ''),
    );
  },
);

await check('close handler: confirm discards or keeps a dirty tab', async (page) => {
  const f = join(dir, 'close.txt');
  writeFileSync(f, 'q');
  await page.route('https://cdn.jsdelivr.net/**', (route: any) => route.abort());
  await open(page, f);
  await page.waitForSelector('textarea.dlf-ed-text', { timeout: 20000 });
  await page.fill('textarea.dlf-ed-text', 'dirty');
  await page.waitForSelector('.dlf-ed-dot');
  let asked = 0;
  let answer = false;
  page.on('dialog', (d: any) => {
    asked += 1;
    answer ? d.accept() : d.dismiss();
  });
  const closeCall = () =>
    page.evaluate(() => {
      try {
        window.__closeHandlers['dlf-editor']('sess', { id: 'tab1', title: 'close.txt' });
        return 'closed';
      } catch (e) {
        return `kept: ${(e as Error).message}`;
      }
    });
  assert.match(await closeCall(), /^kept: close cancelled/);
  answer = true;
  assert.equal(await closeCall(), 'closed');
  assert.equal(asked, 2);
});

await check(
  'sandbox isolation: CDN code in the frame cannot reach the page, its storage, or other origins',
  async (page) => {
    const f = join(dir, 'iso.txt');
    writeFileSync(f, 'secret-ish');
    await open(page, f);
    // The isolation test plants a secret in the parent document on purpose.
    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noDocumentCookie: parent-side bait for the iframe isolation probe
      document.cookie = 'dsh=top-secret';
      localStorage.setItem('k', 'v');
    });
    const frame = await monacoFrame(page);
    const probe = await frame.evaluate(async () => {
      const out: Record<string, unknown> = {};
      try {
        out.parentDom = typeof parent.document.cookie;
      } catch (_e) {
        out.parentDom = 'blocked';
      }
      try {
        out.storage = String(localStorage.getItem('k'));
      } catch (_e) {
        out.storage = 'blocked';
      }
      try {
        out.cookie = document.cookie;
      } catch (_e) {
        out.cookie = 'blocked';
      }
      out.origin = location.origin;
      try {
        await fetch('/fs/read?path=/etc/passwd');
        out.sameHostFetch = 'allowed';
      } catch (_e) {
        out.sameHostFetch = 'blocked';
      }
      try {
        await fetch('https://example.com/');
        out.otherFetch = 'allowed';
      } catch (_e) {
        out.otherFetch = 'blocked';
      }
      return out;
    });
    assert.equal(probe.parentDom, 'blocked');
    assert.equal(probe.storage, 'blocked');
    assert.equal(probe.cookie, 'blocked');
    assert.equal(probe.origin, 'null');
    assert.equal(probe.sameHostFetch, 'blocked');
    assert.equal(probe.otherFetch, 'blocked');
  },
);

await check(
  'save 404 from a missing ROUTE is reported as such, not as "file no longer exists"',
  async (page) => {
    const f = join(dir, 'noroute.txt');
    writeFileSync(f, 'a');
    await page.route('**/api/save.file', (route: any) =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }),
    );
    await open(page, f);
    const frame = await monacoFrame(page);
    await frame.click('.monaco-editor .view-lines');
    await page.keyboard.type('x');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(
      () => /editor\.noRoute/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''),
      null,
      { timeout: 8000 },
    );
    assert.equal(readFileSync(f, 'utf8'), 'a');
  },
);

await check(
  'save 404 from our handler (file really gone) still says the file no longer exists',
  async (page) => {
    const f = join(dir, 'vanish.txt');
    writeFileSync(f, 'a');
    await open(page, f);
    const frame = await monacoFrame(page);
    (await import('node:fs')).unlinkSync(f);
    await frame.click('.monaco-editor .view-lines');
    await page.keyboard.type('x');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(
      () => /editor\.gone/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''),
      null,
      { timeout: 8000 },
    );
  },
);

await check(
  'editor tab title shows the stock file-type icon (FileTypeIcon + classifyFileType) per file type',
  async (page) => {
    if (ftModule === undefined) {
      results.push(['SKIP', `editor tab icons (Harness primitives not found at ${PRIMITIVES})`]);
      return;
    }
    const names = [
      '.gitignore',
      'README.md',
      'package.json',
      'client.js',
      'cordis.patch.yml',
      'notes.txt',
      'Dockerfile',
    ];
    await page.goto(`${base}/?what=titles&t=${encodeURIComponent(names.join('|'))}`);
    await page.waitForSelector('[data-title] svg');
    const rows = await page.$$eval('[data-title]', (els: any[]) =>
      els.map((e) => ({
        title: e.dataset.title,
        svg: !!e.querySelector('svg'),
        size: e.querySelector('svg')?.getAttribute('width'),
        cls: e.querySelector('svg')?.getAttribute('class') ?? '',
        own: [...e.childNodes]
          .filter((n: any) => n.nodeType === 3)
          .map((n: any) => n.textContent)
          .join(''),
      })),
    );
    for (const r of rows) {
      assert.ok(
        r.svg && r.size === '16' && /dlf-ed-titleIcon/.test(r.cls),
        `${r.title}: 16px icon with our class`,
      );
      assert.equal(r.own, r.title, `${r.title}: title text unchanged`);
    }
    const looks = await page.$$eval(
      '[data-title] svg',
      (s: any[]) => new Set(s.map((x) => `${x.innerHTML.length}:${x.getAttribute('class')}`)).size,
    );
    assert.ok(looks > 2, 'icons differ by file type');
  },
);

await check(
  'editor tab title degrades to text only when the primitives are unavailable',
  async (page) => {
    await page.goto(`${base}/?what=titles&prim=none&t=${encodeURIComponent('a.js|b.md')}`);
    await page.waitForSelector('[data-title]');
    const bare = await page.$$eval('[data-title]', (els: any[]) =>
      els.map((e) => ({ svg: !!e.querySelector('svg'), text: e.textContent })),
    );
    assert.deepEqual(bare, [
      { svg: false, text: 'a.js' },
      { svg: false, text: 'b.md' },
    ]);
  },
);

await browser.close();
server.close();
for (const r of results)
  console.log(
    r[0],
    '-',
    r[1],
    r[2] ? `\n     ${r[2]}` : '',
    r[3]?.length ? `\n     console: ${r[3].join(' | ')}` : '',
  );
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
