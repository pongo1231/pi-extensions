/**
 * pi-harness extension - closes the quality gap between DeepSeek V4 Pro
 * and Claude by implementing two harness techniques from the cwcode Substack
 * post (https://howardchen.substack.com/p/deepseek-v4-pro-at-5-the-cost-of):
 *
 * 1. Cache prefix stability - strip reasoning_content, sort tools, remove
 *    timestamps to maximize DeepSeek prompt cache hit ratio (~120x cost
 *    difference between cache hit and miss).
 *
 * 2. Hashline editing - hash-annotate read output + register edit_lines tool
 *    for hash-verified line-range edits (avoids exact-string reproduction).
 *
 * All features are independently configurable via PI_HARNESS_* env vars.
 * Run /deepseek-optimized to see current status and stats.
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { parseConfig } from "./harness/config.js";
import { registerCacheHooks } from "./harness/cache.js";
import { registerHashlines } from "./harness/hashlines.js";

export default function harnessPlugin(pi: ExtensionAPI): void {
	const config = parseConfig();

	if (!config.enabled) return;

	// -- Register all modules -------------------------------------------------
	const cacheStats = registerCacheHooks(pi, config.cache, config.modelPattern);
	const hashlineStats = registerHashlines(
		pi,
		config.hashlines,
		config.modelPattern,
	);

	// -- /deepseek-optimized command - status overview -----------------------
	pi.registerCommand("deepseek-optimized", {
		description:
			"Show pi-deepseek-optimized status: active modules, stats, and configuration.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines: string[] = ["pi-deepseek-optimized status:", ""];

			// Module status
			lines.push("Modules:");
			lines.push(
				`  cache         ${config.cache.enabled ? "ON" : "OFF"}  - reasoning stripped: ${cacheStats.reasoningStripped}, tools sorted: ${cacheStats.toolsSorted}, timestamps stripped: ${cacheStats.timestampsStripped}`,
			);
			lines.push(
				`  hashlines     ${config.hashlines.enabled ? "ON" : "OFF"}  - reads annotated: ${hashlineStats.readsAnnotated}, edit calls: ${hashlineStats.editCalls}, mismatches: ${hashlineStats.hashMismatches}, successes: ${hashlineStats.editSuccesses}`,
			);

			lines.push("", "Configuration (env vars):");
			lines.push(`  PI_HARNESS_ENABLED=${config.enabled}`);
			lines.push(`  PI_HARNESS_MODEL_PATTERN=${config.modelPattern.join(",")}`);
			lines.push(`  PI_HARNESS_CACHE_ENABLED=${config.cache.enabled}`);
			lines.push(
				`  PI_HARNESS_CACHE_STRIP_REASONING=${config.cache.stripReasoning}`,
			);
			lines.push(`  PI_HARNESS_CACHE_SORT_TOOLS=${config.cache.sortTools}`);
			lines.push(
				`  PI_HARNESS_CACHE_STRIP_TIMESTAMPS=${config.cache.stripTimestamps}`,
			);
			lines.push(`  PI_HARNESS_HASHLINES_ENABLED=${config.hashlines.enabled}`);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
