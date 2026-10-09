import type {
  ChangeSummary,
  ConnectionService,
  DownloadFs,
  LiveSession,
  SandboxPolicy,
  SaveFs,
  SessionPersistence,
  SessionQueryService,
  WorkspaceFilesService,
} from './context.ts';
import { registerDownloadRoute } from './download-route.ts';
import { registerSaveRoute } from './save-route.ts';

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

/** Host half of the plugin: the cordis context the two routes consume. */
export interface PluginContext {
  connection: ConnectionService;
  fs: DownloadFs & SaveFs;
  sessionQuery: SessionQueryService;
  workspaceFiles: WorkspaceFilesService;
  workspaceChanges: { summary(sessionId: string, seq: number): ChangeSummary | undefined };
  sandboxPolicy: {
    workspaceRoot: string;
    defaultMode: string;
    resolve(input: { session: LiveSession }): SandboxPolicy;
  };
  sessions?: { get(sessionId: string): LiveSession | undefined } | undefined;
  get(name: string): SessionPersistence | undefined;
  effect(callback: () => void | (() => void | Promise<void>), label?: string): unknown;
}

/**
 * Host half: serves authenticated file downloads at /api/download.file and
 * guarded text saves at /api/save.file. The Client half (src/client.ts) swaps
 * the "Show file location" buttons for download buttons and adds the sidebar
 * editor.
 */
export function apply(ctx: PluginContext): void {
  ctx.effect(() => registerDownloadRoute(ctx), 'always-on: /api/download.file');
  ctx.effect(() => registerSaveRoute(ctx), 'always-on: /api/save.file');
}
