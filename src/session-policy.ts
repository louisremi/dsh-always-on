import type { SandboxPolicy, SaveContext } from './context.ts';

/** What resolving a session's policy needs from the Host context. */
export type PolicyContext = Pick<SaveContext, 'sandboxPolicy' | 'sessions' | 'get'>;

/**
 * Sandbox policy for the Session a mutation belongs to: the Session's own
 * workspace boundary and mode when it is live, else its persisted workspace
 * root under the deployment default mode. Never widened beyond that.
 */
export async function policyFor(
  ctx: PolicyContext,
  sessionId: string,
  signal: AbortSignal,
): Promise<SandboxPolicy | undefined> {
  const live = ctx.sessions?.get(sessionId);
  if (live !== undefined) return ctx.sandboxPolicy.resolve({ session: live });
  const stored = await ctx.get('sessionPersistence')?.stat(sessionId);
  signal.throwIfAborted();
  if (stored === undefined) return undefined;
  return {
    mode: ctx.sandboxPolicy.defaultMode,
    workspaceRoot: stored.header?.cwd ?? ctx.sandboxPolicy.workspaceRoot,
    sessionId,
  };
}
