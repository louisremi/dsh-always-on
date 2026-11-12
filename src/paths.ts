/** Host-path helpers shared by the mutation routes. */
import { rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Longest name (with any sub-directories) a create or rename accepts. */
const MAX_NAME_LENGTH = 1024;

/**
 * Validate a user-typed name, relative to a directory. `a/b.txt` is allowed
 * (missing directories are created); absolute paths, `.`/`..` segments, empty
 * segments, backslashes and control characters are not. The client mirrors
 * this rule in `validName()` (src/client.ts).
 * @returns the `/`-separated segments, or undefined when invalid.
 */
export function nameSegments(name: unknown): string[] | undefined {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH)
    return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return undefined;
  const segments = name.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..' || s.trim() !== s))
    return undefined;
  return segments;
}

/**
 * Remove the directories a `mkdir(deepest, { recursive: true })` created,
 * deepest first, up to and including `first` (its return value). Best effort
 * and non-recursive: only empty directories go.
 */
export async function undoMkdir(deepest: string, first: string | undefined): Promise<void> {
  if (first === undefined) return;
  for (let dir = deepest; ; dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      return;
    }
    if (dir === first || dirname(dir) === dir) return;
  }
}
