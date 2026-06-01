import { EditorState, StateField } from "@codemirror/state";
import { EditorView, Tooltip, showTooltip } from "@codemirror/view";
import { Extension, Line } from "@uiw/react-codemirror";
import { isPlatformMac } from "../../../../utils/utils";
import { useMagicInputStore } from "../../../input/MagicInputStore";
import { getSelectedCode } from "./shared";

const cursorTooltipField = StateField.define<readonly Tooltip[]>({
	create: getCursorTooltips,

	update(tooltips, tr) {
		if (tr.selection) {
			tooltips = getCursorTooltips(tr.state);
		}

		return tooltips;
	},

	provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
});

function createActionButton(
	text: string,
	className: string,
	onclick: () => void,
	hotkeys?: { keys: string[] },
): HTMLButtonElement {
	let button = document.createElement("button");
	button.textContent = text;
	button.className = className;
	button.onclick = onclick;

	if (hotkeys) {
		const hotkeySpan = document.createElement("span");
		hotkeySpan.className = "cm-action-hotkey-container";

		// Concatenate all keys into a single string
		const hotkeyString = hotkeys.keys.join(" + ");
		const keySpan = document.createElement("span");
		keySpan.className = "cm-action-key";
		keySpan.textContent = hotkeyString;
		hotkeySpan.appendChild(keySpan);

		button.appendChild(document.createTextNode(" "));
		button.appendChild(hotkeySpan);
	}

	return button;
}

function getCursorTooltips(state: EditorState): readonly Tooltip[] {
	// TODO: Could be reactive to user selection after highlighting text, but not needed now.
	//  currently, will assess this only after user selection
	const nonEmptySelections = state.selection.ranges.filter(
		(range) => !range.empty,
	);
	if (nonEmptySelections.length == 0) {
		useMagicInputStore.getState().setSelectedCode("");
	}

	return nonEmptySelections.map((range) => {
		let longestLineLength = 0;
		let startLine = state.doc.lineAt(range.from).number;
		let endLine = state.doc.lineAt(range.to).number;
		let lastNonEmptyLine: Line | null = null;
		let selectionText = getSelectedCode(state);
		const rangeCurrentPosition = state.doc.lineAt(range.head).number;

		if (rangeCurrentPosition == endLine) {
			// Top to bottom selection
			for (let i = startLine; i <= endLine; i++) {
				let line = state.doc.line(i);
				if (line.text.length > 0) {
					lastNonEmptyLine = line;
				}
				longestLineLength = Math.max(
					longestLineLength,
					line.text.length,
				);
			}
		} else {
			// Bottom to top selection
			for (let i = endLine; i >= startLine; i--) {
				let line = state.doc.line(i);
				if (line.text.length > 0) {
					lastNonEmptyLine = line;
				}
				longestLineLength = Math.max(
					longestLineLength,
					line.text.length,
				);
			}
		}

		let line = state.doc.lineAt(range.head);
		let pos = line.to;
		if (line.text.length == 0 && lastNonEmptyLine) {
			pos = lastNonEmptyLine.to;
		}

		useMagicInputStore.getState().setSelectedCode(selectionText);

		return {
			pos: pos,
			above: true,
			strictSide: true,
			arrow: false,
			create: () => {
				let dom = document.createElement("div");
				dom.className = "cm-selection-actions";

				let editButton = createActionButton(
					"Add to prompt",
					"cm-action-button cm-edit-btn",
					() => {
						dom.style.display = "none";
						useMagicInputStore.getState().focusMagicInput();
					},
					{
						keys: [isPlatformMac() ? "⌘" : "Ctrl", "K"],
					},
				);
				dom.appendChild(editButton);

				return { dom };
			},
		};
	});
}

const cursorTooltipBaseTheme = EditorView.baseTheme({
	".cm-tooltip.cm-selection-actions": {
		fontFamily: "var(--chakra-fonts-body)",
		backgroundColor: "var(--chakra-colors-chakra-body-bg)",
		border: "none",
		boxShadow: "0px 0px 2px 2px var(--jp-layout-color3)",
		fontSize: "smaller",
		overflow: "hidden",
		borderRadius: "4px",
		"& .cm-tooltip-arrow:before": {
			borderTopColor: "#66b",
		},
		"& .cm-tooltip-arrow:after": {
			borderTopColor: "transparent",
		},
		display: "flex",
		flexDirection: "row",
	},
	".cm-action-button": {
		fontWeight: "600",
		padding: "5px 8px",
		cursor: "pointer",
		display: "flex",
		flexDirection: "row",
		alignItems: "center",
		gap: "5px",
	},
	".cm-action-button:hover": {
		filter: "brightness(50%)",
	},
	".cm-action-hotkey-container": {
		padding: "3px 2px",
		flexDirection: "row",
		marginTop: "-2px",
		opacity: 0.8,
	},
	".cm-action-key": {
		border: "1px solid #ccc",
		borderRadius: "3px",
		padding: "2px 5px",
		margin: "0 2px",
		// backgroundColor: "#f0f0f0",
		fontFamily: "monospace",
		userSelect: "none",
		cursor: "default",
		lineHeight: "0.9em",
		pointerEvents: "none",
	},
});

export const codeSelectionExtension = (state?: EditorState): Extension[] => {
	return [cursorTooltipField, cursorTooltipBaseTheme];
};
