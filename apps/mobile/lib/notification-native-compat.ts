import { withLegacyArity } from "./native-arity-compat";

/** Installed notification bridges may predate custom headers, or both headers and locale. */
export function withNotificationArity<Args extends unknown[], T>(
  call: (...args: Args) => Promise<T>,
  args: Args,
): Promise<T> {
  const older = (count: number) => call(...(args.slice(0, -count) as Args));
  return withLegacyArity(
    () => call(...args),
    () =>
      withLegacyArity(
        () => older(1),
        () => older(2),
      ),
  );
}
