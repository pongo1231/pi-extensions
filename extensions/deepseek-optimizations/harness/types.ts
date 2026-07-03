/**
 * Shared types for the pi-harness extension.
 *
 * The harness extension implements two techniques from the cwcode Substack
 * post for closing the quality gap between DeepSeek V4 Pro and Claude:
 *
 * 1. Cache prefix stability — strip reasoning_content, sort tools, remove timestamps
 * 2. Hashline editing — hash-annotated read output + hash-verified edit_lines tool
 */

/** Full configuration for the harness extension, parsed from environment variables. */
export interface HarnessConfig {
	/** Master switch. When false, no hooks fire and no tools are registered. */
	enabled: boolean;
	/**
	 * Comma-separated model patterns. Cache and hashline modules only activate
	 * when the active model's provider, id, or name matches one of these
	 * (case-insensitive substring).
	 */
	modelPattern: string[];
	cache: {
		enabled: boolean;
		/** Strip reasoning_content from assistant messages before each LLM call. */
		stripReasoning: boolean;
		/** Sort tool schemas deterministically in the outbound request payload. */
		sortTools: boolean;
		/** Remove dynamic timestamps/dates from the system prompt. */
		stripTimestamps: boolean;
	};
	hashlines: {
		enabled: boolean;
	};
}

/** A single hash-anchored edit in an edit_lines call. */
export interface HashEdit {
	/** 1-based start line number. */
	from: number;
	/** Expected hash at the from line. */
	from_hash: string;
	/** 1-based end line number (inclusive). */
	to: number;
	/** Expected hash at the to line. */
	to_hash: string;
	/** Replacement text for lines from..to. */
	new_text: string;
}