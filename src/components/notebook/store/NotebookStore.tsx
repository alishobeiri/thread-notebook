import { ICell, ICodeCell, IMarkdownCell, IOutput } from "@jupyterlab/nbformat";
import { PartialJSONObject } from "@lumino/coreutils/types";
import { captureException } from "@sentry/nextjs";
import { NextRouter } from "next/router";
import { v4 as uuidv4 } from "uuid";
import { temporal } from "zundo";
import { create } from "zustand";
import useApiCallStore from "../../../hooks/useApiCallStore";
import ConnectionManager, {
	useConnectionManagerStore,
} from "../../../services/connection/connectionManager";
import { standaloneToast } from "../../../theme";
import { extractDependencies } from "../../../services/dependency/dependencyService";
import { CellDependencies, ThreadNotebookCell } from "../../../types/code.types";
import {
	NotebookFile,
	NotebookMetadata,
	ThreadNotebookFile,
} from "../../../types/file.types";
import { magicQuery } from "../../../utils/magic/magicQuery";
import { trackEventData } from "../../../utils/posthog";
import { normalizeCell } from "../../../utils/conversions";
import { multilineStringToString, newUuid } from "../../../utils/utils";
import { enableCommandMode } from "../../cell/actions/actions";
import { refresh } from "../../sidebar/filesystem/FileSystemToolbarUtils";
import debounce from "lodash.debounce";
export type ICellTypes = "markdown" | "code" | "rawNB";
export type NotebookMode = "command" | "edit";
export type ExecutionCountTypes = number | null;

export interface MarkdownCell extends IMarkdownCell {
	rendered: boolean;
	cell_type: "markdown";
}

const createCodeCell = (source: string = ""): ICodeCell & { id: string } => ({
	id: uuidv4(),
	cell_type: "code",
	source,
	outputs: [],
	metadata: {},
	execution_count: null,
});

const createMarkdownCell = (
	source: string = "",
): IMarkdownCell & { id: string } => ({
	id: uuidv4(),
	cell_type: "markdown",
	source,
	metadata: {},
});

export const createNewCell = (): ICell => createCodeCell();

const debounceFn = debounce(async (fn: () => Promise<void>) => {
	await fn();
}, 2000);

export interface INotebookStore {
	files: ThreadNotebookFile[];

	path: string;
	setPath: (path: string) => void;

	router: NextRouter;
	setRouter: (router: NextRouter) => void;

	selectedNotebook: NotebookFile | undefined;
	isFetchingNotebooks: boolean;
	isFetchingFiles: boolean;
	filesBeingUploaded: ThreadNotebookFile[];
	setIsFetchingNotebooks: (isFetching: boolean) => void;
	setIsFetchingFiles: (isFetching: boolean) => void;
	setNotebooks: (notebooks: ThreadNotebookFile[]) => void;
	refreshFiles: (
		path?: string,
		silent?: boolean,
	) => Promise<ThreadNotebookFile[]>;
	deleteFile: (
		file: ThreadNotebookFile,
		router?: NextRouter,
	) => Promise<void>;
	downloadFile: (file: ThreadNotebookFile) => Promise<void>;
	setFiles: (files: ThreadNotebookFile[]) => void;
	setSelectedNotebook: (notebook: NotebookFile | undefined) => void;

	fileContents: NotebookFile | undefined;
	setFileContents: (fileContents?: NotebookFile) => void;
	getFileContents: () => NotebookFile | undefined | null;

	getNotebookPath: (notebook?: NotebookFile) => string;
	getNotebookName: () => string | undefined;
	setNotebookName: (
		newName: string,
	) => Promise<{ success: boolean; error: string | null }>;
	setNotebookSettings: () => Promise<void>;

	setNotebookId: (id: string) => void;
	getNotebookId: (notebook?: NotebookFile) => string;

	setSessionId: (id: string) => void;
	getSessionId: () => string | undefined;

	setKernelId: (id: string) => void;
	getKernelId: () => string | undefined;

	cells: ThreadNotebookCell[];
	metadata: NotebookMetadata;

	// Cell related functions
	setCells: (newCells: ICell[]) => void;
	addCell: (source?: string, type?: ICellTypes) => ICell;
	addCellAtIndex: (
		index: number,
		source?: string,
		type?: ICellTypes,
		mode?: NotebookMode,
		group?: string,
		user?: "user" | "assistant",
		action?: string,
	) => ICell;
	setCellSource: (cellId: string, newSource: string) => void;
	setCellUser: (cellId: string, user: "user" | "assistant") => void;
	setActiveCellSource: (newSource: string) => void;
	deleteCell: (cellId: string) => void;
	deleteActiveCell: () => void;
	setCellType: (cellId: string, newType: ICellTypes) => void;
	setCellGroup: (id: string, group: string) => void;
	setCellOutputs: (cellId: string, newOutputs: IOutput[]) => void;
	addCellOutput: (cellId: string, newOutput: IOutput) => void;
	moveCell: (direction: "up" | "down") => void;
	resetState: () => void;
	clearNotebook: () => void;
	clearCellOutputs: (cellId: string) => void;
	resetExecutionCounts: () => void;
	setExecutionCount: (cellId: string, count: ExecutionCountTypes) => void;
	getActiveCell: () => ICell;
	setActiveCell: (cellId: string) => void;
	clampIndex: (index: number, max?: number) => number;
	getCellIndexById: (id: string) => number;

	isGeneratingCells: boolean;
	addedGeneratedCell: boolean;
	userAbortedMagicQueryController: AbortController;
	abortMagicQuery: () => void;
	magicQuery: (prompt: string) => void;

	activeCellIndex: number;
	notebookMode: NotebookMode;

	setNotebookMode: (newType: NotebookMode) => void;
	setMarkdownCellRendered: (cellId: string, rendered: boolean) => void;
	executeAllCells: () => void;
	executeSelectedCells: () => void;
	executeCell: (cellId: string) => void;
	executeSelectedCellsAndAdvance: () => void;

	isLoadingNotebook: boolean;
	createNewNotebook: (kernelSelection?: string) => void;
	selectNotebook: (
		notebook: NotebookFile,
		kernelSelection?: string,
	) => NotebookFile;
	handleNotebookClick: (notebook: ThreadNotebookFile) => Promise<void>;
	navigateToPath: (path: string) => void;
	handleSave: () => void;
	isSaving: boolean;
	lastSaveTime: number;

	currentExecutingCell: string;
	executingCells: Set<string>;
	addExecutingCell: (cellId: string) => void;
	removeExecutingCell: (cellId: string) => void;
	setExecutingCells: (cellIds: string[]) => void;
	setCurrentlyExecutingCell: (cellId: string | undefined) => void;

	// --- Reactive dependency graph ---------------------------------------
	// All of this is computed at *execution* time (the kernel namespace only
	// reflects cells that have run). Editing a cell never re-extracts deps; it
	// only makes the cell "dirty" (its source no longer matches its last run),
	// which is derived on demand from lastExecutedSource.

	// cellId -> dependencies recorded at that cell's most recent execution.
	cellDependencies: Record<string, CellDependencies>;
	// cellId -> monotonic order of its last execution (for owner resolution).
	cellRunOrder: Record<string, number>;
	// cellId -> source as of its last execution (for the dirty check).
	lastExecutedSource: Record<string, string>;
	// Monotonically increasing counter; each execution takes the next value.
	runCounter: number;
	// Cells whose inputs changed upstream since they last ran.
	staleCells: Set<string>;

	// Record an execution: extract deps, update the graph, propagate staleness
	// to direct dependents. Called from the post-execution hook.
	onCellExecuted: (cellId: string, source: string) => Promise<void>;
	getCellDependencies: (cellId: string) => CellDependencies | undefined;
	// Cells reading a name this cell defines/mutates (its direct dependents).
	getDownstreamCells: (cellId: string) => string[];
	// Owner cells defining a name this cell reads (most-recently-run wins).
	getUpstreamCells: (cellId: string) => string[];
	isCellStale: (cellId: string) => boolean;
	isCellDirty: (cellId: string) => boolean;
	clearCellStale: (cellId: string) => void;
}

export const useNotebookStore = create<INotebookStore>()(
	temporal(
		(set, get) =>
			({
				path: "/",
				notebooks: [] as NotebookFile[],
				files: [] as ThreadNotebookFile[],
				selectedNotebook: undefined,
				isFetchingNotebooks: false,
				isGeneratingCells: false,

				// There is a delay between when generation starts and when a cell is added to the notebook
				addedGeneratedCell: false,
				refreshFiles: (path: string, silent: boolean = false) => {
					const { setFiles, setPath } = get();

					if (!silent) {
						set({ isFetchingFiles: true });
					}
					return refresh(path)
						.then((contents) => {
							setPath(path);
							if (!contents) {
								return [] as ThreadNotebookFile[];
							}
							if (!contents.sort) {
								console.log(contents);
							}
							const sortedContent = contents.sort((a, b) => {
								// First, sort by type
								const typeComparison = a.type.localeCompare(
									b.type,
								);

								if (typeComparison !== 0) {
									return typeComparison;
								}

								// If types are the same, then sort by name
								return a.name.localeCompare(b.name);
							});

							setFiles(sortedContent as ThreadNotebookFile[]);

							return sortedContent;
						})
						.catch((error) => {
							captureException(error);
							console.error(
								"Ran into error while navigating to path: ",
								error,
							);
							return [] as ThreadNotebookFile[];
						})
						.finally(() => {
							if (!silent) {
								set({ isFetchingFiles: false });
							}
						});
				},
				deleteFile: async (file: ThreadNotebookFile) => {
					const { path } = get();

					const isFile = "last_modified" in file;
					trackEventData(
						isFile
							? "[Files] Deleting File"
							: "[Files] Deleting Notebook",
					);
					try {
						const connectionManager =
							ConnectionManager.getInstance();
						await connectionManager.serviceManager!.contents.delete(
							file.name,
						);

						get().refreshFiles(path);

						standaloneToast({
							title: "File deleted",
							description: `This file (${file.name}) has been deleted.`,
							status: "success",
							duration: 5000,
							isClosable: true,
						});
					} catch (error) {
						console.error("Error deleting item: ", error);
						return Promise.resolve();
					} finally {
						get().refreshFiles(path, true);
					}
				},
				setFiles: (files: ThreadNotebookFile[]) =>
					set({ files: files }),
				setSelectedNotebook: (notebook?: NotebookFile) =>
					set({
						selectedNotebook: notebook,
						isLoadingNotebook: false,
					}),
				cells: [],
				notebookMode: "command",
				activeCellIndex: 0,
				executingCells: new Set(),
				fileContents: undefined,
				metadata: {},

				// Reactive dependency graph (see interface for semantics).
				cellDependencies: {},
				cellRunOrder: {},
				lastExecutedSource: {},
				runCounter: 0,
				staleCells: new Set<string>(),

				setPath: (path: string) => set({ path: path }),
				setFileContents: (fileContents?: NotebookFile) => {
					if (!fileContents) {
						set({ fileContents: undefined, cells: [] });
						return;
					}

					const cells = fileContents.cells ? fileContents.cells : [];
					if (cells.length == 0) {
						set({
							fileContents: fileContents,
							cells: [createNewCell()],
							metadata: {
								...fileContents.metadata,
							},
							activeCellIndex: 0,
						});
					} else {
						let notebookMode = "edit" as NotebookMode;
						const cells = fileContents?.cells ?? [];

						// If the first cell is markdown, begin the notebook in command mode. This allows for first markdown cell to be rendered
						if (
							cells &&
							cells.length > 0 &&
							cells[0].cell_type === "markdown"
						) {
							notebookMode = "command";
						}

						set({
							fileContents: fileContents,
							cells: cells.map((cell) => {
								const normalizedCell = normalizeCell(cell);
								let user = "assistant";
								if (normalizedCell.cell_type === "markdown") {
									get().setMarkdownCellRendered(
										normalizedCell.id as string,
										true,
									);
								}

								return {
									...normalizedCell,
									id: normalizedCell.id ?? newUuid(),
									metadata: {
										...normalizedCell.metadata,
										threadNotebook: {
											...(normalizedCell.metadata
												.threadNotebook as PartialJSONObject),
											ran: false,
											user: user,
										},
									},
								};
							}),
							metadata: {
								...fileContents.metadata,
							},
							activeCellIndex: 0,
							notebookMode: notebookMode,
						});
					}
				},
				getFileContents: () => {
					const fileContents = get().fileContents;

					const cells = get().cells;
					const metadata = get().metadata;

					if (!fileContents) {
						return undefined;
					}
					fileContents.cells = cells;
					fileContents.metadata = metadata;

					return fileContents as NotebookFile;
				},
				setCellGroup: (id: string, group: string) => {
					const { cells } = get();
					const index = cells.findIndex((cell) => cell.id === id);
					if (index === -1) {
						return;
					}

					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];

						// Update the code of the cell at the specified index
						updatedCells[index] = {
							...updatedCells[index],
							metadata: {
								...updatedCells[index],
								threadNotebook: {
									group,
								},
							},
						};

						// Return the updated state
						return {
							cells: updatedCells,
						};
					});
					get().handleSave();
				},
				getNotebookName: () => {
					const path = get().getNotebookPath();
					if (!path) {
						return undefined;
					}
					return path.split("/").pop();
				},
				setNotebookName: async (newName: string) => {
					return ConnectionManager.getInstance()
						.renameFile(get().getNotebookPath(), newName)
						.then((result) => {
							get().refreshFiles(get().path);
							return result;
						});
				},
				getNotebookId: (notebook?: NotebookFile) => {
					// Returns the current notebook's ID (if it exists) or the provided notebook's ID if provided
					console.log("getNotebookById");
					console.log(notebook);
					console.log(get().selectedNotebook);
					return "123";
				},
				setNotebookId: (notebookId: string) => {
					const metadata = get().metadata;
					if (!metadata || !metadata.threadNotebook) {
						return;
					}

					set((state) => ({
						metadata: {
							...state.metadata,
							threadNotebook: {
								...metadata.threadNotebook,
								id: notebookId,
							},
						},
					}));

					// Save the notebook to save the ID after it is set
					get().handleSave();
				},
				setSessionId: (id: string) => {
					const { metadata } = get();
					set({
						metadata: {
							...metadata,
							threadNotebook: {
								...metadata.threadNotebook,
								sessionId: id,
							},
						},
					});
				},
				getSessionId: () => {
					let sessionId;
					const { metadata } = get().metadata;
					if (metadata && metadata.threadNotebook) {
						sessionId = metadata.threadNotebook.sessionId;
					}
					return sessionId;
				},
				setKernelId: (id: string) => {
					const { metadata } = get();
					set({
						metadata: {
							...metadata,
							threadNotebook: {
								...metadata.threadNotebook,
								kernelId: id,
							},
						},
					});
				},
				getKernelId: () => {
					let kernelId;
					const { metadata } = get().metadata;
					if (metadata && metadata.threadNotebook) {
						kernelId = metadata.threadNotebook.kernelId;
					}
					return kernelId;
				},
				getNotebookPath: () => {
					const { router } = get();
					if (router) {
						return get().router.query.path;
					}
					return "";
				},
				clampIndex: (index: number, max?: number) => {
					return Math.min(
						Math.max(index, 0),
						max ?? get().cells.length - 1,
					);
				},
				getCellIndexById: (id: string) => {
					const { cells } = get();
					const cellIndex = cells.findIndex((cell) => cell.id === id);
					return cellIndex;
				},

				userAbortedMagicQueryController: new AbortController(),
				abortMagicQuery: () => {
					get().userAbortedMagicQueryController.abort();
					// Interrupt code execution if running
					ConnectionManager.getInstance().kernel?.interrupt();
				},
				magicQuery: async (prompt: string) => {
					// Reset the abort controller right away
					set({
						isGeneratingCells: true,
						userAbortedMagicQueryController: new AbortController(),
					});

					trackEventData("[MagicQuery] submitted");

					const shouldContinue = useApiCallStore
						.getState()
						.checkAndIncrementApiCallCount();

					if (!shouldContinue) {
						return;
					}

					try {
						await magicQuery(prompt);
					} catch (e: any) {
						console.error(e);
					} finally {
						set({
							isGeneratingCells: false,
							addedGeneratedCell: false,
						});
					}
				},
				setCellSource: (cellId: string, newSource: string) => {
					const index = get().getCellIndexById(cellId);
					if (index === -1) {
						return;
					}

					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];

						// Update the code of the cell at the specified index
						updatedCells[index] = {
							...updatedCells[index],
							source: newSource,
						};

						// Return the updated state
						return {
							cells: updatedCells,
						};
					});
					get().handleSave();
				},
				setCellUser: (cellId: string, user: "user" | "assistant") => {
					const index = get().getCellIndexById(cellId);
					if (index === -1) {
						return;
					}

					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];

						// Update the user of the cell at the specified index
						updatedCells[index] = {
							...updatedCells[index],
							metadata: {
								threadNotebook: {
									...updatedCells[index].metadata
										.threadNotebook,
									user,
								},
							},
						};

						// Return the updated state
						return {
							cells: updatedCells,
						};
					});
					get().handleSave();
				},
				setActiveCellSource: (newSource: string) => {
					const activeCellIndex = get().activeCellIndex;
					const cell = get().cells[activeCellIndex];
					const prevSource = cell.source as string;
					if (newSource == prevSource) {
						// Since we recreate the cells, it causes a full re-render
						// don't re-render unless the cell source changes
						return;
					}

					set((state) => {
						const cells = [...state.cells];
						// update active cell's source with newSource
						cells[activeCellIndex] = {
							...cells[activeCellIndex],
							source: newSource,
						};

						return {
							cells,
						};
					});
					get().handleSave();
				},
				deleteCell: (cellId: string) => {
					const cells = [...get().cells];
					let index = get().getCellIndexById(cellId);

					trackEventData("[NOTEBOOK] delete cell");

					if (cells.length === 1) {
						const newCell = createNewCell();

						set(() => ({
							cells: [newCell],
							activeCellIndex: index,
						}));
						return;
					} else {
						cells.splice(index, 1);

						// handles case for deleting the last cell
						if (index === cells.length) index -= 1;
						set(() => ({
							cells: cells,
							activeCellIndex: index,
						}));
					}
					get().handleSave();
				},
				deleteActiveCell: () => {
					const activeCellIndex = get().activeCellIndex;
					const cells = [...get().cells];
					const clampedIndex = get().clampIndex(
						activeCellIndex,
						Math.max(0, cells.length - 2),
					);

					if (cells.length === 1) {
						const newCell = createNewCell();

						set(() => ({
							cells: [newCell],
							activeCellIndex: clampedIndex,
						}));
					} else {
						cells.splice(activeCellIndex, 1);
						set(() => ({
							cells: cells,
							activeCellIndex: clampedIndex,
						}));
					}
					get().handleSave();
				},
				setCellType: (cellId: string, newType: ICellTypes) => {
					const index = get().getCellIndexById(cellId);
					if (index == -1) {
						return;
					}

					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];

						// Update the code of the cell at the specified index
						if (newType === "markdown") {
							updatedCells[index] = normalizeCell({
								...updatedCells[index],
								cell_type: newType,
							});
						} else {
							updatedCells[index] = {
								...updatedCells[index],
								cell_type: newType,
							};
						}

						// Return the updated state
						return {
							cells: updatedCells,
						};
					});
				},
				setCellOutputs: (cellId: string, newOutputs: IOutput[]) => {
					const index = get().getCellIndexById(cellId);
					if (index == -1) {
						return;
					}
					const cell = get().cells[index];
					if (cell.cell_type == "markdown") {
						// Don't set output on markdown cells otherwise will fail verification
						return;
					}
					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];

						// Update the code of the cell at the specified index
						updatedCells[index] = {
							...updatedCells[index],
							outputs: newOutputs,
						};

						// Return the updated state
						return {
							cells: updatedCells,
						};
					});
				},
				addCellOutput: (cellId: string, newOutput: IOutput) => {
					const index = get().getCellIndexById(cellId);
					if (index === -1) {
						return;
					}
					const cell = get().cells[index];
					if (cell.cell_type === "markdown") {
						return;
					}
					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];

						// Update the code of the cell at the specified index
						updatedCells[index] = {
							...updatedCells[index],
							outputs: [
								...(updatedCells[index].outputs as IOutput[]),
								newOutput,
							],
						};

						// Return the updated state
						return {
							cells: updatedCells,
						};
					});

					get().handleSave();
				},
				resetExecutionCounts: () => {
					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];
						return {
							cells: updatedCells.map((cell) => {
								return {
									...cell,
									execution_count: null,
								};
							}),
						};
					});
				},
				setExecutionCount: (
					cellId: string,
					count: ExecutionCountTypes,
				) => {
					const index = get().getCellIndexById(cellId);
					if (index == -1) {
						return;
					}

					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];

						// Update the code of the cell at the specified index
						updatedCells[index] = {
							...updatedCells[index],
							execution_count: count,
						};

						// Return the updated state
						return {
							cells: updatedCells,
						};
					});
				},
				getActiveCell: () => {
					return get().cells[get().clampIndex(get().activeCellIndex)];
				},
				setActiveCell: (cellId: string) => {
					set((state) => {
						const indexToSet = state.getCellIndexById(cellId);
						if (indexToSet < 0) {
							console.warn(
								`Could not find cell with id: ${cellId}. Active cell index not updated.`,
							);
							return {};
						}
						return {
							activeCellIndex: indexToSet,
						};
					});
				},
				resetState: () => {
					get().abortMagicQuery();
					set(() => ({
						cells: [],
						activeCellIndex: 0,
						fileContents: undefined,
						metadata: {} as NotebookMetadata,
						selectedNotebook: undefined,
					}));
				},
				clearNotebook: () => {
					set(() => ({
						cells: [createNewCell()],
						activeCellIndex: 0,
					}));
					get().handleSave();
				},
				clearCellOutputs: (cellId: string) => {
					const index = get().getCellIndexById(cellId);
					if (index === -1) {
						return;
					}
					set((state) => {
						// Clone the cells array
						const updatedCells = [...state.cells];

						// Update the code of the cell at the specified index
						updatedCells[index] = {
							...updatedCells[index],
							outputs: [],
						};

						// Return the updated state
						return {
							cells: updatedCells,
						};
					});
					get().handleSave();
				},
				addCell: (source?: string, type?: ICellTypes) => {
					const newCell =
						type === "markdown"
							? {
									...createMarkdownCell(source || ""),
									metadata: { rendered: false },
							  }
							: createCodeCell(source || "");

					trackEventData("[NOTEBOOK] Added cell", {
						cellType: newCell.cell_type,
					});

					set((state) => {
						const newCells = [...state.cells, newCell];

						return {
							cells: newCells,
							activeCellIndex: newCells.length - 1,
						};
					});

					return newCell;
				},
				moveCell: (direction: "up" | "down") => {
					const { cells, activeCellIndex } = get();

					if (direction === "up") {
						if (activeCellIndex > 0) {
							[
								cells[activeCellIndex],
								cells[activeCellIndex - 1],
							] = [
								cells[activeCellIndex - 1],
								cells[activeCellIndex],
							];
							set((state) => ({
								...state,
								activeCellIndex: activeCellIndex - 1,
							}));
						}
					} else if (direction === "down") {
						if (activeCellIndex < cells.length - 1) {
							[
								cells[activeCellIndex],
								cells[activeCellIndex + 1],
							] = [
								cells[activeCellIndex + 1],
								cells[activeCellIndex],
							];
							set((state) => ({
								...state,
								activeCellIndex: activeCellIndex + 1,
							}));
						}
					}
				},
				addCellAtIndex: (
					index: number,
					source?: string,
					type?: ICellTypes,
					mode: NotebookMode = "command",
					group: string | undefined = undefined,
					user: "user" | "assistant" = "assistant",
					action: string | undefined = undefined,
				) => {
					if (
						type != "code" &&
						type != "markdown" &&
						type != "rawNB" &&
						type != undefined
					) {
						// Do not allow another type of string to be defined
						type = "markdown";
					}

					const newCell: ICell =
						type === "markdown"
							? {
									...createMarkdownCell(source || ""),
									metadata: {
										threadNotebook: {
											group: group || undefined,
											user,
											action: action,
										},
									},
							  }
							: {
									...createCodeCell(source || ""),
									metadata: {
										threadNotebook: {
											group: group || undefined,
											user,
											action: action,
										},
									},
							  };

					// Splice edits the array inplace
					const newCells = [
						...get().cells.map((cell) => ({ ...cell })),
					];
					newCells.splice(index, 0, newCell);
					trackEventData("[NOTEBOOK] Added cell at index", {
						cellType: newCell.cell_type,
						index: index,
					});

					set(() => ({
						cells: newCells,
						activeCellIndex: index,
						notebookMode: mode,
					}));

					return newCell;
				},
				setCells: (newCells: ICell[]) => {
					if (newCells.length == 0) {
						set({ cells: [] });
						get().addCell();
						return;
					}
					set({ cells: newCells });
				},
				setNotebookMode: (newType: NotebookMode) => {
					set({ notebookMode: newType });
				},
				setMarkdownCellRendered: (
					cellId: string,
					rendered: boolean,
				) => {
					// update markdown cell to rendered: true
					set((state) => {
						const newCells = [...state.cells];
						if (newCells.length == 0) {
							return { cells: newCells };
						}
						const cellIndex = state.getCellIndexById(cellId);

						const markdownCellToExecute = {
							...newCells[cellIndex],
						} as MarkdownCell;

						markdownCellToExecute.metadata.rendered = rendered;
						newCells[cellIndex] = markdownCellToExecute;

						return { cells: newCells };
					});
				},
				executeAllCells: async () => {
					trackEventData("[NOTEBOOK] Execute all cells", {
						cellLength: get().cells.length,
					});
					get().cells.map((cell, _) => {
						get().executeCell(cell.id as string);
					});
				},
				executeSelectedCells: () => {
					const activeCellIndex = get().activeCellIndex;
					const cell = get().cells[activeCellIndex];
					get().executeCell(cell.id as string);
				},
				executeCell: (cellId: string) => {
					const connectionManager = ConnectionManager.getInstance();
					const {
						getCellIndexById,
						refreshFiles,
						cells,
						executingCells,
						path,
					} = get();

					const index = getCellIndexById(cellId);
					const cell = cells[index];
					const { cell_type, source, outputs } = cell;

					if (!connectionManager || !connectionManager.kernel) {
						useConnectionManagerStore
							.getState()
							.openKernelSelectionModal();
					}

					const alreadyExecuting = executingCells.has(cellId);
					if (alreadyExecuting) {
						// Debounce multiple requests to execute
						console.warn(
							"Tried to execute an already executing cell",
						);
						return Promise.resolve();
					}

					trackEventData("[NOTEBOOK] Cell executed");

					// TODO: Run the active cell, add the ability to run selected cells soon
					// Only call the kernel if the code is non-empty (or there's an output that can be cleared).
					if (
						cell_type === "code" &&
						(source.length > 0 || (outputs as IOutput[]).length > 0)
					) {
						return connectionManager.kernel
							?.execute([cellId])
							.then(() => {
								// Refresh the files after each execution
								refreshFiles(path, true);
							});
					} else if (cell_type === "markdown") {
						const { setMarkdownCellRendered } = get();
						setMarkdownCellRendered(cellId, true);
						enableCommandMode();
						return Promise.resolve();
					}

					return Promise.resolve();
				},
				executeSelectedCellsAndAdvance: () => {
					const { cells, activeCellIndex } = get();
					// Run the current cell add proceed to the next (or create a new one).
					get().executeSelectedCells();

					trackEventData("[NOTEBOOK] execute cell and advance");

					// If this is the last cell, add a new one.
					if (activeCellIndex === cells.length - 1) {
						get().addCellAtIndex(activeCellIndex + 1);
					}
					set({
						activeCellIndex: activeCellIndex + 1,
					});
				},
				setCurrentlyExecutingCell: (cellId: string | undefined) => {
					set({
						currentExecutingCell: cellId,
					});
				},

				onCellExecuted: async (cellId: string, source: string) => {
					const deps = await extractDependencies(source);
					// On transport/parse failure, leave the existing record
					// untouched rather than wiping the cell out of the graph.
					if (!deps) {
						return;
					}

					set((state) => {
						const order = state.runCounter + 1;
						const cellDependencies = {
							...state.cellDependencies,
							[cellId]: deps,
						};
						const cellRunOrder = {
							...state.cellRunOrder,
							[cellId]: order,
						};
						const lastExecutedSource = {
							...state.lastExecutedSource,
							[cellId]: source,
						};

						// Names this run (re)produced. A cell that read any of
						// them in its own last run is now stale. We mark only
						// DIRECT dependents: a cell further downstream becomes
						// stale only once the cell it reads actually re-runs, at
						// which point this same logic re-propagates.
						const produced = new Set([
							...deps.defines,
							...deps.mutates,
						]);
						const staleCells = new Set(state.staleCells);
						staleCells.delete(cellId);

						for (const other of state.cells) {
							const otherId = other.id as string;
							if (otherId === cellId) {
								continue;
							}
							const otherDeps = cellDependencies[otherId];
							// Never-executed cells aren't in the live graph yet.
							if (!otherDeps) {
								continue;
							}
							const consumesProduced = otherDeps.reads.some((r) =>
								produced.has(r),
							);
							if (consumesProduced) {
								staleCells.add(otherId);
							}
						}

						return {
							cellDependencies,
							cellRunOrder,
							lastExecutedSource,
							runCounter: order,
							staleCells,
						};
					});
				},

				getCellDependencies: (cellId: string) => {
					return get().cellDependencies[cellId];
				},

				getDownstreamCells: (cellId: string) => {
					const { cellDependencies, cells } = get();
					const deps = cellDependencies[cellId];
					if (!deps) {
						return [];
					}
					const produced = new Set([
						...deps.defines,
						...deps.mutates,
					]);
					return cells
						.map((cell) => cell.id as string)
						.filter((id) => {
							if (id === cellId) {
								return false;
							}
							const otherDeps = cellDependencies[id];
							if (!otherDeps) {
								return false;
							}
							return otherDeps.reads.some((r) => produced.has(r));
						});
				},

				getUpstreamCells: (cellId: string) => {
					const { cellDependencies, cellRunOrder } = get();
					const deps = cellDependencies[cellId];
					if (!deps) {
						return [];
					}
					const owners = new Set<string>();
					for (const name of deps.reads) {
						let owner: string | undefined;
						let bestOrder = -1;
						for (const [id, otherDeps] of Object.entries(
							cellDependencies,
						)) {
							if (id === cellId) {
								continue;
							}
							if (!otherDeps.defines.includes(name)) {
								continue;
							}
							const order = cellRunOrder[id] ?? -1;
							if (order > bestOrder) {
								bestOrder = order;
								owner = id;
							}
						}
						if (owner) {
							owners.add(owner);
						}
					}
					return Array.from(owners);
				},

				isCellStale: (cellId: string) => {
					return get().staleCells.has(cellId);
				},

				isCellDirty: (cellId: string) => {
					const { lastExecutedSource, cells, getCellIndexById } =
						get();
					const recorded = lastExecutedSource[cellId];
					// A cell that has never run can't be "out of date".
					if (recorded === undefined) {
						return false;
					}
					const cell = cells[getCellIndexById(cellId)];
					if (!cell) {
						return false;
					}
					return multilineStringToString(cell.source) !== recorded;
				},

				clearCellStale: (cellId: string) => {
					set((state) => {
						if (!state.staleCells.has(cellId)) {
							return {};
						}
						const staleCells = new Set(state.staleCells);
						staleCells.delete(cellId);
						return { staleCells };
					});
				},
				setRouter: (router: NextRouter) => {
					set({ router: router });
				},

				isLoadingNotebook: false,
				createNewNotebook: async (kernelSelection?: string) => {
					const { router } = get();

					trackEventData("[NOTEBOOK] create new notebook");

					try {
						const connectionManager =
							ConnectionManager.getInstance();
						await connectionManager.ready;
						const newNotebook =
							await connectionManager.serviceManager!.contents.newUntitled(
								{
									type: "notebook",
									path: get().path,
								},
							);
						const fileContent =
							await connectionManager.getFileContents(
								newNotebook.path,
							);

						router.push({
							pathname: router.pathname,
							query: {
								...router.query,
								path: newNotebook.path,
								kernelSelection: kernelSelection,
							},
						});
						return fileContent.content;
					} catch (error) {
						console.log(error);
						standaloneToast({
							title: "Error creating new notebook",
							status: "error",
							duration: 3000,
							isClosable: true,
						});
						return;
					} finally {
						get().refreshFiles(get().path);
					}
				},
				selectNotebook: (
					notebook: NotebookFile,
					kernelSelection?: string,
				): NotebookFile => {
					set({ isLoadingNotebook: true });
					trackEventData("[NOTEBOOK] selectedNotebook");

					const { setSelectedNotebook, setFileContents } = get();

					setFileContents(notebook);
					setSelectedNotebook(notebook);
					set({ isLoadingNotebook: false });

					ConnectionManager.getInstance().connectToKernelForNotebook({
						kernelSelection,
						sessionId: notebook.metadata?.threadNotebook?.sessionId,
					});

					const router = get().router;
					const routerKernel = router.query.kernelSelection;
					if (kernelSelection && routerKernel === kernelSelection) {
						// Remove the kernel selection after it has been consumed once
						const { kernelSelection, ...updatedQuery } =
							router.query;
						router.push({
							pathname: router.pathname,
							query: updatedQuery,
						});
					}

					return notebook;
				},
				handleNotebookClick: async (
					notebookFile: ThreadNotebookFile,
				) => {
					const { selectNotebook, router } = get();

					useNotebookStore.setState({
						isLoadingNotebook: true,
					});

					const path = notebookFile.path;
					const routerPath = router.query.path;
					const kernelSelection = router.query
						.kernelSelection as string;
					if (routerPath !== path) {
						router.push({
							pathname: router.pathname,
							query: {
								...router.query,
								path: path,
							},
						});
					}

					const notebookContents =
						await ConnectionManager.getInstance().getFileContents(
							path as string,
						);

					selectNotebook(
						notebookContents.content as NotebookFile,
						kernelSelection,
					);

					useNotebookStore.setState({
						isLoadingNotebook: false,
					});
				},
				navigateToPath: (path: string) => {
					const { refreshFiles } = get();
					refreshFiles(path);
				},
				handleSave: async () => {
					const saveNotebook = async () => {
						const notebookPath = await get().getNotebookPath();
						const connectionManager =
							ConnectionManager.getInstance();
						if (
							!notebookPath ||
							!connectionManager ||
							!connectionManager.serviceManager
						) {
							return;
						}

						const fileContents = get().getFileContents();
						if (!fileContents || !fileContents.cells) return;
						const metadata = get().metadata;
						const filePath = "./" + get().getNotebookPath()!;

						set(() => ({ isSaving: true }));

						if (fileContents && fileContents.cells) {
							// Copy over the metadata before saving
							fileContents.metadata = metadata;

							// Copy over the cells before saving
							fileContents.cells = get().cells;
							try {
								ConnectionManager.getInstance().serviceManager?.contents.save(
									filePath,
									{
										type: "notebook",
										content: {
											...get().fileContents,
											cells: get().cells.map((cell) => {
												const cellCopy = {
													...normalizeCell(cell),
													metadata: {
														...cell.metadata,
													},
												};
												return cellCopy;
											}),
											metadata: get().metadata,
										},
									},
								);
							} catch (e) {
								console.error(
									"Error encountered while saving: ",
									e,
								);
							}
						}
						set(() => ({ isSaving: false }));

						get().refreshFiles(get().path, true);
					};

					debounceFn(saveNotebook);
				},
				isSaving: false,
				lastSaveTime: -1,
				addExecutingCell: (cellId: string) => {
					const newExecutingCells = new Set(get().executingCells);
					newExecutingCells.add(cellId);
					set((state) => ({
						executingCells: newExecutingCells,
					}));
				},
				removeExecutingCell: (cellId: string) => {
					const newExecutingCells = new Set(get().executingCells);
					newExecutingCells.delete(cellId);
					set((state) => ({
						executingCells: newExecutingCells,
					}));
				},
				setExecutingCells: (cellIds: string[]) => {
					set((state) => ({
						executingCells: new Set(cellIds),
					}));
				},
			} as any),
		{
			partialize: (state) => {
				const { cells, activeCellIndex } = state;
				return { cells, activeCellIndex };
			},
			equality(pastState, currentState) {
				return pastState.cells.every(
					(cell, index) => cell === currentState.cells[index],
					currentState,
				);
			},
		},
	),
);
