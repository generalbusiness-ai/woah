/**
 * Deployment-controlled public transport selector.
 *
 * Wrangler variables are strings, so JavaScript truthiness is unsafe here:
 * `Boolean("0")` would accidentally select Net. Keep the parser in one tiny
 * worker-layer module so edge routing and operator routes cannot drift on
 * which deployment values mean "Net is authoritative".
 */
export function netDefaultEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}
