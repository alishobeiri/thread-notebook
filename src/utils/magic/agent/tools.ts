import { tool } from "ai";
import { z } from "zod";
import { useNotebookStore } from "../../../components/notebook/store/NotebookStore";
import { ThreadNotebookCell } from "../../../types/code.types";
import { multilineStringToString } from "../../utils";
import { formatCellOutputs } from "../messages";

// Accepts either an explicit `id` (preferred) or a 0-based `index`.
const cellLocator = {
	id: z
		.string()
		.optional()
		.describe("The cell id. Preferred when known (stable across edits)."),
	index: z
		.number()
		.int()
		.optional()
		.describe("0-based index of the cell in the notebook."),
};

type CellLocator = { id?: string; index?: number };

function resolveCell(args: CellLocator) {
	const { cells } = useNotebookStore.getState();
	let idx = -1;
	if (args.id) {
		idx = cells.findIndex((cell) => cell.id === args.id);
	}
	if (idx === -1 && typeof args.index === "number") {
		idx = args.index;
	}
	if (idx < 0 || idx >= cells.length) {
		return null;
	}
	return { cell: cells[idx] as ThreadNotebookCell, index: idx, id: cells[idx].id as string };
}

// Make the given cell active and scroll it into view so the user can watch the
// agent work on it. The scroll waits a tick for the `.active-cell` class to
// land on the right element after the React re-render.
function focusCell(cellId: string) {
	useNotebookStore.getState().setActiveCell(cellId);
	if (typeof window === "undefined") return;
	setTimeout(() => {
		document
			.querySelector(".active-cell")
			?.scrollIntoView({ behavior: "smooth", block: "center" });
	}, 60);
}

function snapshot(cell: ThreadNotebookCell, index: number) {
	const isCode = cell.cell_type === "code";
	return {
		index,
		id: cell.id,
		cell_type: cell.cell_type,
		source: multilineStringToString(cell.source),
		execution_count: (cell as any).execution_count ?? null,
		outputs: isCode ? formatCellOutputs(cell) : [],
	};
}

/**
 * The agent's tool set. Each tool maps onto an existing NotebookStore
 * primitive. The model writes cell source directly into the tool arguments —
 * there is no separate code-generation step.
 */
export const agentTools = {
	list_cells: tool({
		description:
			"List every cell in the notebook in order with its index, id, type, source and (for code cells) most recent outputs. This is the live, authoritative state — call it again after adding, moving, or deleting cells, since indices and which cell is last change. `count` is the total number of cells; the last cell has `index === count - 1` and `isLast: true`.",
		inputSchema: z.object({}),
		execute: async () => {
			const { cells } = useNotebookStore.getState();
			return {
				count: cells.length,
				cells: cells.map((cell, i) => ({
					...snapshot(cell as ThreadNotebookCell, i),
					isLast: i === cells.length - 1,
				})),
			};
		},
	}),

	read_cell: tool({
		description:
			"Read a single cell's full source and outputs by id or index. Includes `isLast` and the notebook's total `cellCount` so you can tell its position reliably.",
		inputSchema: z.object(cellLocator),
		execute: async (args) => {
			const resolved = resolveCell(args);
			if (!resolved) {
				return { error: "No cell found for the given id/index." };
			}
			const count = useNotebookStore.getState().cells.length;
			return {
				...snapshot(resolved.cell, resolved.index),
				cellCount: count,
				isLast: resolved.index === count - 1,
			};
		},
	}),

	create_cell: tool({
		description:
			"Insert a new cell. Use cell_type 'code' for executable Python and 'markdown' for explanations. Position it relative to an existing cell with `before` or `after` (by cell id) — e.g. to add an intro/explanation above a cell, set `before` to that cell's id. `index` is an absolute fallback. If nothing is given, the cell is inserted directly BELOW the current (active) cell.",
		inputSchema: z.object({
			cell_type: z.enum(["code", "markdown"]),
			source: z.string().describe("The full source for the new cell."),
			before: z
				.string()
				.optional()
				.describe("Insert immediately BEFORE the cell with this id."),
			after: z
				.string()
				.optional()
				.describe("Insert immediately AFTER the cell with this id."),
			index: z
				.number()
				.int()
				.optional()
				.describe(
					"Absolute 0-based index. Only used when neither before nor after is given.",
				),
		}),
		execute: async (args) => {
			const { addCellAtIndex, cells } = useNotebookStore.getState();

			// Resolve the insert position. Relative placement (before/after a
			// cell id) is preferred and unambiguous; index is a fallback.
			let insertIndex: number;
			if (args.before) {
				const i = cells.findIndex((c) => c.id === args.before);
				insertIndex = i >= 0 ? i : cells.length;
			} else if (args.after) {
				const i = cells.findIndex((c) => c.id === args.after);
				insertIndex = i >= 0 ? i + 1 : cells.length;
			} else if (typeof args.index === "number") {
				insertIndex = Math.max(0, Math.min(args.index, cells.length));
			} else {
				// Default: directly below the current (active) cell.
				const activeIndex =
					useNotebookStore.getState().activeCellIndex;
				insertIndex = Math.min(activeIndex + 1, cells.length);
			}

			const cell = addCellAtIndex(
				insertIndex,
				args.source,
				args.cell_type,
				args.cell_type === "markdown" ? "command" : "edit",
				undefined,
				"assistant",
				"agent",
			);
			focusCell(cell.id as string);
			return { created: true, id: cell.id, index: insertIndex };
		},
	}),

	edit_cell: tool({
		description:
			"Replace the entire source of an existing cell. Provide the complete new source, not a diff.",
		inputSchema: z.object({
			...cellLocator,
			source: z
				.string()
				.describe("The new full source to replace the cell's contents."),
		}),
		execute: async (args) => {
			const resolved = resolveCell(args);
			if (!resolved) {
				return { error: "No cell found for the given id/index." };
			}
			focusCell(resolved.id);
			useNotebookStore.getState().setCellSource(resolved.id, args.source);
			return { edited: true, id: resolved.id, index: resolved.index };
		},
	}),

	run_cell: tool({
		description:
			"Execute a code cell in the kernel and return its outputs. Inspect the result and fix the cell if an error occurred.",
		inputSchema: z.object(cellLocator),
		execute: async (args) => {
			const resolved = resolveCell(args);
			if (!resolved) {
				return { error: "No cell found for the given id/index." };
			}
			focusCell(resolved.id);
			await useNotebookStore.getState().executeCell(resolved.id);

			const updated = useNotebookStore
				.getState()
				.cells.find((cell) => cell.id === resolved.id) as
				| ThreadNotebookCell
				| undefined;
			const outputs = updated ? formatCellOutputs(updated) : [];
			const errorOccurred = outputs.some(
				(output: any) => output.errorOccurred,
			);
			return { ran: true, id: resolved.id, errorOccurred, outputs };
		},
	}),

	delete_cell: tool({
		description: "Delete a cell from the notebook by id or index.",
		inputSchema: z.object(cellLocator),
		execute: async (args) => {
			const resolved = resolveCell(args);
			if (!resolved) {
				return { error: "No cell found for the given id/index." };
			}
			useNotebookStore.getState().deleteCell(resolved.id);
			return { deleted: true, id: resolved.id };
		},
	}),

	move_cell: tool({
		description:
			"Move an existing cell to a new position. Identify the cell to move with `id`. Choose the destination with exactly one of: `to_end` (make it the last cell), `to_start` (first cell), `before`/`after` another cell's id, or an absolute `index`.",
		inputSchema: z.object({
			id: z.string().describe("Id of the cell to move."),
			to_end: z
				.boolean()
				.optional()
				.describe("Move it to the very end (last cell)."),
			to_start: z
				.boolean()
				.optional()
				.describe("Move it to the very start (first cell)."),
			before: z
				.string()
				.optional()
				.describe("Place it immediately BEFORE this cell id."),
			after: z
				.string()
				.optional()
				.describe("Place it immediately AFTER this cell id."),
			index: z
				.number()
				.int()
				.optional()
				.describe("Absolute final 0-based position."),
		}),
		execute: async (args) => {
			const { cells, moveCellToIndex } = useNotebookStore.getState();
			if (cells.findIndex((c) => c.id === args.id) === -1) {
				return { error: `No cell with id ${args.id}.` };
			}
			// Compute the destination against the notebook WITHOUT the cell being
			// moved, so positions don't drift once it's removed.
			const without = cells.filter((c) => c.id !== args.id);
			let target: number;
			if (args.to_start) {
				target = 0;
			} else if (args.to_end) {
				target = without.length;
			} else if (args.before) {
				const i = without.findIndex((c) => c.id === args.before);
				target = i >= 0 ? i : without.length;
			} else if (args.after) {
				const i = without.findIndex((c) => c.id === args.after);
				target = i >= 0 ? i + 1 : without.length;
			} else if (typeof args.index === "number") {
				target = Math.max(0, Math.min(args.index, without.length));
			} else {
				return {
					error: "Specify one of to_end, to_start, before, after, or index.",
				};
			}
			moveCellToIndex(args.id, target);
			focusCell(args.id);
			return { moved: true, id: args.id, index: target };
		},
	}),
};

export type AgentTools = typeof agentTools;
