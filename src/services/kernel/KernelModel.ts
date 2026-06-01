import { IOutput } from "@jupyterlab/nbformat";
import { Kernel, KernelMessage } from "@jupyterlab/services";
import {
	IFuture,
	IKernelConnection,
} from "@jupyterlab/services/lib/kernel/kernel";
import {
	IExecuteReplyMsg,
	IExecuteRequestMsg,
} from "@jupyterlab/services/lib/kernel/messages";
import { ISessionConnection } from "@jupyterlab/services/lib/session/session";
import { PartialJSONObject } from "@lumino/coreutils/types";
import { ISignal, Signal } from "@lumino/signaling";
import { captureException } from "@sentry/nextjs";
import {
	IPYWIDGET_STATE_MIMETYPE,
	IPYWIDGET_VIEW_MIMETYPE,
} from "../../components/cell/output/mimeTypes";
import { useNotebookStore } from "../../components/notebook/store/NotebookStore";
import { ThreadNotebookCell } from "../../types/code.types";
import { multilineStringToString } from "../../utils/utils";
import TextEmbeddingModel from "../embedding/TextEmbedder";

let widgetUpdateBuffer: { view: any; state: any } = { view: null, state: {} };

export class KernelModel {
	// Initialize an empty queue
	taskQueue = Promise.resolve();
	queueCleared = false;

	constructor(session: ISessionConnection) {
		this.session = session;
		this.kernel = session.kernel;
	}

	get future(): Kernel.IFuture<
		KernelMessage.IExecuteRequestMsg,
		KernelMessage.IExecuteReplyMsg
	> | null {
		return this._future;
	}

	set future(
		value: Kernel.IFuture<
			KernelMessage.IExecuteRequestMsg,
			KernelMessage.IExecuteReplyMsg
		> | null,
	) {
		this._future = value;
		if (!value) {
			return;
		}
		value.onIOPub = this._onIOPub;
		value.onReply = this._onReply;
		value.onStdin = (msg) => {
			console.log("onStdin: ", msg);
		};
	}

	set cellId(index: string) {
		this._currentlyProcessingCellId = index;
	}

	get cellId(): string {
		return this._currentlyProcessingCellId ?? "";
	}

	set cell(cell: ThreadNotebookCell) {
		this._currentlyProcessingCell = cell;
	}

	get cell(): ThreadNotebookCell | null | undefined {
		return this._currentlyProcessingCell;
	}

	get output(): IOutput | null {
		return this._output;
	}

	get stateChanged(): ISignal<KernelModel, void> {
		return this._stateChanged;
	}

	get cellMetadata(): PartialJSONObject {
		if (!this.cell) {
			return {};
		}

		if (!this.cell.metadata) {
			this.cell.metadata = {};
		}

		if (!this.cell.metadata["threadNotebook"]) {
			this.cell.metadata["threadNotebook"] = {};
		}
		return this.cell.metadata["threadNotebook"] as PartialJSONObject;
	}

	clearQueue(): void {
		this.queueCleared = true;
		this.taskQueue = this.taskQueue.then(() => {
			this.queueCleared = false;
			return Promise.resolve();
		});
	}

	execute(cellIds: string[]): Promise<void> {
		if (!this.session?.kernel) {
			return Promise.resolve();
		}

		for (const cellId of cellIds) {
			const {
				cells,
				getCellIndexById,
				setCurrentlyExecutingCell,
				executingCells,
			} = useNotebookStore.getState();

			// Skip cells already queued or running. When several cells are run
			// back to back, each one's reactive cascade re-requests its
			// downstream cells — which are often already queued by a direct run
			// or an earlier cascade. Deduping the queue here (the single point
			// every execution path flows through) drops those redundant
			// re-runs so each cell executes at most once per in-flight batch.
			if (executingCells.has(cellId)) {
				continue;
			}

			const index = getCellIndexById(cellId);
			const cell = cells[index];
			if (!cell || !cell.source) continue;
			const code = multilineStringToString(cell.source);

			this._clearCellOutputs(cellId);
			this._addCellExecuting(cellId);

			// Add the task to the queue
			this.taskQueue = this.taskQueue.then(async () => {
				if (!this.kernel) {
					return;
				}

				// If the queue has been cleared, then skip this task.
				if (this.queueCleared) {
					this._removeExecutingCell(cellId);
					return;
				}

				// Set the currently processing cell to be able to edit it's outputs in the listener
				this.cell = cell;
				this.cellId = cell.id as string;
				setCurrentlyExecutingCell(cellId);

				this.preProcessCellExecutionOperations(code);

				this.future =
					this.kernel?.requestExecute({
						code,
					}) ?? null;

				this.cellMetadata["ran"] = true;
				try {
					await this.future?.done;
					await this.postCellExecutionOperations(cell);
				} catch (error) {
					captureException(error);
					console.error(error);
				} finally {
					setCurrentlyExecutingCell(undefined);
				}
			});
		}

		// Return a promise that resolves when all cell executions within this invocation have completed
		return this.taskQueue;
	}

	preProcessCellExecutionOperations(code: string): void {}

	async postCellExecutionOperations(
		cell: ThreadNotebookCell,
	): Promise<(IFuture<IExecuteRequestMsg, IExecuteReplyMsg> | null)[]> {
		// Used to capture the current variables in the execution state
		if (!this.kernel) {
			return Promise.all([]);
		}
		const code = multilineStringToString(cell.source);
		try {
			this.cellMetadata["embedding"] =
				TextEmbeddingModel.getInstance().embed(
					code,
				) as any as PartialJSONObject;
		} catch (error) {
			console.error(error);
		}

		// Update the reactive dependency graph from what just ran. Awaited so
		// the graph reflects this cell's deps before executeCell computes the
		// reactive cascade in its .then(); it manages its own errors.
		await useNotebookStore
			.getState()
			.onCellExecuted(cell.id as string, code);

		return Promise.all([]);
	}

	silentExecute(
		code: string,
		callback: (msg: KernelMessage.IIOPubMessage) => void,
	): Kernel.IFuture<
		KernelMessage.IExecuteRequestMsg,
		KernelMessage.IExecuteReplyMsg
	> | null {
		if (!this.kernel) {
			return null;
		}

		const future = this.kernel.requestExecute({
			code,
			silent: true,
			store_history: false,
		});

		future.onIOPub = callback;
		return future;
	}

	interruptKernel(): void {
		if (!this.kernel) {
			return;
		}

		this.clearQueue();
		this.kernel.interrupt();
	}

	private _onIOPub = (msg: KernelMessage.IIOPubMessage): void => {
		const msgType = msg.header.msg_type;

		switch (msgType) {
			case "execute_result":
			case "display_data":
			case "stream":
			case "error":
				this._addCellOutput(this.cellId, {
					output_type: msgType,
					...msg.content,
				});
				break;
			case "clear_output":
				this._clearCellOutputs(this.cellId);
				break;
			case "update_display_data":
				this._output = msg.content as IOutput;
				this._stateChanged.emit();
				break;
			case "comm_open":
				this._onCommOpen(msg);
				break;
			case "status":
				this._onStatusChange(msg);
				break;
			default:
				break;
		}
		return;
	};

	private _onReply = (msg: KernelMessage.IExecuteReplyMsg): void => {
		const msgType = msg.header.msg_type;
		switch (msgType) {
			case "execute_reply":
				this._removeExecutingCell(this.cellId);
				if (!msg.content.execution_count) {
					this._setExecutionCount(this.cellId, null);
				} else {
					this._setExecutionCount(
						this.cellId,
						msg.content.execution_count!,
					);
				}
				break;
			default:
				break;
		}
		return;
	};

	private _future: Kernel.IFuture<
		KernelMessage.IExecuteRequestMsg,
		KernelMessage.IExecuteReplyMsg
	> | null = null;

	private _silentFuture: Kernel.IFuture<
		KernelMessage.IExecuteRequestMsg,
		KernelMessage.IExecuteReplyMsg
	> | null = null;

	private _addCellExecuting = useNotebookStore.getState().addExecutingCell;
	private _removeExecutingCell =
		useNotebookStore.getState().removeExecutingCell;
	private _setExecutionCount = useNotebookStore.getState().setExecutionCount;
	private _clearCellOutputs = useNotebookStore.getState().clearCellOutputs;
	private _addCellOutput = useNotebookStore.getState().addCellOutput;

	private _getCellOutput(): any {
		if (!this.cell!.outputs || (this.cell!.outputs as any).length === 0) {
			const output = {
				data: {},
				metadata: {},
				output_type: "display_data",
			};
			(this.cell as any).outputs = [output];
			return output;
		}

		return (this.cell?.outputs as any)?.[0];
	}

	private _onCommOpen = (msg: KernelMessage.IIOPubMessage): void => {
		const messageContent = msg.content as any;
		const commId = messageContent.comm_id;
		const modelData = messageContent.data;

		// Buffer the view data
		widgetUpdateBuffer.view = {
			model_id: commId,
			version_major: modelData.state._view_module_version.split(".")[0],
			version_minor: modelData.state._view_module_version.split(".")[1],
		};

		// Buffer the state data
		widgetUpdateBuffer.state[commId] = {
			model_name: modelData.state._model_name,
			model_module: modelData.state._model_module,
			model_module_version: modelData.state._model_module_version,
			state: {
				...modelData.state,
			},
		};
	};

	private _onStatusChange = (msg: KernelMessage.IIOPubMessage): void => {
		if ((msg.content as any).execution_state === "idle") {
			this._applyBufferedUpdates();
		}
	};

	private _applyBufferedUpdates = (): void => {
		// Check if the buffer is empty
		if (
			!widgetUpdateBuffer.view &&
			Object.keys(widgetUpdateBuffer.state).length === 0
		) {
			return;
		}

		const cellOutput = {} as any;

		if (!cellOutput.data) {
			cellOutput.data = {};
		}

		// Apply view data
		cellOutput.data[IPYWIDGET_VIEW_MIMETYPE] = widgetUpdateBuffer.view;

		// Apply state data
		cellOutput.data[IPYWIDGET_STATE_MIMETYPE] = {
			version_major: 2,
			version_minor: 0,
			state: widgetUpdateBuffer.state,
		};

		// Clear the buffer
		widgetUpdateBuffer = { view: null, state: {} };

		this._addCellOutput(this.cellId, {
			...this._getCellOutput(),
			output_type: "execute_result",
			...cellOutput,
		});

		this._stateChanged.emit();
	};

	// Currently processing cell
	private _currentlyProcessingCell: ThreadNotebookCell | null | undefined;
	private _currentlyProcessingCellId: string | undefined;
	private _output: IOutput | null = null;
	private session: ISessionConnection;
	private kernel: IKernelConnection | null;
	private _stateChanged = new Signal<KernelModel, void>(this);
}

export default KernelModel;
