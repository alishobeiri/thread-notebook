import { captureException } from "@sentry/nextjs";
import { CellDependencies } from "../../types/code.types";
import ConnectionManager from "../connection/connectionManager";

/**
 * Front-end boundary for cell dependency extraction.
 *
 * Today this delegates to the server extension's `/api/extract-deps` endpoint,
 * which runs pure-AST static analysis in the Jupyter server's Python. The rest
 * of the app depends only on the {@link extractDependencies} signature, so the
 * implementation (server endpoint, in-kernel injection, or a future client-side
 * parser) can be swapped without touching the reactive graph in the store.
 */

const EMPTY: CellDependencies = {
	defines: [],
	reads: [],
	imports: [],
	deletes: [],
	mutates: [],
	errors: [],
};

/**
 * Extract the static dependencies of a single cell's source.
 *
 * Never throws: on any transport or parse failure it returns `null`, and the
 * caller leaves the cell's existing dependency record untouched.
 */
export async function extractDependencies(
	source: string,
): Promise<CellDependencies | null> {
	if (!source || !source.trim()) {
		return EMPTY;
	}

	const connectionManager = ConnectionManager.getInstance();
	const serverUrl = connectionManager.serverUrl;
	const token = connectionManager.serverSettings?.token ?? "";

	if (!serverUrl) {
		return null;
	}

	try {
		const response = await fetch(
			`${serverUrl}/thread-notebook/api/extract-deps?token=${token}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ source }),
			},
		);

		if (!response.ok) {
			return null;
		}

		return (await response.json()) as CellDependencies;
	} catch (error) {
		captureException(error);
		console.error("Failed to extract cell dependencies:", error);
		return null;
	}
}
