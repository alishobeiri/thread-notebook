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
import type { EditorState, Text } from "@codemirror/state";
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
export const documentUri = Facet.define<string, string>({
	// InputArea supplies each editor's cell id at highest precedence, while the
	// shared language-server extension also contributes an empty default. With
	// useLast the empty default would win and every cell would resolve to "".
	// Pick the first non-empty value so each editor resolves to its own cell id.
	combine: (values) => values.find((v) => v) ?? "",
});
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
	"textDocument/didOpen": LSP.DidOpenTextDocumentParams;
	"textDocument/didChange": LSP.DidChangeTextDocumentParams;
}

// All code cells are concatenated into one virtual Python document under this
// URI, so the language server sees the whole notebook as a single module and
// can resolve names/imports defined in earlier cells.
const NOTEBOOK_DOC_URI = "file:///thread-notebook.py";

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
			timeout,
		);

		await this.request(
			"workspace/didChangeConfiguration",
			{
				settings: {
					// basedpyright reads python.analysis.*; "basic" type
					// checking surfaces undefined names and obvious errors
					// without the strict-mode noise that untyped data code
					// (pandas, numpy) would otherwise generate.
					python: {
						analysis: {
							typeCheckingMode: "basic",
							diagnosticMode: "openFilesOnly",
							autoImportCompletions: true,
							useLibraryCodeForTypes: true,
						},
					},
				},
			},
			timeout,
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

	private documentOpened = false;
	private documentVersion = 0;

	// Push the latest concatenated notebook text to the server. The first call
	// opens the document; subsequent calls send full-text changes. Shared
	// across every cell's plugin so the single virtual document stays in sync.
	syncDocument(text: string, languageId: string) {
		this.documentVersion += 1;
		if (!this.documentOpened) {
			this.documentOpened = true;
			return this.notify("textDocument/didOpen", {
				textDocument: {
					uri: NOTEBOOK_DOC_URI,
					languageId,
					version: this.documentVersion,
					text,
				},
			});
		}
		return this.notify("textDocument/didChange", {
			textDocument: { uri: NOTEBOOK_DOC_URI, version: this.documentVersion },
			contentChanges: [{ text }],
		});
	}

	async textDocumentHover(params: LSP.HoverParams) {
		return await this.request("textDocument/hover", params, timeout);
	}

	async textDocumentCompletion(params: LSP.CompletionParams) {
		return await this.request("textDocument/completion", params, timeout);
	}

	attachPlugin(plugin: LanguageServerPlugin) {
		this.plugins.push(plugin);
	}

	detachPlugin(plugin: LanguageServerPlugin) {
		const i = this.plugins.indexOf(plugin);
		if (i === -1) return;
		this.plugins.splice(i, 1);
		// The client (and its WebSocket) is shared by every cell editor, so it
		// must only close once the last one detaches — otherwise a single cell
		// re-render would tear down LSP for the whole notebook.
		if (this.autoClose && this.plugins.length === 0) this.close();
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

// Build the concatenated virtual document for a given "current" cell. That
// cell's text is supplied live from its editor (so it is up to date even
// mid-keystroke); every other code cell is read from the store. Returns the
// full document text and the current cell's global start line.
function buildVirtualDocument(
	cellId: string,
	liveText: string,
): { text: string; offset: number } {
	const cells = useNotebookStore.getState().cells;
	const parts: string[] = [];
	let line = 0;
	let offset = 0;
	for (const cell of cells) {
		if (cell.cell_type !== "code") continue;
		const isCurrent = cell.id === cellId;
		const text = isCurrent
			? liveText
			: multilineStringToString(cell.source);
		if (isCurrent) offset = line;
		parts.push(text);
		line += text.split("\n").length;
	}
	return { text: parts.join("\n"), offset };
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

	// Sync the virtual document for a given editor state and return that cell's
	// global line offset. Identity comes from the passed state (the documentUri
	// facet) rather than this.view, because completion/hover are routed through
	// a single module-level plugin instance — so the request must use whichever
	// editor actually triggered it, not the most recently created one.
	private syncForState(state: EditorState): number {
		const cellId = state.facet(documentUri);
		const { text, offset } = buildVirtualDocument(
			cellId,
			state.doc.toString(),
		);
		this.client.syncDocument(text, this.languageId);
		return offset;
	}

	update({ docChanged }: ViewUpdate) {
		if (!docChanged) return;
		if (this.changesTimeout) clearTimeout(this.changesTimeout);
		this.changesTimeout = self.setTimeout(() => {
			this.syncForState(this.view.state);
		}, changesDelay);
	}

	destroy() {
		this.client.detachPlugin(this);
	}

	async initialize() {
		if (this.client.initializePromise) {
			await this.client.initializePromise;
		}
		this.syncForState(this.view.state);
	}

	async requestHoverTooltip(
		view: EditorView,
		{ line, character }: { line: number; character: number },
	): Promise<Tooltip | null> {
		if (!this.client || !this.client.capabilities?.hoverProvider)
			return null;
		const offset = this.syncForState(view.state);

		const result = await this.client.textDocumentHover({
			textDocument: { uri: NOTEBOOK_DOC_URI },
			position: { line: line + offset, character },
		});

		if (!result) return null;

		const { contents, range } = result;
		let pos = posToOffset(view.state.doc, { line, character })!;
		let end = pos; // Initialize end with the same position as pos

		if (range) {
			// Translate the server's global range back into this cell.
			pos = posToOffset(view.state.doc, {
				line: range.start.line - offset,
				character: range.start.character,
			})!;
			end = posToOffset(view.state.doc, {
				line: range.end.line - offset,
				character: range.end.character,
			})!;
		}

		if (pos === null || pos === undefined) return null;

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
		if (!this.client || !this.client.capabilities?.completionProvider)
			return null;
		const offset = this.syncForState(context.state);

		const result = await this.client.textDocumentCompletion({
			textDocument: { uri: NOTEBOOK_DOC_URI },
			position: { line: line + offset, character },
			context: {
				triggerKind,
				triggerCharacter,
			},
		});

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
		// Diagnostics are published against the single virtual document; keep
		// only those that fall within this cell's slice and map them back to
		// local coordinates.
		if (params.uri !== NOTEBOOK_DOC_URI) return;

		const cellId = this.view.state.facet(documentUri);
		const offset = buildVirtualDocument(
			cellId,
			this.view.state.doc.toString(),
		).offset;
		const localLines = this.view.state.doc.lines;

		const diagnostics = params.diagnostics
			.filter(
				({ range }) =>
					range.start.line >= offset &&
					range.start.line < offset + localLines,
			)
			.map(({ range, message, severity }) => ({
				from: posToOffset(this.view.state.doc, {
					line: range.start.line - offset,
					character: range.start.character,
				})!,
				to: posToOffset(this.view.state.doc, {
					line: range.end.line - offset,
					character: range.end.character,
				})!,
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
