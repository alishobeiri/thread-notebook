import { acceptCompletion } from "@codemirror/autocomplete";
import {
	defaultKeymap,
	indentLess,
	indentMore,
	insertTab,
} from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@uiw/react-codemirror";
import {
	enableCommandMode,
	runCell,
	runCellAndAdvance,
} from "../actions/actions";

export function indentMoreOrInsertTab(target: {
	dom: HTMLElement;
	state: EditorState;
	dispatch: (transaction: Transaction) => void;
}): boolean {
	const completionWasAccepted = acceptCompletion(target as EditorView);
	const arg = { state: target.state, dispatch: target.dispatch };
	const from = target.state.selection.main.from;
	const to = target.state.selection.main.to;
	if (from != to) {
		return indentMore(arg);
	}
	const line = target.state.doc.lineAt(from);
	const before = target.state.doc.slice(line.from, from).toString();
	if (/^\s*$/.test(before)) {
		return indentMore(arg);
	} else {
		// If a completion was accepted, don't insert a tab.
		if (completionWasAccepted) {
			return true;
		} else {
			return insertTab(arg);
		}
	}
}

// TODO: strip existent keys from defaultKeymap before adding new ones
export const jupyterLabKeymap = [
	...defaultKeymap.filter(
		({ key }) =>
			key !== undefined &&
			![
				"Ctrl-Enter",
				"Mod-Enter",
				"Escape",
				"Enter",
				"Tab",
				"Mod-shift-k",
			].includes(key),
	),
	{
		key: "Shift-Enter",
		run: runCellAndAdvance,
		stopPropagation: true,
		preventDefault: true,
	},
	{
		key: "Ctrl-Enter",
		run: runCell,
		stopPropagation: true,
		preventDefault: true,
	},
	{
		key: "Mod-Enter",
		run: runCell,
		stopPropagation: true,
		preventDefault: true,
	},
	{
		key: "Escape",
		run: (view: EditorView) => {
			view.contentDOM.blur();
			enableCommandMode();
			return true;
		},
		stopPropagation: true,
	},
	{ key: "Enter", stopPropagation: true, preventDefault: true },
	{ key: "Tab", run: indentMoreOrInsertTab, shift: indentLess },
];
