import { registerDownloadRoute } from './download-route.js';

/** Services the download route needs: auth fence, filesystem, session lookups. */
export const inject = [
  'connection',
  'fs',
  'sessionQuery',
  'workspaceFiles',
  'sandboxPolicy',
  'workspaceChanges',
];

/**
 * Host half: serves authenticated file downloads at /api/download.file.
 * The Client half (client.js) swaps the "Show file location" buttons for
 * buttons that call this route.
 */
export function apply(ctx) {
  ctx.effect(() => registerDownloadRoute(ctx), 'download-files: /api/download.file');
}
