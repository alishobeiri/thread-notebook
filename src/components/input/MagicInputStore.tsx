import { RefObject } from "react";
import { create } from "zustand";
import { useNotebookStore } from "../notebook/store/NotebookStore";

// A cell the user has @-mentioned to attach as explicit context for the next
// request.
export interface CellMention {
	id: string;
	label: string;
}

interface MagicInputStore {
	value: string;
	// Code the user has highlighted in a cell — folded into the agent's context
	// as the focus of the request (shown as a chip above the input).
	selectedCode: string;
	// Cells explicitly attached via @-mention; included in the request context.
	mentions: CellMention[];
	textareaRef: RefObject<HTMLTextAreaElement> | null;
	setValue: (value: string) => void;
	setSelectedCode: (code: string) => void;
	addMention: (mention: CellMention) => void;
	removeMention: (id: string) => void;
	clearMentions: () => void;
	handleQuery: (userQuery: string) => void;
	setTextareaRef: (textareaRef: RefObject<HTMLTextAreaElement>) => void;
	focusMagicInput: () => void;
}

export const useMagicInputStore = create<MagicInputStore>((set, get) => ({
	value: "",
	selectedCode: "",
	mentions: [],
	textareaRef: null,
	setValue: (value: string) => {
		set({ value });
	},
	setSelectedCode: (code: string) => {
		set({ selectedCode: code });
	},
	addMention: (mention: CellMention) => {
		set((state) =>
			state.mentions.some((m) => m.id === mention.id)
				? state
				: { mentions: [...state.mentions, mention] },
		);
	},
	removeMention: (id: string) => {
		set((state) => ({
			mentions: state.mentions.filter((m) => m.id !== id),
		}));
	},
	clearMentions: () => set({ mentions: [] }),
	handleQuery: async (userQuery: string) => {
		const { setValue, clearMentions } = get();
		const trimmedUserQuery = userQuery.trim();
		if (trimmedUserQuery.length === 0) return;
		setValue("");
		const { magicQuery } = useNotebookStore.getState();
		// magicQuery reads the mentions while building context; clear them after.
		await magicQuery(trimmedUserQuery);
		clearMentions();
	},
	setTextareaRef: (textareaRef: RefObject<HTMLTextAreaElement>) => {
		set({ textareaRef });
	},
	focusMagicInput: () => {
		const { textareaRef } = get();
		if (textareaRef && textareaRef.current) {
			textareaRef.current.focus();
		}
	},
}));
