/**
 * Application constants
 */

/**
 * Default server port for OAuth callbacks and webhooks.
 * Azure App Service sets PORT automatically — check it as fallback.
 */
export const DEFAULT_SERVER_PORT = parseInt(process.env.PORT || "3456", 10);

/**
 * Parse a port number from string with validation
 */
export function parsePort(
	value: string | undefined,
	defaultPort: number,
): number {
	if (!value) return defaultPort;
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) || parsed < 1 || parsed > 65535
		? defaultPort
		: parsed;
}
