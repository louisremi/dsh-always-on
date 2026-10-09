/**
 * Structural types for the Harness services this plugin's Host half consumes.
 * The plugin keeps zero runtime dependencies, so instead of importing Harness
 * packages these interfaces describe only the members the routes actually
 * call. The `inject` list in src/index.ts is what guarantees they exist.
 */

export interface SandboxPolicy {
  mode: string;
  workspaceRoot: string;
  sessionId?: string | undefined;
}

/** A resolved Host path (the value ctx.fs.resolve hands back). */
export interface FsTarget {
  displayPath?: string | undefined;
}

export interface FsInfo {
  type: string;
  size?: number | undefined;
  version?: string | undefined;
}

export interface WriteIntent {
  kind: 'replaceIfVersion';
  version?: string | undefined;
}

export interface WriteOutcome {
  version: string;
  operation: string;
}

export interface FetchRoute {
  path: string;
  methods: string[];
  requestBody?: string | undefined;
  fetch(request: Request): Response | Promise<Response>;
}

export interface ConnectionService {
  fetch: {
    /** Registers a route; returns its disposer. */
    register(route: FetchRoute): (() => void) | undefined;
  };
}

/** The fs members the download route calls. */
export interface DownloadFs {
  processPathFromHostPath(hostPath: string): string | undefined;
  resolve(path: string, options?: { signal?: AbortSignal | undefined }): Promise<FsTarget>;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

/** The fs members the save route calls. */
export interface SaveFs {
  processPathFromHostPath(hostPath: string): string | undefined;
  resolve(path: string, options?: { signal?: AbortSignal | undefined }): Promise<FsTarget>;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  writeText(
    target: FsTarget,
    content: string,
    intent: WriteIntent | undefined,
    signal: AbortSignal | undefined,
    policy: SandboxPolicy,
  ): Promise<WriteOutcome>;
}

export interface WorkspaceFilesService {
  stat(
    scope: { sessionId: string; workspaceRoot: string },
    path: string,
    signal?: AbortSignal,
  ): Promise<{ absolutePath: string }>;
}

export interface SessionQueryService {
  readEvent(
    query: { sessionId: string; seq: number; before: number; after: number },
    signal?: AbortSignal,
  ): Promise<{
    target: { type?: string | undefined; data?: { files?: unknown } | undefined };
    session: { cwd?: string | undefined };
  }>;
}

export interface ChangeSummary {
  cwd: string;
  files: { path: string }[];
}

/** A Session object handed to sandboxPolicy.resolve; only its id is used. */
export interface LiveSession {
  id: string;
}

export interface SessionPersistence {
  stat(sessionId: string): Promise<{ header?: { cwd?: string | undefined } | undefined } | undefined>;
}

export interface DownloadContext {
  fs: DownloadFs;
  sandboxPolicy: { workspaceRoot: string };
  sessionQuery: SessionQueryService;
  workspaceFiles: WorkspaceFilesService;
  workspaceChanges: { summary(sessionId: string, seq: number): ChangeSummary | undefined };
}

export interface DownloadRegisterContext extends DownloadContext {
  connection: ConnectionService;
}

export interface SaveContext {
  fs: SaveFs;
  sandboxPolicy: {
    defaultMode: string;
    workspaceRoot: string;
    resolve(input: { session: LiveSession }): SandboxPolicy;
  };
  workspaceFiles: WorkspaceFilesService;
  sessions?: { get(sessionId: string): LiveSession | undefined } | undefined;
  get(name: string): SessionPersistence | undefined;
}

export interface SaveRegisterContext extends SaveContext {
  connection: ConnectionService;
}
