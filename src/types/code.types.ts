import { ICell } from "@jupyterlab/nbformat";

export type CodeLine = {
	c: string;
	l: number;
};

export type ThreadNotebookCell = ICell & {
	metadata: {
		threadNotebook?: Record<string, any>;
	};
};

/**
 * Static dependency information for a single cell, as reported by the
 * server-side extractor (pure AST analysis, no execution).
 *
 *  - `defines`  names the cell binds at top level (other cells may read them)
 *  - `reads`    free names the cell references that another cell must define
 *  - `imports`  names introduced by imports (a subset of `defines`)
 *  - `deletes`  names removed with top-level `del`
 *  - `mutates`  names the cell probably mutates in place (heuristic, advisory)
 *  - `errors`   parse errors; when present the other fields are empty
 */
export interface CellDependencies {
	defines: string[];
	reads: string[];
	imports: string[];
	deletes: string[];
	mutates: string[];
	errors: string[];
}
