/** Node-style error codes: reading them off anything thrown, and raising them. */

/** The `code` of a thrown value (Node's `ENOENT`, the Harness's `FS_*`), if it has one. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** An error carrying a Node-style code, which mutationStatus maps to a status. */
export function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
