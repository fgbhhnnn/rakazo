/**
 * OTA compatibility with installed native builds. Expo's Android bridge rejects a call that passes
 * more arguments than the installed native function declares ("Received 5 arguments, but 4 was
 * expected"). A JS update that adds a trailing argument first tries the new form, then falls back
 * to the old one on that exact error, so builds without the new native code keep working.
 */
const ARG_COUNT_ERROR = /Received \d+ arguments, but \d+ was expected/;

export function isNativeArgCountError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return ARG_COUNT_ERROR.test(message);
}

export async function withLegacyArity<T>(
  current: () => Promise<T>,
  legacy: () => Promise<T>,
): Promise<T> {
  try {
    return await current();
  } catch (error) {
    if (!isNativeArgCountError(error)) throw error;
    return legacy();
  }
}
