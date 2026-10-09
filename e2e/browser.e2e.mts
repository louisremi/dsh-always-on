/**
 * Opt-in browser end-to-end suite: `npm run test:e2e`.
 *
 * Drives dist/client.js and the real save route in headless Chromium against the
 * REAL Monaco build on jsDelivr (needs internet), including a CDN-blocked
 * run, edit conflicts and the iframe sandbox isolation. Not part of
 * `npm test` / CI because it needs a browser and network.
 *
 * Requires: a Chromium (CHROMIUM=/path, default /usr/bin/chromium),
 * `playwright-core` (PLAYWRIGHT_CORE=/path/to/playwright-core), and React 18
 * UMD builds (REACT_UMD / REACT_DOM_UMD, or `npm i --no-save react@18 react-dom@18`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import type { SaveContext } from '../src/context.ts';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const REACT_UMD = process.env.REACT_UMD ?? require.resolve('react/umd/react.development.js');
const REACT_DOM_UMD = process.env.REACT_DOM_UMD ?? require.resolve('react-dom/umd/react-dom.development.js');
const { handleSave } = await import('../src/save-route.ts');

const dir = mkdtempSync(join(tmpdir(), 'dlf-e2e-'));
const versionOf = (p: string) => { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`; };
const writes: string[] = [];
const hostCtx: SaveContext = {
  fs: {
    processPathFromHostPath: (p) => p,
    resolve: async (p) => ({ displayPath: p }),
    stat: async (t) => { try { const s = statSync(t.displayPath!); return { type: s.isFile() ? 'file' : 'directory', size: s.size }; } catch { return undefined; } },
    writeText: async (t, content, intent) => {
      if (intent?.kind === 'replaceIfVersion' && intent.version !== versionOf(t.displayPath!)) throw Object.assign(new Error('stale'), { code: 'FS_STALE_VERSION' });
      writeFileSync(t.displayPath!, content); writes.push(content);
      return { operation: 'update', version: versionOf(t.displayPath!) };
    },
  },
  sessions: { get: (id) => (id === 'sess' ? { id } : undefined) },
  get: () => undefined,
  sandboxPolicy: { defaultMode: 'workspace-write', workspaceRoot: dir, resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: dir, sessionId: session.id }) },
  workspaceFiles: { stat: async (scope, path) => ({ absolutePath: path.startsWith('/') ? path : join(scope.workspaceRoot, path) }) },
};

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#111;--dsw-alias-border-l2:#ccc}
html,body{margin:0;height:100%} #root{width:600px;height:500px}</style></head><body><div id="root"></div>
<script src="/react.js"></script><script src="/react-dom.js"></script><script src="/ft.js"></script>
<script>window.__regs=[];window.__opened=[];window.__closeHandlers={};window.__tabTypes=[];
window.__ModuleLoader__={load:(m)=>{window.__mod=m;}};</script>
<script src="/client.js"></script>
<script>
const params=new URLSearchParams(location.search);
const t=(k,v)=>k+(v?JSON.stringify(v):'');
const ctx={effect:(f)=>f(),locale:{register:()=>()=>{},bind:()=>t},
 sidebarRight:{openResource:(a,o)=>window.__opened.push([a,o]),openTab:()=>{},registerCloseHandler:(k,f)=>{window.__closeHandlers[k]=f;return()=>{}}},
 sidebarRightTabs:{register:(d)=>{window.__tabTypes.push(d);return()=>{}}},
 theme:{getTheme:()=>({active:{colorScheme:params.get('dark')?'dark':'light'}})},
 on:()=>()=>{},
 remote:{workspaceFiles:{readBytes:async(sessionId,path)=>{
   const r=await fetch('/fs/read?path='+encodeURIComponent(path)); if(r.status===404) return {ok:false,error:{code:'workspace-file/not-found'}};
   const j=await r.json(); const bin=atob(j.b64); const data=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)data[i]=bin.charCodeAt(i);
   return {ok:true,value:{data,eof:true,bytes:data.length,version:j.version,absolutePath:path}};}}},
 slots:{inject:(n,f)=>f(),register:(o,c)=>{window.__regs.push([o,c]);}}};
const exp=window.__mod.factory((s)=>{if(s==='react')return window.React;if(s==='@deepseek-ai/dsh-client-ui-primitives'){if(params.get('prim')==='none'||!window.__ft)throw new Error('missing');return window.__ft;}throw new Error(s)});
exp.apply(ctx);
const reg=(name,key)=>window.__regs.find(([o])=>o.name===name&&(key===undefined||o.key===key))[1];
const h=React.createElement;
const info={tab:{id:'tab1',contentId:params.get('addr'),title:'x',signal:new AbortController().signal,actions:{bindCommands:()=>()=>{}}}};
window.__mountTitles=(titles)=>{
  const Title=reg('sidebar.right.pane.tab.title','@louisremi/dsh-always-on/editor');
  ReactDOM.createRoot(document.getElementById('root')).render(h('div',null,...titles.map((title,i)=>h('div',{key:i,'data-title':title,style:{display:'flex',gap:6,alignItems:'center',height:24}},h(Title,{useTabInfo:()=>({tab:{id:'t'+i,title}}),sessionId:'sess'})))));
};
window.__mount=(what)=>{
  const root=ReactDOM.createRoot(document.getElementById('root'));
  if(what==='editor') root.render(h(reg('sidebar.right.pane.tab',Object.keys({})[0]||'@louisremi/dsh-always-on/editor'),{useTabInfo:()=>info,sessionId:'sess'}));
  else root.render(h(reg('sidebar.right.tab.document.actions'),{sessionId:'sess',absolutePath:params.get('abs')}));
};
if(params.get('what')==='titles')window.__mountTitles((params.get('t')||'').split('|'));else window.__mount(params.get('what'));
</script></body></html>`;

// The real FileTypeIcon + classifyFileType source, cut out of the installed Harness' primitives
// bundle (its CSS-module/jsx helpers are shimmed). Absent => the icon test is skipped.
const PRIMITIVES = process.env.DSH_PRIMITIVES ?? '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js';
let ftModule: string | undefined;
try {
  const lines = readFileSync(PRIMITIVES, 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('//#region lib/types/code-file-icon-artwork.js'));
  const to = lines.findIndex((l) => l.startsWith('//#region lib/types/SiteGlyph.js'));
  if (from < 0 || to < from) throw new Error('layout changed');
  ftModule = `const React = window.React; const { useId, useMemo, useRef, useState, useEffect } = React;
const jsx = (type, props, key) => { const { children, ...rest } = props ?? {}; return React.createElement(type, key === undefined ? rest : { ...rest, key }, ...(children === undefined ? [] : [].concat(children))); };
const jsxs = jsx; const clsx = (...a) => a.flat(9).filter((x) => typeof x === 'string' && x).join(' ');
const css$20 = new Proxy({}, { get: (_, k) => 'ft-' + String(k) }); const css$21 = css$20; const css$19 = css$20; const css$18 = css$20;
${lines.slice(from, to).join('\n')}
window.__ft = { FileTypeIcon, classifyFileType };`;
} catch { ftModule = undefined; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const send = (code: number, body: string | Buffer, type = 'text/plain') => { res.writeHead(code, { 'content-type': type }); res.end(body); };
  if (url.pathname === '/') return send(200, PAGE, 'text/html');
  if (url.pathname === '/react.js') return send(200, readFileSync(REACT_UMD), 'text/javascript');
  if (url.pathname === '/react-dom.js') return send(200, readFileSync(REACT_DOM_UMD), 'text/javascript');
  if (url.pathname === '/ft.js') return send(200, ftModule ?? '', 'text/javascript');
  if (url.pathname === '/client.js') return send(200, readFileSync(new URL('../dist/client.js', import.meta.url)), 'text/javascript');
  if (url.pathname === '/fs/read') {
    const p = url.searchParams.get('path') ?? '';
    try { const b = readFileSync(p); return send(200, JSON.stringify({ b64: b.toString('base64'), version: versionOf(p) }), 'application/json'); }
    catch { return send(404, 'nope'); }
  }
  if (url.pathname === '/api/save.file') {
    const body = await new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
    const out = await handleSave(hostCtx, new Request('http://x/api/save.file', { method: req.method, body: body.length ? new Uint8Array(body) : undefined }));
    return send(out.status, await out.text(), 'application/json');
  }
  send(404, 'not found');
});
await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const results: [string, string, string?, string[]?][] = [];
const check = async (name: string, fn: (page: any, logs: string[]) => Promise<void>) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const logs: string[] = [];
  page.on('console', (m: any) => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e: any) => logs.push(`pageerror: ${e.message}`));
  try { await fn(page, logs); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name, (e as Error).message.split('\n')[0], logs.slice(0, 6)]); }
  await context.close();
};
const addr = (file: string) => `dsh-resource://file/session/sess/${encodeURIComponent(file).replace(/%2F/g, '/')}`;
const open = (page: any, file: string, extra = '') => page.goto(`${base}/?what=editor&addr=${encodeURIComponent(addr(file))}${extra}`);
const monacoFrame = async (page: any) => {
  const handle = await page.waitForSelector('iframe.dlf-ed-frame', { timeout: 15000 });
  const frame = await handle.contentFrame();
  await frame.waitForSelector('.monaco-editor', { timeout: 60000 });
  return frame;
};

await check('Edit button opens the editor tab type with a session file address', async (page) => {
  const f = join(dir, 'btn.txt'); writeFileSync(f, 'x');
  await page.goto(`${base}/?what=button&abs=${encodeURIComponent(f)}`);
  await page.waitForSelector('[data-edit-file] button');
  assert.ok(await page.$('[data-download-file] button'), 'download button also present');
  await page.click('[data-edit-file] button');
  const [[address, opts]] = await page.evaluate(() => window.__opened);
  assert.equal(opts.kind, 'dlf-editor');
  assert.equal(address, addr(f));
  const tabType = await page.evaluate(() => ({ kind: window.__tabTypes[0].kind, priority: window.__tabTypes[0].priority, keep: window.__tabTypes[0].keepMounted, patterns: window.__tabTypes[0].patterns }));
  assert.deepEqual(tabType, { kind: 'dlf-editor', priority: 'fallback', keep: true, patterns: undefined });
});

await check('Edit button hidden for binary extensions', async (page) => {
  await page.goto(`${base}/?what=button&abs=${encodeURIComponent('/w/pic.PNG')}`);
  await page.waitForSelector('[data-download-file] button');
  assert.equal(await page.$('[data-edit-file]'), null);
});

await check('real Monaco loads from the CDN inside the sandboxed iframe, edits and saves with Ctrl+S', async (page, logs) => {
  const f = join(dir, 'real.js'); writeFileSync(f, 'const a = 1;\r\nconst b = 2;\r\n');
  await open(page, f);
  const frame = await monacoFrame(page);
  const sandbox = await page.getAttribute('iframe.dlf-ed-frame', 'sandbox');
  assert.equal(sandbox, 'allow-scripts');
  assert.equal(await page.$('.dlf-ed-note'), null, 'no plain-text notice when Monaco works');
  await frame.waitForFunction(() => /const a = 1;/.test(document.querySelector('.view-lines')!.textContent!.replace(/\u00a0/g, ' ')), null, { timeout: 15000 });
  await frame.click('.monaco-editor .view-lines');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('// edited');
  await page.waitForFunction(() => document.querySelector('.dlf-ed-dot'), null, { timeout: 5000 });
  assert.equal(await page.isDisabled('.dlf-ed-bar .dlf-ed-btn'), false);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''), null, { timeout: 8000 });
  const onDisk = readFileSync(f, 'utf8');
  assert.match(onDisk, /\/\/ edited/);
  assert.ok(onDisk.includes('\r\n') && !/[^\r]\n/.test(onDisk), 'CRLF line endings preserved: ' + JSON.stringify(onDisk));
  assert.equal(await page.$('.dlf-ed-dot'), null, 'dirty marker cleared after save');
  const csp = logs.filter((l) => /Content Security Policy|Refused/.test(l));
  assert.deepEqual(csp, [], 'no CSP violations');
});

await check('Save button saves; second edit after save uses the fresh version', async (page) => {
  const f = join(dir, 'twice.txt'); writeFileSync(f, 'one');
  await open(page, f, '&dark=1');
  const frame = await monacoFrame(page);
  await frame.click('.monaco-editor .view-lines');
  await page.keyboard.press('Control+End'); await page.keyboard.type(' two');
  await page.click('.dlf-ed-bar .dlf-ed-btn');
  await page.waitForFunction(() => /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''), null, { timeout: 8000 });
  assert.equal(readFileSync(f, 'utf8'), 'one two');
  // No re-click: focus must already be back in the editor after pressing the Save button.
  await page.keyboard.press('Control+End'); await page.keyboard.type(' three');
  await page.waitForFunction(() => document.querySelector('.dlf-ed-dot'));
  await page.click('.dlf-ed-bar .dlf-ed-btn');
  await page.waitForFunction(() => /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''), null, { timeout: 8000 });
  assert.equal(readFileSync(f, 'utf8'), 'one two three');
  assert.equal(await frame.evaluate(() => document.querySelector('.monaco-editor')!.classList.contains('vs-dark')), true, 'dark theme applied');
});

await check('external change → 409 conflict banner; Overwrite then wins; file never clobbered silently', async (page) => {
  const f = join(dir, 'conflict.txt'); writeFileSync(f, 'base');
  await open(page, f);
  const frame = await monacoFrame(page);
  writeFileSync(f, 'changed on disk by someone else');
  await frame.click('.monaco-editor .view-lines');
  await page.keyboard.press('Control+End'); await page.keyboard.type('!');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.dlf-ed-banner');
  assert.equal(readFileSync(f, 'utf8'), 'changed on disk by someone else');
  const buttons = await page.$$eval('.dlf-ed-banner button', (b: any[]) => b.map((x) => x.textContent));
  assert.deepEqual(buttons, ['editor.reload', 'editor.overwrite', 'editor.keep']);
  await page.click('.dlf-ed-banner button:nth-of-type(2)');
  await page.waitForFunction(() => !document.querySelector('.dlf-ed-banner'));
  assert.equal(readFileSync(f, 'utf8'), 'base!');
});

await check('conflict → Reload from disk replaces the buffer', async (page) => {
  const f = join(dir, 'reload.txt'); writeFileSync(f, 'v1');
  await open(page, f);
  const frame = await monacoFrame(page);
  writeFileSync(f, 'v2 from disk');
  await frame.click('.monaco-editor .view-lines');
  await page.keyboard.type('zzz');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.dlf-ed-banner');
  await page.click('.dlf-ed-banner button:nth-of-type(1)');
  await page.waitForFunction(() => !document.querySelector('.dlf-ed-banner'));
  await frame.waitForFunction(() => /v2 from disk/.test(document.querySelector('.view-lines')!.textContent!.replace(/\u00a0/g, ' ')), null, { timeout: 15000 });
  assert.equal(await page.$('.dlf-ed-dot'), null);
  assert.equal(readFileSync(f, 'utf8'), 'v2 from disk');
});

await check('CDN unreachable → plain textarea fallback still edits and saves (CRLF kept)', async (page) => {
  const f = join(dir, 'plain.txt'); writeFileSync(f, 'a\r\nb\r\n');
  await page.route('https://cdn.jsdelivr.net/**', (route: any) => route.abort());
  await open(page, f);
  await page.waitForSelector('textarea.dlf-ed-text', { timeout: 20000 });
  assert.ok(await page.$('.dlf-ed-note'), 'plain-text notice shown');
  await page.fill('textarea.dlf-ed-text', 'a\nb\nc\n');
  await page.waitForSelector('.dlf-ed-dot');
  await page.press('textarea.dlf-ed-text', 'Control+s');
  await page.waitForFunction(() => /editor\.saved/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''), null, { timeout: 8000 });
  assert.equal(readFileSync(f, 'utf8'), 'a\r\nb\r\nc\r\n');
});

await check('binary / oversized / missing files are refused with a message, never opened', async (page) => {
  const bin = join(dir, 'x.dat'); writeFileSync(bin, Buffer.from([1, 2, 0, 3, 4]));
  await open(page, bin);
  await page.waitForSelector('.dlf-ed-msg');
  assert.match(await page.textContent('.dlf-ed-msg'), /editor\.notText/);
  const huge = join(dir, 'huge.txt'); writeFileSync(huge, 'x'.repeat(1024 * 1024 + 5));
  await open(page, huge);
  await page.waitForFunction(() => /editor\.tooLarge/.test(document.querySelector('.dlf-ed-msg')?.textContent ?? ''));
  await open(page, join(dir, 'missing.txt'));
  await page.waitForFunction(() => /editor\.gone/.test(document.querySelector('.dlf-ed-msg')?.textContent ?? ''));
});

await check('close handler: confirm discards or keeps a dirty tab', async (page) => {
  const f = join(dir, 'close.txt'); writeFileSync(f, 'q');
  await page.route('https://cdn.jsdelivr.net/**', (route: any) => route.abort());
  await open(page, f);
  await page.waitForSelector('textarea.dlf-ed-text', { timeout: 20000 });
  await page.fill('textarea.dlf-ed-text', 'dirty');
  await page.waitForSelector('.dlf-ed-dot');
  let asked = 0; let answer = false;
  page.on('dialog', (d: any) => { asked += 1; (answer ? d.accept() : d.dismiss()); });
  const closeCall = () => page.evaluate(() => { try { window.__closeHandlers['dlf-editor']('sess', { id: 'tab1', title: 'close.txt' }); return 'closed'; } catch (e) { return 'kept: ' + (e as Error).message; } });
  assert.match(await closeCall(), /^kept: close cancelled/);
  answer = true;
  assert.equal(await closeCall(), 'closed');
  assert.equal(asked, 2);
});

await check('sandbox isolation: CDN code in the frame cannot reach the page, its storage, or other origins', async (page) => {
  const f = join(dir, 'iso.txt'); writeFileSync(f, 'secret-ish');
  await open(page, f);
  await page.evaluate(() => { document.cookie = 'dsh=top-secret'; localStorage.setItem('k', 'v'); });
  const frame = await monacoFrame(page);
  const probe = await frame.evaluate(async () => {
    const out: Record<string, unknown> = {};
    try { out.parentDom = typeof parent.document.cookie; } catch (e) { out.parentDom = 'blocked'; }
    try { out.storage = String(localStorage.getItem('k')); } catch (e) { out.storage = 'blocked'; }
    try { out.cookie = document.cookie; } catch (e) { out.cookie = 'blocked'; }
    out.origin = location.origin;
    try { await fetch('/fs/read?path=/etc/passwd'); out.sameHostFetch = 'allowed'; } catch (e) { out.sameHostFetch = 'blocked'; }
    try { await fetch('https://example.com/'); out.otherFetch = 'allowed'; } catch (e) { out.otherFetch = 'blocked'; }
    return out;
  });
  assert.equal(probe.parentDom, 'blocked');
  assert.equal(probe.storage, 'blocked');
  assert.equal(probe.cookie, 'blocked');
  assert.equal(probe.origin, 'null');
  assert.equal(probe.sameHostFetch, 'blocked');
  assert.equal(probe.otherFetch, 'blocked');
});

await check('save 404 from a missing ROUTE is reported as such, not as "file no longer exists"', async (page) => {
  const f = join(dir, 'noroute.txt'); writeFileSync(f, 'a');
  await page.route('**/api/save.file', (route: any) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
  await open(page, f);
  const frame = await monacoFrame(page);
  await frame.click('.monaco-editor .view-lines');
  await page.keyboard.type('x');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /editor\.noRoute/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''), null, { timeout: 8000 });
  assert.equal(readFileSync(f, 'utf8'), 'a');
});

await check('save 404 from our handler (file really gone) still says the file no longer exists', async (page) => {
  const f = join(dir, 'vanish.txt'); writeFileSync(f, 'a');
  await open(page, f);
  const frame = await monacoFrame(page);
  (await import('node:fs')).unlinkSync(f);
  await frame.click('.monaco-editor .view-lines');
  await page.keyboard.type('x');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => /editor\.gone/.test(document.querySelector('.dlf-ed-status')?.textContent ?? ''), null, { timeout: 8000 });
});

await check('editor tab title shows the stock file-type icon (FileTypeIcon + classifyFileType) per file type', async (page) => {
  if (ftModule === undefined) { results.push(['SKIP', 'editor tab icons (Harness primitives not found at ' + PRIMITIVES + ')']); return; }
  const names = ['.gitignore', 'README.md', 'package.json', 'client.js', 'cordis.patch.yml', 'notes.txt', 'Dockerfile'];
  await page.goto(`${base}/?what=titles&t=${encodeURIComponent(names.join('|'))}`);
  await page.waitForSelector('[data-title] svg');
  const rows = await page.$$eval('[data-title]', (els: any[]) => els.map((e) => ({
    title: e.dataset.title, svg: !!e.querySelector('svg'), size: e.querySelector('svg')?.getAttribute('width'),
    cls: e.querySelector('svg')?.getAttribute('class') ?? '',
    own: [...e.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent).join(''),
  })));
  for (const r of rows) {
    assert.ok(r.svg && r.size === '16' && /dlf-ed-titleIcon/.test(r.cls), `${r.title}: 16px icon with our class`);
    assert.equal(r.own, r.title, `${r.title}: title text unchanged`);
  }
  const looks = await page.$$eval('[data-title] svg', (s: any[]) => new Set(s.map((x) => x.innerHTML.length + ':' + x.getAttribute('class'))).size);
  assert.ok(looks > 2, 'icons differ by file type');
});

await check('editor tab title degrades to text only when the primitives are unavailable', async (page) => {
  await page.goto(`${base}/?what=titles&prim=none&t=${encodeURIComponent('a.js|b.md')}`);
  await page.waitForSelector('[data-title]');
  const bare = await page.$$eval('[data-title]', (els: any[]) => els.map((e) => ({ svg: !!e.querySelector('svg'), text: e.textContent })));
  assert.deepEqual(bare, [{ svg: false, text: 'a.js' }, { svg: false, text: 'b.md' }]);
});

await browser.close();
server.close();
for (const r of results) console.log(r[0], '-', r[1], r[2] ? `\n     ${r[2]}` : '', r[3]?.length ? `\n     console: ${r[3].join(' | ')}` : '');
process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
