/**
 * Shared utilities for the pi-harness extension.
 *
 * Line hashing uses FNV-1a 32-bit (same family as the cwcode implementation)
 * truncated to 12 bits (3 hex chars). The hash is computed on trailing-
 * whitespace-trimmed content so edits that only change trailing spaces don't
 * cause spurious mismatches.
 */

/**
 * Compute a 3-character hex hash for a line of content.
 * The hash is based on trailing-whitespace-trimmed content.
 */
export function lineHash(line: string): string {
	const trimmed = line.replace(/\s+$/, "");
	let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
	for (let i = 0; i < trimmed.length; i++) {
		hash ^= trimmed.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV-1a prime
	}
	return (hash & 0xfff).toString(16).padStart(3, "0");
}

/**
 * Format a line number with its hash annotation.
 *
 * Output format: `     N:HHH→content`
 */
export function annotateLine(lineNumber: number, content: string): string {
	const num = String(lineNumber).padStart(5, " ");
	const hash = lineHash(content);
	return `${num}:${hash}\u2192${content}`;
}

const ANNOTATED_RE = /^\s*\d+:([0-9a-f]{3})\u2192/;

/** Check whether a line already has a hash annotation. */
export function isAnnotated(line: string): boolean {
	return ANNOTATED_RE.test(line);
}

const isNoticeLine = (line: string): boolean =>
	line.startsWith("[Showing") ||
	(line.startsWith("[") && line.includes("to continue.]"));

/**
 * Annotate raw file content with line numbers and hashes.
 */
export function annotateContent(content: string, startLine = 1): string {
	const lines = content.split("\n");
	const result: string[] = [];
	let lineNum = startLine;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		if (isNoticeLine(line)) {
			result.push(line);
			continue;
		}

		if (line === "" && i + 1 < lines.length && isNoticeLine(lines[i + 1]!)) {
			result.push(line);
			continue;
		}

		if (isAnnotated(line)) {
			result.push(line);
		} else {
			result.push(annotateLine(lineNum, line));
		}
		lineNum++;
	}

	return result.join("\n");
}

/**
 * Check whether a model matches any of the given patterns.
 */
export function matchesModelPattern(
	model: { id: string; provider: string; name: string } | undefined,
	patterns: string[],
): boolean {
	if (!model || patterns.length === 0) return false;
	const haystack = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
	return patterns.some((p) => haystack.includes(p.toLowerCase()));
}
