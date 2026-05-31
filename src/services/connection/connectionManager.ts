import { ICell } from "@jupyterlab/nbformat";
import {
	Contents,
	ServerConnection,
	ServiceManager,
	Session,
} from "@jupyterlab/services";
import { normalizeCell } from "../../utils/conversions";
import { IModel, Status } from "@jupyterlab/services/lib/kernel/kernel";
import { captureException } from "@sentry/nextjs";
import { Extension } from "@uiw/react-codemirror";
import posthog from "posthog-js";
import { create } from "zustand";
import { languageServer } from "../../components/cell/input/extensions/languageServer";
import { useNotebookStore } from "../../components/notebook/store/NotebookStore";
import { standaloneToast } from "../../theme";
import TextEmbeddingModel from "../embedding/TextEmbedder";
import Kernel from "../kernel/Kernel";

export type ConnectionOptions = {
	kernelSelection?: string;
	sessionId?: string;
	kernelId?: string;
};

export interface ServerConnection {
	serviceManager?: ServiceManager;
}

export type KernelStatus = Status;

export interface ConnectionManagerStore {
	uniqueId?: string;

	kernelStatus: KernelStatus;
	setKernelStatus: (kernelStatus: KernelStatus) => void;

	isKernelSelectionModalOpen: boolean;
	openKernelSelectionModal: () => void;
	closeKernelSelectionModal: () => void;

	setUniqueId: (uniqueId: string) => void;
}

export const useConnectionManagerStore = create<ConnectionManagerStore>(
	(set, get) => ({
		uniqueId: undefined,
		kernelStatus: "unknown",
		setKernelStatus(kernelStatus: KernelStatus) {
			set(() => {
				return {
					kernelStatus: kernelStatus,
				};
			});
		},

		isKernelSelectionModalOpen: false,
		openKernelSelectionModal: () =>
			set(() => ({ isKernelSelectionModalOpen: true })),
		closeKernelSelectionModal: () =>
			set(() => ({ isKernelSelectionModalOpen: false })),

		setUniqueId: (uniqueId: string) => set(() => ({ uniqueId })),
	}),
);

class ConnectionManager {
	static instance: ConnectionManager | null = null;
	currentNamespace: string = "";
	currentVariables: string[] = [];

	setKernelStatus = useConnectionManagerStore.getState().setKernelStatus;
	defaultKernelName = "python";

	uniqueId?: string = undefined;
	token?: string = undefined;
	serviceManager?: ServiceManager = undefined;
	sessionManager?: Session.IManager = undefined;
	serverUrl?: string = undefined;
	serverSettings?: ServerConnection.ISettings = undefined;
	kernel?: Kernel = undefined;
	serverPath?: string | undefined;
	languageServerExtension?: Extension[] = undefined;
	ready!: Promise<void>;
	_resolve!: (value?: void | PromiseLike<void>) => void;
	_reject!: (value: unknown) => void;

	private constructor() {
		this.initSignaler();
	}

	async initSignaler(): Promise<void> {
		this.ready = new Promise((resolve, reject) => {
			this._resolve = resolve;
			this._reject = reject;
		});
	}

	static getInstance(): ConnectionManager {
		if (!ConnectionManager.instance) {
			ConnectionManager.instance = new ConnectionManager();
		}
		return ConnectionManager.instance;
	}

	isServiceReady(): Promise<void[]> {
		return Promise.all([this.ready, this.serviceManager?.ready]);
	}

	async connectToServer(): Promise<ServiceManager.IManager> {
		// Extract the token from the query parameters
		const urlParams = new URLSearchParams(window.location.search);
		const token = urlParams.get("token") ?? "123";

		// Determine the server URL based on the environment
		const serverUrl =
			process.env.NODE_ENV === "production"
				? window.location.origin // Use the base URL of the page
				: "http://127.0.0.1:8888";
		this.setServerUrl(serverUrl);
		const serverSettings = this.createServerSettings(serverUrl, token);
		this.setServerSettings(serverSettings);
		const serviceManager = new ServiceManager({
			serverSettings,
		});

		this.setServiceManager(serviceManager);
		this.setSessionManager(serviceManager.sessions);
		this._resolve();

		try {
			// Load the text embedding model
			TextEmbeddingModel.getInstance();
		} catch (e) {
			console.error(e);
		}

		try {
			// Generate a unique ID for the user
			const response = await fetch(
				`${serverUrl}/thread-notebook/uniqueId?token=${token}`,
				{
					method: "GET",
				},
			);
			const uniqueId = await response.text();
			this.setUniqueId(uniqueId);
			if (uniqueId) {
				// Identify the user based on the unique ID
				posthog.identify(uniqueId);
			}
		} catch (e) {
			console.error(e);
		}

		return serviceManager;
	}

	getServiceManager() {
		if (this.serviceManager) {
			return new Promise<ServiceManager.IManager>((resolve, reject) => {
				resolve(this.serviceManager!);
			});
		} else {
			return this.connectToServer();
		}
	}
	setServerSettings(serverSettings: ServerConnection.ISettings) {
		this.serverSettings = serverSettings;
	}
	setServiceManager(serviceManager: ServiceManager) {
		this.serviceManager = serviceManager;
	}
	setSessionManager(sessionManager: Session.IManager) {
		this.sessionManager = sessionManager;
	}
	setServerUrl(serverUrl: string) {
		this.serverUrl = serverUrl;
	}

	setKernel(kernel: Kernel | undefined) {
		this.kernel = kernel;
	}

	setLanguageServerExtension(languageServerExtension: Extension[]) {
		this.languageServerExtension = languageServerExtension;
	}

	getToken(userId: string) {
		this.token = localStorage.getItem(`${userId}-token`) ?? undefined;
		return this.token;
	}

	setToken(userId: string, token?: string) {
		if (token) {
			// Save the token just in case the user logs in with multiple tokens
			localStorage.setItem(`${userId}-token`, token);
		}
		this.token = token;
	}

	setUniqueId(uniqueId: string) {
		this.uniqueId = uniqueId;
		useConnectionManagerStore.getState().setUniqueId(uniqueId);
	}

	async getNewSession({
		kernelSelection,
		kernelId,
		sessionId,
	}: ConnectionOptions) {
		if (!this.sessionManager) {
			console.error("Error occurred accessing kernel manager");
		}

		const { setSessionId, getSessionId, setKernelId, getNotebookPath } =
			useNotebookStore.getState();

		// Wait for the kernel manager to be ready
		await this.sessionManager!.ready;

		let session: Session.ISessionConnection | undefined;
		const id = getSessionId() ?? sessionId;
		const path = getNotebookPath();
		let sessionModel = null;
		if (id) {
			sessionModel = await this.sessionManager?.findById(id);
		}
		let foundKernel: IModel | undefined;
		if (kernelId) {
			foundKernel = await this.serviceManager?.kernels.findById(kernelId);
		}

		if (sessionModel) {
			session = this.sessionManager!.connectTo({ model: sessionModel });
		} else if (kernelSelection) {
			// TODO add proper kernel, name and path
			session = await this.sessionManager!.startNew({
				name: path,
				path: path,
				type: "notebook",
				kernel: {
					name: kernelSelection,
				},
			});
			if (session) {
				setSessionId(session.id);
				if (session.kernel) {
					setKernelId(session.kernel.id);
				}
			}
		} else {
			useConnectionManagerStore.getState().openKernelSelectionModal();
		}

		return session;
	}

	async connectToKernelForNotebook({
		kernelSelection,
		sessionId,
	}: ConnectionOptions) {
		// Wait for the connection manager to be ready
		await this.ready;
		await this.serviceManager?.ready;
		const session = await this.getNewSession({
			kernelSelection,
			sessionId,
		});
		if (!session) {
			this.clearKernel();
			return;
		}

		const kernel = new Kernel(session);
		const serverUri =
			`${this.serviceManager?.serverSettings.wsUrl}/lsp/ws/basedpyright?token=${this.serverSettings?.token}` as "wss://";

		kernel.ready.then(() => {
			const languageServerExtension = languageServer({
				serverUri: serverUri,
				rootUri: `file://`,
				languageId: "python",
				workspaceFolders: [],
				documentUri: "",
			});
			this.setLanguageServerExtension(languageServerExtension);
		});

		this.setKernel(kernel);
	}

	async clearKernel() {
		// Clear the kernel as we are moving away from notebook with previous kernel
		this.setKernel(undefined);
		this.setKernelStatus("unknown");
	}

	async restartKernel() {
		if (this.kernel) {
			return this.kernel.restart().catch((error) => {
				captureException(error);
				console.error("Error while restarting kernel: " + error);
			});
		}
		return new Promise((resolve, reject) => resolve(null));
	}

	createServerSettings(baseUrl: string, token?: string) {
		let wsUrl;
		try {
			if (baseUrl.startsWith("https://")) {
				wsUrl = `wss://${baseUrl.replace("https://", "")}`;
			} else if (baseUrl.startsWith("http://")) {
				wsUrl = `ws://${baseUrl.replace("http://", "")}`;
			} else {
				throw new Error(
					"Invalid baseUrl. It should start with either http:// or https://",
				);
			}
		} catch (error) {
			captureException(error);
			console.error("Error while creating server settings: " + error);

			standaloneToast({
				title: "Error connecting to server",
				description:
					"An error occured while connecting to the server. Please refresh the page and try again.",
				status: "error",
				duration: 10000,
				isClosable: true,
			});
		}

		return ServerConnection.makeSettings({
			baseUrl: `${baseUrl}`,
			wsUrl: wsUrl,
			token: token,
			appendToken: true,
			init: {
				mode: "cors",
				credentials: "include",
				cache: "no-cache",
			},
		});
	}

	async getFileContents(path: string): Promise<Contents.IModel> {
		return this.serviceManager!.contents.get(path).then((contents) => {
			if (
				contents.type === "notebook" &&
				contents.content &&
				contents.content.cells
			) {
				contents.content.cells = contents.content.cells.map(
					(cell: ICell) => {
						if (!cell.metadata) {
							cell.metadata = {};
						}
						return normalizeCell(cell);
					},
				);
			}

			return contents;
		});
	}

	async renameFile(
		oldPath: string,
		newName: string,
	): Promise<{
		success: boolean;
		error: string | null;
	}> {
		const filePath = oldPath.split("/").slice(0, -1).join("/");
		try {
			await this.serviceManager?.contents.rename(
				oldPath,
				filePath + "/" + newName,
			);
			return {
				success: true,
				error: null,
			};
		} catch (error: any) {
			console.error("Error renaming file:", error);
			return {
				success: false,
				error: error,
			};
		}
	}

	kernelReady() {
		return this.ready
			.then(() => {
				return this.serviceManager?.kernels?.ready ?? Promise.reject();
			})
			.then(() => {
				return this.kernel?.ready ?? Promise.reject();
			});
	}
}

export default ConnectionManager;
