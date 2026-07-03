/**
 * Configuration parsing for the pi-harness extension.
 *
 * All settings are controlled via PI_HARNESS_* environment variables.
 * Every module has an independent enable flag so users can opt in/out
 * of individual techniques.
 */
import type { HarnessConfig } from "./types.js";

/** Parse a boolean env var, returning fallback when unset/empty. */
function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined || value === "") return fallback;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

/** Parse a comma-separated list env var. */
function envList(name: string, fallback: string[]): string[] {
	const value = process.env[name]?.trim();
	if (!value) return fallback;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Build the full HarnessConfig from environment variables.
 *
 * Env vars (all prefixed PI_HARNESS_):
 *   _ENABLED              master switch          (default: true)
 *   _MODEL_PATTERN        model patterns for gated modules (default: deepseek)
 *   _CACHE_ENABLED        cache module           (default: true)
 *   _CACHE_STRIP_REASONING strip reasoning       (default: true)
 *   _CACHE_SORT_TOOLS     sort tool schemas      (default: true)
 *   _CACHE_STRIP_TIMESTAMPS remove timestamps    (default: true)
 *   _HASHLINES_ENABLED    hashline editing       (default: true)
 */
export function parseConfig(): HarnessConfig {
	return {
		enabled: envBool("PI_HARNESS_ENABLED", true),
		modelPattern: envList("PI_HARNESS_MODEL_PATTERN", ["deepseek"]),
		cache: {
			enabled: envBool("PI_HARNESS_CACHE_ENABLED", true),
			stripReasoning: envBool("PI_HARNESS_CACHE_STRIP_REASONING", true),
			sortTools: envBool("PI_HARNESS_CACHE_SORT_TOOLS", true),
			stripTimestamps: envBool("PI_HARNESS_CACHE_STRIP_TIMESTAMPS", true),
		},
		hashlines: {
			enabled: envBool("PI_HARNESS_HASHLINES_ENABLED", true),
		},
	};
}
