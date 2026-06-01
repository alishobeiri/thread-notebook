import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { captureException } from "@sentry/nextjs";
import { ModelMessage, stepCountIs, streamText } from "ai";
import {
	getAPIKeyForRequest,
	getBaseURLForRequest,
	getModelForRequest,
} from "shared-thread-notebook-utils";
import { useMagicInputStore } from "../../../components/input/MagicInputStore";
import { useNotebookStore } from "../../../components/notebook/store/NotebookStore";
import { useSettingsStore } from "../../../components/settings/SettingsStore";
import { ThreadNotebookCell } from "../../../types/code.types";
import { trackEventData } from "../../posthog";
import { multilineStringToString } from "../../utils";
import { formatCellOutputs } from "../messages";
import { useAgentConversationStore } from "./conversationStore";
import { agentTools } from "./tools";
import { useAgentTraceStore } from "./traceStore";

// Maximum number of sequential model calls (tool roundtrips + 1) per request.
const MAX_STEPS = 16;

const SYSTEM_PROMPT = `You are an autonomous coding agent working inside a reactive Python notebook (Jupyter-like). You operate through the provided tools.

How you work:
- You start with a notebook map (one line per cell: run status, defined symbols, first line) — but NOT full source or outputs. Use list_cells / read_cell to inspect a cell's full source and its outputs before relying on or changing it.
- Cell indices and which cell is "last" change whenever cells are added, moved, or deleted. Treat ids as stable but positions as volatile: after any structural change, call list_cells again before claiming a cell is first/last or referring to it by index. Prefer ids (and before/after) over indices.
- Make changes by calling create_cell, edit_cell, run_cell and delete_cell. You may touch any cell in the notebook, not just the active one.
- When you write or change code, run it with run_cell and read the outputs. If a cell errors, fix it and run again.
- Put explanations and summaries for the user into markdown cells (create_cell with cell_type "markdown") rather than as long chat replies.
- Prefer small, focused cells over one giant cell. Keep imports near where they are first needed.
- The notebook is reactive: re-running a cell re-runs its dependents, so you usually only need to run the cell you changed.

Continue taking actions until the user's request is fully handled, then stop. Do not ask for confirmation — just do the work.`;

function getModelClient(): any {
	const { modelInformation } = useSettingsStore
		.getState()
		.getAdditionalRequestMetadata();
	const modelType = modelInformation.modelType;
	const model = getModelForRequest(modelInformation);
	// Browser-side fallback: NEXT_PUBLIC_OPENAI_API_KEY (from .env.local) when no
	// key is configured in Settings. The server-only OPENAI_API_KEY that
	// getAPIKeyForRequest reads isn't visible to client code.
	const apiKey =
		getAPIKeyForRequest(modelInformation) ||
		process.env.NEXT_PUBLIC_OPENAI_API_KEY ||
		"";
	const baseURL = getBaseURLForRequest(modelInformation);

	if (modelType === "anthropic") {
		return createAnthropic({ apiKey, baseURL })(model);
	}

	const openai = createOpenAI({ apiKey, baseURL });
	// Ollama is OpenAI-compatible but only speaks the Chat Completions API.
	if (modelType === "ollama") {
		return openai.chat(model);
	}
	// OpenAI: use the Responses API so reasoning models (gpt-5.x) stream their
	// reasoning summaries back to us.
	return openai.responses(model);
}

function isReasoningModel(model: string): boolean {
	return /^(gpt-5|o[1-9])/.test(model);
}

// Run state of a code cell, derived from its outputs / execution count.
function cellStatus(cell: ThreadNotebookCell): string {
	if (cell.cell_type !== "code") return "";
	const outputs = formatCellOutputs(cell);
	if (outputs.some((o: any) => o.errorOccurred)) return "error";
	if ((cell as any).execution_count != null || outputs.length > 0)
		return "ran";
	return "not run";
}

// Builds the user turn for the current request: a lean map of the notebook (one
// line per cell with run status and the symbols it defines) plus the focus, then
// the request. Full source and outputs are intentionally NOT dumped here — the
// agent discovers them on demand via list_cells / read_cell, which keeps context
// small and accurate as the notebook grows. Regenerated each turn so the map is
// always current.
async function buildTurnMessage(query: string): Promise<ModelMessage> {
	const { cells, activeCellIndex, cellDependencies } =
		useNotebookStore.getState();
	const selectedCode = useMagicInputStore.getState().selectedCode;
	const activeCell = cells[activeCellIndex] as ThreadNotebookCell | undefined;

	const outline =
		cells
			.map((cell, i) => {
				const src = multilineStringToString(cell.source);
				const firstLine = src.split("\n").find((l) => l.trim()) ?? "";
				const label =
					firstLine.length > 80
						? `${firstLine.slice(0, 80)}…`
						: firstLine;

				const parts = [`[${i}]`, cell.cell_type];
				const status = cellStatus(cell);
				if (status) parts.push(`(${status})`);
				if (i === activeCellIndex) parts.push("(active)");
				if (i === cells.length - 1) parts.push("(last)");

				const defines = cellDependencies[cell.id as string]?.defines;
				const defs = defines?.length
					? ` defines: ${defines.join(", ")}`
					: "";

				return `${parts.join(" ")} id=${cell.id}${defs}${
					label ? `  — ${label}` : ""
				}`;
			})
			.join("\n") || "(the notebook is currently empty)";

	const focus: string[] = [];
	if (selectedCode) {
		focus.push(
			`The user has selected this code as the focus of the request:\n\`\`\`\n${selectedCode}\n\`\`\``,
		);
	}
	if (activeCell) {
		const activeSrc = multilineStringToString(activeCell.source);
		const lines = [
			`The user's active (selected) cell is index ${activeCellIndex} (id=${activeCell.id}, ${activeCell.cell_type}) — treat it as the primary context for this request. Its current source:`,
			"```",
			activeSrc || "(empty)",
			"```",
		];
		if (activeCell.cell_type === "code") {
			const outputs = formatCellOutputs(activeCell);
			if (outputs.length > 0) {
				lines.push(
					`Its latest outputs: ${JSON.stringify(outputs).slice(0, 600)}`,
				);
			}
		}
		focus.push(lines.join("\n"));
	}

	// Cells the user explicitly attached via @-mention.
	const mentions = useMagicInputStore.getState().mentions;
	const attached = mentions
		.map((m) => {
			const cell = cells.find((c) => c.id === m.id) as
				| ThreadNotebookCell
				| undefined;
			if (!cell) return "";
			const src = multilineStringToString(cell.source);
			let block = `## ${m.label} (id=${cell.id}, ${cell.cell_type})\n\`\`\`\n${
				src || "(empty)"
			}\n\`\`\``;
			if (cell.cell_type === "code") {
				const outputs = formatCellOutputs(cell);
				if (outputs.length > 0) {
					block += `\noutputs: ${JSON.stringify(outputs).slice(0, 400)}`;
				}
			}
			return block;
		})
		.filter(Boolean)
		.join("\n\n");

	const content = [
		`# Notebook map (${cells.length} cell${cells.length === 1 ? "" : "s"}, current)`,
		"One line per cell: index, type, run status, defined symbols, first line; the cell marked (last) is the final cell. This reflects the CURRENT notebook — ignore any cell positions mentioned earlier in the conversation, they may be stale. After you add, move, or delete cells, call list_cells again before reasoning about positions. Call list_cells / read_cell to see full source and outputs.",
		"",
		outline,
		attached ? `\n# Attached cells (@-mentioned)\n${attached}` : "",
		focus.length ? `\n# Focus\n${focus.join("\n")}` : "",
		`\n# Request\n${query}`,
	]
		.filter(Boolean)
		.join("\n");

	return { role: "user", content };
}

// Concise human-readable summary of a tool call for the thinking trace.
function summarizeToolCall(tool: string, input: any): string {
	if (!input || typeof input !== "object") return "";
	const target = input.id ?? (typeof input.index === "number" ? `#${input.index}` : "");
	switch (tool) {
		case "create_cell": {
			const pos = input.before
				? `before ${input.before}`
				: input.after
				? `after ${input.after}`
				: typeof input.index === "number"
				? `#${input.index}`
				: "at end";
			return `${input.cell_type} · ${pos}`;
		}
		case "move_cell": {
			const dest = input.to_end
				? "→ end"
				: input.to_start
				? "→ start"
				: input.before
				? `before ${input.before}`
				: input.after
				? `after ${input.after}`
				: typeof input.index === "number"
				? `→ #${input.index}`
				: "";
			return `${input.id ?? ""} ${dest}`.trim();
		}
		case "edit_cell":
		case "run_cell":
		case "read_cell":
		case "delete_cell":
			return target ? `${target}` : "";
		default:
			return "";
	}
}

function toolResultStatus(output: any): {
	status: "done" | "error";
	detail?: string;
} {
	if (output && typeof output === "object") {
		if (output.error) return { status: "error", detail: String(output.error) };
		if (output.denied) return { status: "error", detail: "denied" };
		if (output.errorOccurred) return { status: "error", detail: "cell errored" };
	}
	return { status: "done" };
}

/**
 * Entry point for the local, Claude-Code-style agent. Streams a tool-calling
 * loop against the configured model endpoint: the model reads/creates/edits/
 * runs cells via `agentTools` until the request is handled. Reasoning summaries
 * and tool activity are pushed live into the agent trace store (rendered above
 * the input).
 */
export const runAgent = async (query: string) => {
	const get = useNotebookStore.getState;
	const abortSignal = get().userAbortedMagicQueryController.signal;
	const trace = useAgentTraceStore.getState();

	const client = getModelClient();
	const model = getModelForRequest(
		useSettingsStore.getState().getAdditionalRequestMetadata()
			.modelInformation,
	);

	// Carry prior turns forward so the agent remembers the conversation. The
	// current notebook state is re-injected fresh in this turn's message.
	const conversation = useAgentConversationStore.getState();
	const turnMessage = await buildTurnMessage(query);
	const messages = [...conversation.messages, turnMessage];

	trace.start(query);

	try {
		const result = streamText({
			model: client,
			system: SYSTEM_PROMPT,
			messages,
			tools: agentTools,
			toolChoice: "auto",
			stopWhen: stepCountIs(MAX_STEPS),
			abortSignal,
			// Reasoning models stream a reasoning summary; non-reasoning models
			// ignore these options.
			providerOptions: isReasoningModel(model)
				? { openai: { reasoningEffort: "medium", reasoningSummary: "auto" } }
				: undefined,
		});

		for await (const part of result.fullStream) {
			switch (part.type) {
				case "reasoning-delta":
					trace.appendThinking(part.text);
					break;
				case "text-delta":
					trace.appendNote(part.text);
					break;
				case "tool-call":
					console.debug(
						"[Agent] tool-call",
						part.toolName,
						(part as any).input,
					);
					trace.addAction(
						part.toolCallId,
						part.toolName,
						summarizeToolCall(part.toolName, (part as any).input),
					);
					break;
				case "tool-result": {
					console.debug(
						"[Agent] tool-result",
						part.toolName,
						(part as any).output,
					);
					const { status, detail } = toolResultStatus(
						(part as any).output,
					);
					trace.completeAction(part.toolCallId, status, detail);
					break;
				}
				case "tool-error":
					console.warn(
						"[Agent] tool-error",
						(part as any).toolName,
						(part as any).error,
					);
					trace.completeAction(
						part.toolCallId,
						"error",
						String((part as any).error),
					);
					break;
				case "error":
					throw (part as any).error;
			}
		}

		// Persist this turn (clean query + the assistant/tool messages) so the
		// next query has the full conversation as context.
		const response = await result.response;
		conversation.append([
			{ role: "user", content: query },
			...(response.messages as ModelMessage[]),
		]);

		trackEventData("[Agent] Run complete", {
			finishReason: await result.finishReason,
		});
	} catch (e: any) {
		if (e?.name === "AbortError" || abortSignal.aborted) {
			console.log("Agent run aborted");
		} else {
			console.error("Agent run failed:", e);
			captureException(e);
			trace.appendNote(`\n⚠️ ${e?.message ?? "Agent run failed."}`);
		}
	} finally {
		trace.finish();
	}
};
