import { isAbsolute } from 'node:path';
import type { Fail } from './http.ts';
import { nameSegments } from './paths.ts';

/** The session, target folder and relative name a create or upload request names. */
export interface Target {
  sessionId: string;
  directory: string;
  segments: string[];
}

/**
 * Read and check the session, folder and name a create or upload request
 * carries, from a JSON body or from query parameters. Returns the 400 to
 * answer with when one is missing or malformed. `singleName` is for the
 * upload: a file picker sends a file name, never a path.
 */
export function parseTarget(
  fields: Record<string, unknown>,
  fail: Fail,
  options: { singleName?: boolean } = {},
): Target | Response {
  const { sessionId, directory, name } = fields;
  if (typeof sessionId !== 'string' || sessionId.length === 0)
    return fail(400, 'sessionId required');
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0'))
    return fail(400, 'absolute directory required');
  const segments = nameSegments(name);
  if (segments === undefined || (options.singleName === true && segments.length !== 1))
    return fail(400, 'invalid name');
  return { sessionId, directory, segments };
}
