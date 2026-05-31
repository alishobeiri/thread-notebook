import {
	autocompletion,
	completionKeymap,
	completionStatus,
} from "@codemirror/autocomplete";
import { setDiagnostics } from "@codemirror/lint";
import { Facet } from "@codemirror/state";
import {
	EditorView,
	Tooltip,
	ViewPlugin,
	hoverTooltip,
} from "@codemirror/view";
import {
	Client,
	RequestManager,
	WebSocketTransport,
} from "@open-rpc/client-js";
import {
	CompletionItemKind,
	CompletionTriggerKind,
	DiagnosticSeverity,
} from "vscode-languageserver-protocol";

import type {
	Completion,
	CompletionContext,
	CompletionResult,
} from "@codemirror/autocomplete";
import type { Text } from "@codemirror/state";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import { Transport } from "@open-rpc/client-js/build/transports/Transport";
import { captureException } from "@sentry/nextjs";
import { Prec, keymap } from "@uiw/react-codemirror";
import type * as LSP from "vscode-languageserver-protocol";
import type { PublishDiagnosticsParams } from "vscode-languageserver-protocol";
import { isValidUUID, multilineStringToString } from "../../../../utils/utils";
import { useNotebookStore } from "../../../notebook/store/NotebookStore";

const timeout = 10000;
const changesDelay = 500;

const CompletionItemKindMap = Object.fromEntries(
	Object.entries(CompletionItemKind).map(([key, value]) => [value, key]),
) as Record<CompletionItemKind, string>;

const useLast = (values: readonly any[]) => values.reduce((_, v) => v, "");

const client = Facet.define<LanguageServerClient, LanguageServerClient>({
	combine: useLast,
});
export const documentUri = Facet.define<string, string>({ combine: useLast });
const languageId = Facet.define<string, string>({ combine: useLast });

// https://microsoft.github.io/language-server-protocol/specifications/specification-current/

// Client to server then server to client
interface LSPRequestMap {
	initialize: [LSP.InitializeParams, LSP.InitializeResult];
	"workspace/didChangeConfiguration": [LSP.DidChangeConfigurationParams];
	"textDocument/hover": [LSP.HoverParams, LSP.Hover];
	"textDocument/completion": [
		LSP.CompletionParams,
		LSP.CompletionItem[] | LSP.CompletionList | null,
	];
}

// Client to server
interface LSPNotifyMap {
	initialized: LSP.InitializedParams;
	"notebookDocument/didChange": LSP.DidChangeNotebookDocumentParams;
	"notebookDocument/didOpen": LSP.DidOpenNotebookDocumentParams;
}

// Server to client
interface LSPEventMap {
	"textDocument/publishDiagnostics": LSP.PublishDiagnosticsParams;
}

type Notification = {
	[key in keyof LSPEventMap]: {
		jsonrpc: "2.0";
		id?: null | undefined;
		method: key;
		params: LSPEventMap[key];
	};
}[keyof LSPEventMap];

export class LanguageServerClient {
	private rootUri: string | null;
	private workspaceFolders: LSP.WorkspaceFolder[] | null;
	private autoClose?: boolean;

	private transport: Transport;
	private requestManager: RequestManager;
	private client: Client;

	public ready!: boolean;
	public capabilities!: LSP.ServerCapabilities<any>;

	private plugins: LanguageServerPlugin[];

	public initializePromise: Promise<void>;

	constructor(options: LanguageServerClientOptions) {
		this.rootUri = options.rootUri;
		this.workspaceFolders = options.workspaceFolders;
		this.autoClose = options.autoClose;
		this.plugins = [];
		this.transport = options.transport;

		this.requestManager = new RequestManager([this.transport]);
		this.client = new Client(this.requestManager);

		this.client.onNotification((data) => {
			this.processNotification(data as any);
		});

		this.client.onError((error) => {
			console.error(error);
			captureException(error);
		});

		const webSocketTransport = <WebSocketTransport>this.transport;
		if (webSocketTransport && webSocketTransport.connection) {
			// XXX(hjr265): Need a better way to do this. Relevant issue:
			// https://github.com/FurqanSoftware/codemirror-languageserver/issues/9
			webSocketTransport.connection.addEventListener(
				"message",
				(message) => {
					let dataString: string;

					// Check the type of message.data and convert it to a string if necessary
					if (typeof message.data === "string") {
						dataString = message.data;
					} else if (message.data instanceof ArrayBuffer) {
						dataString = new TextDecoder().decode(message.data);
					} else if (message.data instanceof Blob) {
						const reader = new FileReader();
						reader.onload = () => {
							dataString = reader.result as string;
							processMessage(dataString);
						};
						reader.readAsText(message.data);
						return; // Exit early, as the processing will happen in the onload callback
					} else {
						// Handle other types or throw an error
						throw new Error("Unsupported message data type");
					}

					processMessage(dataString);

					function processMessage(dataString: string) {
						const data = JSON.parse(dataString);
						if (data.method && data.id) {
							webSocketTransport.connection.send(
								JSON.stringify({
									jsonrpc: "2.0",
									id: data.id,
									result: null,
								}),
							);
						}
					}
				},
			);
		}

		this.initializePromise = this.initialize();
	}

	async initialize() {
		const result = await this.request(
			"initialize",
			{
				capabilities: {
					textDocument: {
						hover: {
							dynamicRegistration: true,
							contentFormat: ["plaintext", "markdown"],
						},
						moniker: {},
						synchronization: {
							dynamicRegistration: true,
							willSave: false,
							didSave: false,
							willSaveWaitUntil: false,
						},
						completion: {
							dynamicRegistration: true,
							completionItem: {
								snippetSupport: false,
								commitCharactersSupport: true,
								documentationFormat: ["plaintext", "markdown"],
								deprecatedSupport: false,
								preselectSupport: false,
							},
							contextSupport: false,
						},
						signatureHelp: {
							dynamicRegistration: true,
							signatureInformation: {
								documentationFormat: ["plaintext", "markdown"],
							},
						},
						declaration: {
							dynamicRegistration: true,
							linkSupport: true,
						},
						definition: {
							dynamicRegistration: true,
							linkSupport: true,
						},
						typeDefinition: {
							dynamicRegistration: true,
							linkSupport: true,
						},
						implementation: {
							dynamicRegistration: true,
							linkSupport: true,
						},
					},
					workspace: {
						didChangeConfiguration: {
							dynamicRegistration: true,
						},
					},
				},
				initializationOptions: null,
				processId: null,
				rootUri: this.rootUri,
				workspaceFolders: this.workspaceFolders,
			},
			5,
		);

		await this.request(
			"workspace/didChangeConfiguration",
			{
				settings: {
					pylsp: {
						plugins: {
							pylint: {
								enabled: false,
							},
							pycodestyle: {
								enabled: false,
							},
							jedi_completion: {
								eager: true,
								include_params: false,
							},
						},
					},
				},
			},
			5,
		);
		if (result) {
			this.capabilities = result.capabilities;
		}

		this.notify("initialized", {});
		this.ready = true;
	}

	close() {
		this.client.close();
	}

	notebookDocumentDidOpen(params: LSP.DidOpenNotebookDocumentParams) {
		return this.notify("notebookDocument/didOpen", params);
	}

	notebookDocumentDidChange(params: LSP.DidChangeNotebookDocumentParams) {
		return this.notify("notebookDocument/didChange", params);
	}

	async notebookDocumentHover(params: LSP.HoverParams) {
		return await this.request("textDocument/hover", params, timeout);
	}

	async notebookDocumentCompletion(params: LSP.CompletionParams) {
		return await this.request("textDocument/completion", params, timeout);
	}

	attachPlugin(plugin: LanguageServerPlugin) {
		this.plugins.push(plugin);
	}

	detachPlugin(plugin: LanguageServerPlugin) {
		const i = this.plugins.indexOf(plugin);
		if (i === -1) return;
		this.plugins.splice(i, 1);
		if (this.autoClose) this.close();
	}

	private request<K extends keyof LSPRequestMap>(
		method: K,
		params: LSPRequestMap[K][0],
		timeout: number,
	): Promise<LSPRequestMap[K][1] | undefined> {
		return this.client
			.request({ method, params }, timeout)
			.catch((error) => {
				captureException(error);
				console.error(error);
				return Promise.resolve(undefined);
			});
	}

	private notify<K extends keyof LSPNotifyMap>(
		method: K,
		params: LSPNotifyMap[K],
	): Promise<LSPNotifyMap[K] | undefined> {
		return this.client.notify({ method, params }).catch((error) => {
			captureException(error);
			console.error(error);
			return Promise.resolve(undefined);
		});
	}

	private processNotification(notification: Notification) {
		for (const plugin of this.plugins) {
			plugin.processNotification(notification);
		}
	}
}

class LanguageServerPlugin implements PluginValue {
	public client: LanguageServerClient;
	private languageId: string;

	private changesTimeout: number;

	constructor(private view: EditorView, private allowHTMLContent: boolean) {
		this.client = this.view.state.facet(client);
		this.languageId = this.view.state.facet(languageId);
		this.changesTimeout = 0;

		this.client.attachPlugin(this);

		this.initialize();
	}

	get documentUri() {
		return useNotebookStore.getState().getActiveCell().id as string;
	}

	getNotebookDocument(): LSP.NotebookDocument {
		const cells: LSP.NotebookCell[] = useNotebookStore
			.getState()
			.cells.map((cell) => {
				return {
					kind: cell.cell_type == "code" ? 2 : 1,
					document: cell.id as string,
				};
			});
		return {
			uri: "123",
			notebookType: "python",
			version: 7,
			cells: cells,
		};
	}

	getCellTextDocuments(): LSP.TextDocumentItem[] {
		return useNotebookStore.getState().cells.map((cell) => {
			return {
				uri: cell.id as string,
				languageId: this.languageId,
				version: 0,
				text: multilineStringToString(cell.source),
			};
		}) as LSP.TextDocumentItem[];
	}

	update({ docChanged }: ViewUpdate) {
		if (!docChanged) return;
		if (this.changesTimeout) clearTimeout(this.changesTimeout);
		this.changesTimeout = self.setTimeout(() => {
			this.sendChange({
				documentText: this.view.state.doc.toString(),
			});
		}, changesDelay);
	}

	destroy() {
		this.client.detachPlugin(this);
	}

	async initialize() {
		if (this.client.initializePromise) {
			await this.client.initializePromise;
		}

		this.client.notebookDocumentDidOpen({
			notebookDocument: this.getNotebookDocument(),
			cellTextDocuments: this.getCellTextDocuments(),
		});
	}

	async sendChange({ documentText }: { documentText: string }) {
		if (!this.client) return;
		try {
			const result = await this.client.notebookDocumentDidChange({
				notebookDocument: this.getNotebookDocument(),
				change: {
					cells: {
						textContent: [
							{
								document: {
									uri: this.documentUri,
									version: 0,
								},
								changes: [
									{
										text: documentText,
									},
								],
							},
						],
					},
				},
			});
			console.log("sendChange result: ", result);
		} catch (e) {
			console.error(e);
		}
	}

	requestDiagnostics(view: EditorView) {
		this.sendChange({ documentText: view.state.doc.toString() });
	}

	async requestHoverTooltip(
		view: EditorView,
		{ line, character }: { line: number; character: number },
	): Promise<Tooltip | null> {
		console.log("requestHover: ");
		if (!this.client || !this.client.capabilities!.hoverProvider)
			return null;
		console.log("requestHover - client is valid");
		this.sendChange({ documentText: view.state.doc.toString() });

		const result = await this.client.notebookDocumentHover({
			textDocument: { uri: this.documentUri },
			position: { line, character },
		});

		console.log("requestHover - result: ", result);
		if (!result) return null;

		const { contents, range } = result;
		let pos = posToOffset(view.state.doc, { line, character })!;
		let end = pos; // Initialize end with the same position as pos

		if (range) {
			pos = posToOffset(view.state.doc, range.start)!;
			end = posToOffset(view.state.doc, range.end)!;
		}

		if (pos === null) return null;

		const dom = document.createElement("div");
		dom.classList.add("documentation");

		if (this.allowHTMLContent) {
			dom.innerHTML = formatContents(contents);
		} else {
			dom.textContent = formatContents(contents);
		}

		return { pos, end, create: (view) => ({ dom }), above: true };
	}

	async requestCompletion(
		context: CompletionContext,
		{ line, character }: { line: number; character: number },
		{
			triggerKind,
			triggerCharacter,
		}: {
			triggerKind: CompletionTriggerKind;
			triggerCharacter: string | undefined;
		},
	): Promise<CompletionResult | null> {
		console.log("request completion");
		if (!this.client || !this.client.capabilities!.completionProvider)
			return null;
		console.log("request completion - client is valid");
		this.sendChange({
			documentText: context.state.doc.toString(),
		});

		const result = await this.client.notebookDocumentCompletion({
			textDocument: { uri: this.documentUri },
			position: { line, character },
			context: {
				triggerKind,
				triggerCharacter,
			},
		});

		console.log("requestCompletion - result: ", result);
		if (!result) return null;

		const items = "items" in result ? result.items : result;

		let options = items.map(
			({
				detail,
				label,
				kind,
				textEdit,
				documentation,
				sortText,
				filterText,
			}) => {
				const completion: Completion & {
					filterText: string;
					sortText?: string;
					apply: string;
				} = {
					label,
					apply: textEdit?.newText ?? label,
					type: kind && CompletionItemKindMap[kind].toLowerCase(),
					sortText: sortText ?? label,
					filterText: filterText ?? label,
				};
				if (documentation) {
					completion.info = formatContents(documentation);
				}

				if (detail && !isValidUUID(detail)) {
					completion.detail = detail;
				}

				return completion;
			},
		);

		const [span, match] = prefixMatch(options);
		const token = context.matchBefore(match);
		let { pos } = context;

		if (token) {
			pos = token.from;
			const word = token.text.toLowerCase();
			if (/^\w+$/.test(word)) {
				options = options
					.filter(({ filterText }) =>
						filterText.toLowerCase().startsWith(word),
					)
					.sort(({ apply: a }, { apply: b }) => {
						switch (true) {
							case a.startsWith(token.text) &&
								!b.startsWith(token.text):
								return -1;
							case !a.startsWith(token.text) &&
								b.startsWith(token.text):
								return 1;
						}
						return 0;
					});
			}
		}
		return {
			from: pos,
			options,
		};
	}

	processNotification(notification: Notification) {
		try {
			switch (notification.method) {
				case "textDocument/publishDiagnostics":
					this.processDiagnostics(notification.params);
			}
		} catch (error) {
			console.error(error);
		}
	}

	processDiagnostics(params: PublishDiagnosticsParams) {
		if (params.uri !== this.documentUri) return;

		const diagnostics = params.diagnostics
			.map(({ range, message, severity }) => ({
				from: posToOffset(this.view.state.doc, range.start)!,
				to: posToOffset(this.view.state.doc, range.end)!,
				severity: (
					{
						[DiagnosticSeverity.Error]: "error",
						[DiagnosticSeverity.Warning]: "warning",
						[DiagnosticSeverity.Information]: "info",
						[DiagnosticSeverity.Hint]: "info",
					} as const
				)[severity!],
				message,
			}))
			.filter(
				({ from, to }) =>
					from !== null &&
					to !== null &&
					from !== undefined &&
					to !== undefined,
			)
			.sort((a, b) => {
				switch (true) {
					case a.from < b.from:
						return -1;
					case a.from > b.from:
						return 1;
				}
				return 0;
			});

		this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
	}
}

interface LanguageServerBaseOptions {
	rootUri: string | null;
	workspaceFolders: LSP.WorkspaceFolder[] | null;
	documentUri: string;
	languageId: string;
}

interface LanguageServerClientOptions extends LanguageServerBaseOptions {
	transport: Transport;
	autoClose?: boolean;
}

interface LanguageServerOptions extends LanguageServerClientOptions {
	client?: LanguageServerClient;
	allowHTMLContent?: boolean;
}

interface LanguageServerWebsocketOptions extends LanguageServerBaseOptions {
	serverUri: `ws://${string}` | `wss://${string}`;
}

export function languageServer(options: LanguageServerWebsocketOptions) {
	const serverUri = options.serverUri;
	return languageServerWithTransport({
		...options,
		transport: new WebSocketTransport(serverUri),
	});
}

export function languageServerWithTransport(options: LanguageServerOptions) {
	let plugin: LanguageServerPlugin | null = null;
	const escapeKeymap = completionKeymap.filter(
		({ key }) => key == "Escape",
	)[0];
	return [
		client.of(
			options.client ||
				new LanguageServerClient({ ...options, autoClose: true }),
		),
		documentUri.of(options.documentUri),
		languageId.of(options.languageId),
		ViewPlugin.define(
			(view) =>
				(plugin = new LanguageServerPlugin(
					view,
					options.allowHTMLContent!,
				)),
		),
		hoverTooltip(
			(view, pos) =>
				plugin?.requestHoverTooltip(
					view,
					offsetToPos(view.state.doc, pos),
				) ?? null,
		),
		autocompletion({
			override: [
				async (context) => {
					if (plugin == null) return null;

					const { state, pos, explicit } = context;
					const line = state.doc.lineAt(pos);
					let trigKind: CompletionTriggerKind =
						CompletionTriggerKind.Invoked;
					let trigChar: string | undefined;
					if (
						!explicit &&
						plugin.client.capabilities?.completionProvider?.triggerCharacters?.includes(
							line.text[pos - line.from - 1],
						)
					) {
						trigKind = CompletionTriggerKind.TriggerCharacter;
						trigChar = line.text[pos - line.from - 1];
					}
					if (
						trigKind === CompletionTriggerKind.Invoked &&
						!context.matchBefore(/\w+$/)
					) {
						return null;
					}
					return await plugin.requestCompletion(
						context,
						offsetToPos(state.doc, pos),
						{
							triggerKind: trigKind,
							triggerCharacter: trigChar,
						},
					);
				},
			],
			defaultKeymap: false,
		}),
		Prec.highest(
			keymap.of([
				...completionKeymap.filter(({ key }) => key !== "Escape"),
				{
					key: escapeKeymap.key,
					run: (editor) => {
						const completionsAvailable =
							completionStatus(editor.state) == "active";
						if (escapeKeymap.run) {
							escapeKeymap.run(editor);
						}
						if (completionsAvailable) {
							return true;
						}
						return false;
					},
				},
			]),
		),
	];
}

function posToOffset(doc: Text, pos: { line: number; character: number }) {
	if (pos.line >= doc.lines) return;
	const offset = doc.line(pos.line + 1).from + pos.character;
	if (offset > doc.length) return;
	return offset;
}

function offsetToPos(doc: Text, offset: number) {
	const line = doc.lineAt(offset);
	return {
		line: line.number - 1,
		character: offset - line.from,
	};
}

function formatContents(
	contents:
		| LSP.MarkupContent
		| LSP.MarkedString
		| LSP.MarkedString[]
		| string,
): string {
	if (typeof contents === "string") {
		return contents;
	} else if (Array.isArray(contents)) {
		return contents
			.map((item) => (typeof item === "string" ? item : item.value))
			.join("\n");
	} else if ("kind" in contents) {
		return contents.value;
	} else {
		return contents.value;
	}
}

function toSet(chars: Set<string>) {
	let preamble = "";
	let flat = Array.from(chars).join("");
	const words = /\w/.test(flat);
	if (words) {
		preamble += "\\w";
		flat = flat.replace(/\w/g, "");
	}
	return `[${preamble}${flat.replace(/[^\w\s]/g, "\\$&")}]`;
}

function prefixMatch(options: Completion[]) {
	const first = new Set<string>();
	const rest = new Set<string>();

	for (const { apply } of options) {
		const initial = (apply as string).charAt(0);
		const restStr = (apply as string).slice(1);
		first.add(initial);
		for (const char of restStr) {
			rest.add(char);
		}
	}

	const source = toSet(first) + toSet(rest) + "*$";
	return [new RegExp("^" + source), new RegExp(source)];
}
