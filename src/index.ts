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
import {
  CREATE_FILE_PATH,
  CREATE_FOLDER_PATH,
  handleCreateFile,
  handleCreateFolder,
} from './create-route.ts';
import { registerDownloadRoute } from './download-route.ts';
import {
  DELETE_FILE_PATH,
  DELETE_FOLDER_PATH,
  handleDeleteFile,
  handleDeleteFolder,
  handleRenameFile,
  handleRenameFolder,
  handleRestore,
  onTrashUsed,
  RENAME_FILE_PATH,
  RENAME_FOLDER_PATH,
  RESTORE_PATH,
} from './entry-route.ts';
import {
  DOWNLOAD_FOLDER_PATH,
  handleDownloadFolder,
  handleFolderSummary,
  SUMMARY_PATH,
} from './folder-route.ts';
import { registerRoute } from './http.ts';
import { registerSaveRoute } from './save-route.ts';
import { existingTrashDir, purgeTrash } from './trash.ts';

/** Services the routes need: auth fence, filesystem, session lookups. */
export const inject = [
  'connection',
  'fs',
  'sessionQuery',
  'workspaceFiles',
  'sandboxPolicy',
  'workspaceChanges',
  'sessions',
];

/** Host half of the plugin: the cordis context the routes consume. */
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Purge the trash folders this process knows of: the default workspace's at
 * start, every one a delete used since, again each day.
 */
function trashPurge(ctx: PluginContext): () => void {
  const known = new Set<string>();
  const purge = (dir: string) => {
    purgeTrash(dir).catch((error) => {
      console.warn('[dsh-always-on] trash purge failed:', error);
    });
  };
  onTrashUsed((dir) => {
    known.add(dir);
    purge(dir);
  });
  void existingTrashDir(ctx.sandboxPolicy.workspaceRoot).then((dir) => {
    if (dir === undefined) return;
    known.add(dir);
    purge(dir);
  });
  const timer = setInterval(() => {
    for (const dir of known) purge(dir);
  }, DAY_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    onTrashUsed((dir) => purge(dir));
  };
}

/**
 * Host half: serves authenticated file and folder downloads
 * (/api/download.file, /api/download.folder), folder summaries, guarded text
 * saves at /api/save.file, new empty files and folders, rename/move and
 * delete (to a trash, with restore) for files and folders. The Client half
 * (src/client.ts) swaps the "Show file location" buttons for download
 * buttons, adds the Files tree's menu entries and the sidebar editor.
 */
export function apply(ctx: PluginContext): void {
  ctx.effect(() => registerDownloadRoute(ctx), 'always-on: /api/download.file');
  ctx.effect(() => registerSaveRoute(ctx), 'always-on: /api/save.file');
  const mutations = [
    [CREATE_FILE_PATH, handleCreateFile],
    [CREATE_FOLDER_PATH, handleCreateFolder],
    [RENAME_FILE_PATH, handleRenameFile],
    [DELETE_FILE_PATH, handleDeleteFile],
    [RENAME_FOLDER_PATH, handleRenameFolder],
    [DELETE_FOLDER_PATH, handleDeleteFolder],
    [RESTORE_PATH, handleRestore],
  ] as const;
  for (const [path, handle] of mutations) {
    ctx.effect(() => registerRoute(ctx, { path, methods: ['POST'], handle }), `always-on: ${path}`);
  }
  const reads = [
    [SUMMARY_PATH, handleFolderSummary],
    [DOWNLOAD_FOLDER_PATH, (c: PluginContext, r: Request) => handleDownloadFolder(c, r)],
  ] as const;
  for (const [path, handle] of reads) {
    ctx.effect(
      () => registerRoute(ctx, { path, methods: ['GET', 'HEAD'], handle }),
      `always-on: ${path}`,
    );
  }
  ctx.effect(() => trashPurge(ctx), 'always-on: trash purge');
}
