import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const SUBAGENT_SYSTEM_PROMPT = `You are a focused code subagent.
Investigate only the assigned task.
Use available tools as needed.
Keep output concise and cite file paths/evidence.
Do not mention unavailable context.`;

const SUBAGENT_RESPONSE_CONTRACT = `Return only:
- Findings
- Evidence: file paths, symbols, or line references when available
- Changes made, if any
- Open questions
- Recommended next steps`;

const SubtaskSchema = Type.Object({
	name: Type.String({ description: "Short stable name for this subtask." }),
	prompt: Type.String({ description: "The complete task for this subagent." }),
});

type Subtask = Static<typeof SubtaskSchema>;

const ToolModeSchema = Type.Union([
	Type.Literal("read_only"),
	Type.Literal("bash"),
	Type.Literal("implementation"),
]);

type ToolMode = Static<typeof ToolModeSchema>;

const DelegateParamsSchema = Type.Object({
	objective: Type.String({ description: "Overall objective shared by all subtasks." }),
	subtasks: Type.Array(SubtaskSchema, {
		minItems: 1,
		description: "Independent subtasks to run. Use multiple items when work can be parallelized cleanly.",
	}),
	mode: Type.Optional(ToolModeSchema, {
		description: "Tool mode. Default read_only. Use bash for tests/checks. Use implementation only for clearly separable edits with low conflict risk.",
	}),
	maxConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 6, description: "Parallel subagent limit. Default 3, maximum 6." })),
});

type DelegateParams = Static<typeof DelegateParamsSchema>;

const MODE_TOOLS: Record<ToolMode, string[]> = {
	read_only: ["read", "grep", "find", "ls"],
	bash: ["read", "grep", "find", "ls", "bash"],
	implementation: ["read", "grep", "find", "ls", "bash", "edit", "write"],
};

const MODE_INSTRUCTIONS: Record<ToolMode, string> = {
	read_only: "Do not modify files.",
	bash: "Prefer read/grep/find/ls. Use bash only for concise inspection, tests, or checks relevant to the task. Do not modify files.",
	implementation: "You may modify files to complete the task. Keep edits minimal. Run concise checks when useful. Avoid parallel subtasks that may edit the same files.",
};

function clampConcurrency(value: number | undefined, subtaskCount: number): number {
	const requested = Number.isFinite(value) ? Math.floor(value!) : 3;
	return Math.max(1, Math.min(6, requested, subtaskCount));
}

function makePrompt(objective: string, subtask: Subtask, mode: ToolMode): string {
	return `Objective:
${objective}

Subtask: ${subtask.name}

Mode instruction:
${MODE_INSTRUCTIONS[mode]}

Task:
${subtask.prompt}

${SUBAGENT_RESPONSE_CONTRACT}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<string>,
): Promise<string[]> {
	const results = new Array<string>(items.length);
	let next = 0;

	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (true) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await worker(items[index], index);
			}
		}),
	);

	return results;
}

export default function delegateTaskExtension(pi: ExtensionAPI) {
	async function executeDelegate(
		params: DelegateParams,
		signal: AbortSignal | undefined,
		onUpdate: ((result: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
		ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	) {
		if (!ctx.model) {
			return {
				isError: true,
				content: [{ type: "text" as const, text: "delegate_task failed: no active model is selected." }],
				details: {},
			};
		}

		const mode = params.mode ?? "read_only";
		const concurrency = clampConcurrency(params.maxConcurrency, params.subtasks.length);
		const agentDir = getAgentDir();

		async function runSubtask(subtask: Subtask, index: number): Promise<string> {
			if (signal?.aborted) throw new Error("cancelled");
			onUpdate?.({ content: [{ type: "text", text: `Starting subagent ${index + 1}/${params.subtasks.length}: ${subtask.name}` }] });

			const loader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: SUBAGENT_SYSTEM_PROMPT,
			});
			await loader.reload();

			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				agentDir,
				model: ctx.model,
				modelRegistry: ctx.modelRegistry,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(ctx.cwd),
				tools: MODE_TOOLS[mode],
			});

			let output = "";
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					output += event.assistantMessageEvent.delta;
				}
			});

			try {
				if (signal?.aborted) throw new Error("cancelled");
				await session.prompt(makePrompt(params.objective, subtask, mode), { source: "extension" });
				return `## ${subtask.name}\n\n${output.trim() || "(no textual response)"}`;
			} catch (error) {
				return `## ${subtask.name}\n\nERROR: ${formatError(error)}`;
			} finally {
				unsubscribe();
				session.dispose();
			}
		}

		const results = await runWithConcurrency(params.subtasks, concurrency, runSubtask);
		return {
			content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }],
			details: {
				mode,
				tools: MODE_TOOLS[mode],
				objective: params.objective,
				subtaskCount: params.subtasks.length,
				concurrency,
			},
		};
	}

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: "Run one or more focused subagents in parallel and return compact findings. Default mode is read_only; optional modes add bash or write-capable implementation tools.",
		promptSnippet: "Run focused subagents in parallel and return compact findings without polluting the main session.",
		promptGuidelines: [
			"Use delegate_task when independent work can be split into clean subtasks; ask the user if the split is unclear.",
			"Use delegate_task mode=implementation only for independent subtasks with low edit-conflict risk.",
		],
		parameters: DelegateParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			return executeDelegate(params, signal, onUpdate, ctx);
		},
	});
}
