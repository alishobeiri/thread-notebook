import { create } from "zustand";
import { FILESYSTEM_PANEL_ID } from "../../../utils/constants/constants";

const SIDEBAR_WIDTH_KEY = "threadNotebookSidebarWidth";
const SIDEBAR_EXPANDED_KEY = "threadNotebookSidebarExpanded";
const DEFAULT_SIDEBAR_WIDTH = 350;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;

interface SidebarState {
	textInputRef: HTMLTextAreaElement | null;
	panelType: string;
	isExpanded: boolean;
	sidebarWidth: number;
	setTextInputRef: (textInputRef: HTMLTextAreaElement) => void;
	setPanelType: (panelType: string) => void;
	setIsExpanded: (isExpanded: boolean) => void;
	initializeSidebar: () => void;
	setSidebarWidth: (width: number) => void;
	toggleOpen: () => void;
	openFileSystem: () => void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
	textInputRef: null,
	panelType: FILESYSTEM_PANEL_ID,
	isExpanded: false,
	sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
	setTextInputRef: (textInputRef: HTMLTextAreaElement) =>
		set(() => ({ textInputRef })),
	setPanelType: (panelType) => set(() => ({ panelType })),
	setIsExpanded: (isExpanded: boolean) => {
		if (typeof window !== "undefined") {
			localStorage.setItem(
				SIDEBAR_EXPANDED_KEY,
				JSON.stringify(isExpanded),
			);
		}
		set(() => ({ isExpanded }));
	},
	setSidebarWidth: (width: number) => {
		const newWidth = Math.max(
			MIN_SIDEBAR_WIDTH,
			Math.min(width, MAX_SIDEBAR_WIDTH),
		);
		if (typeof window !== "undefined") {
			localStorage.setItem(SIDEBAR_WIDTH_KEY, newWidth.toString());
		}
		set(() => ({ sidebarWidth: newWidth }));
	},
	initializeSidebar: () => {
		if (typeof window !== "undefined") {
			const storedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
			const storedExpanded = localStorage.getItem(SIDEBAR_EXPANDED_KEY);

			if (storedWidth) {
				set(() => ({
					sidebarWidth:
						parseInt(storedWidth, 10) || DEFAULT_SIDEBAR_WIDTH,
				}));
			}
			if (storedExpanded) {
				set(() => ({
					isExpanded: JSON.parse(storedExpanded) || false,
				}));
			}
		}
	},
	initializeSidebarWidth: () => {
		if (typeof window !== "undefined") {
			const storedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
			if (storedWidth) {
				set(() => ({
					sidebarWidth:
						parseInt(storedWidth, 10) || DEFAULT_SIDEBAR_WIDTH,
				}));
			}
		}
	},
	toggleOpen: () => {
		set((state) => {
			if (state.panelType === "" && state.isExpanded === false) {
				return { panelType: FILESYSTEM_PANEL_ID, isExpanded: true };
			}
			return { isExpanded: !state.isExpanded };
		});
	},
	openFileSystem: () => {
		set(() => ({
			isExpanded: true,
			panelType: FILESYSTEM_PANEL_ID,
		}));
	},
}));
