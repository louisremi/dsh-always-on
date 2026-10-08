import { registerDownloadRoute } from './download-route.js';
import { registerSaveRoute } from './save-route.js';

/** Services the download route needs: auth fence, filesystem, session lookups. */
export const inject = [
  'connection',
  'fs',
  'sessionQuery',
  'workspaceFiles',
  'sandboxPolicy',
  'workspaceChanges',
  'sessions',
];

/**
 * Host half: serves authenticated file downloads at /api/download.file and
 * guarded text saves at /api/save.file. The Client half (src/client.js) swaps
 * the "Show file location" buttons for download buttons and adds the sidebar
 * editor.
 */
export function apply(ctx) {
  ctx.effect(() => registerDownloadRoute(ctx), 'download-files: /api/download.file');
  ctx.effect(() => registerSaveRoute(ctx), 'download-files: /api/save.file');
}
