import { create } from "zustand";
import { newUuid } from "../../utils";

// A chronological timeline of the conversation, rendered above the input.
//   - "user":     a query the user sent (turn marker)
//   - "thinking": the model's reasoning summary (reasoning-delta stream parts)
//   - "note":     the model's visible narration (text-delta stream parts)
//   - "action":   a tool call (create/edit/run/… cell) and its outcome
export type TraceEntry =
	| { kind: "user"; id: string; text: string }
	| { kind: "thinking"; id: string; text: string }
	| { kind: "note"; id: string; text: string }
	| {
			kind: "action";
			id: string; // toolCallId
			tool: string;
			summary: string;
			status: "running" | "done" | "error";
			detail?: string;
	  };

interface AgentTraceStore {
	entries: TraceEntry[];
	isRunning: boolean;
	collapsed: boolean;

	// Begin a turn: marks the conversation with the user's query and keeps prior
	// entries so the whole conversation accumulates (cleared via `clear()`).
	start: (query: string) => void;
	finish: () => void;
	setCollapsed: (collapsed: boolean) => void;
	clear: () => void;

	appendThinking: (text: string) => void;
	appendNote: (text: string) => void;
	addAction: (id: string, tool: string, summary: string) => void;
	completeAction: (
		id: string,
		status: "done" | "error",
		detail?: string,
	) => void;
}

// Append streaming text to the trailing entry if it matches `kind`, otherwise
// open a new entry. This keeps consecutive deltas merged but starts a fresh
// block after an action (or a switch between thinking/note) interrupts them.
const appendText = (
	entries: TraceEntry[],
	kind: "thinking" | "note",
	text: string,
): TraceEntry[] => {
	const last = entries[entries.length - 1];
	if (last && last.kind === kind) {
		return [...entries.slice(0, -1), { ...last, text: last.text + text }];
	}
	return [...entries, { kind, id: newUuid(), text }];
};

export const useAgentTraceStore = create<AgentTraceStore>((set) => ({
	entries: [],
	isRunning: false,
	collapsed: false,

	// A new query expands the panel (in case it was manually collapsed). We do
	// NOT auto-collapse on finish — that hid content out from under the user.
	// The panel stays put and compact; collapsing is a manual choice.
	start: (query) =>
		set((state) => ({
			isRunning: true,
			collapsed: false,
			entries: [
				...state.entries,
				{ kind: "user", id: newUuid(), text: query },
			],
		})),
	finish: () => set({ isRunning: false }),
	setCollapsed: (collapsed) => set({ collapsed }),
	clear: () => set({ entries: [], isRunning: false }),

	appendThinking: (text) =>
		set((state) => ({
			entries: appendText(state.entries, "thinking", text),
		})),
	appendNote: (text) =>
		set((state) => ({ entries: appendText(state.entries, "note", text) })),

	addAction: (id, tool, summary) =>
		set((state) => ({
			entries: [
				...state.entries,
				{ kind: "action", id, tool, summary, status: "running" },
			],
		})),
	completeAction: (id, status, detail) =>
		set((state) => ({
			entries: state.entries.map((entry) =>
				entry.kind === "action" && entry.id === id
					? { ...entry, status, detail }
					: entry,
			),
		})),
}));
