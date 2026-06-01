import { runAgent } from "./agent/harness";

/**
 * Single entry point for the assistant. The bottom input bar is generation-only
 * now: every request runs the local, Claude-Code-style agent harness, which
 * reads/creates/edits/runs cells through its own tool loop. The active/selected
 * cell is folded in as context (see `buildInitialMessages`), but the agent is
 * free to roam across the whole notebook.
 */
export const magicQuery = async (query: string) => {
	const trimmed = query.trim();
	if (!trimmed) return;
	await runAgent(trimmed);
};
