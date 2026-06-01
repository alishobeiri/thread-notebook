import { NotebookFile } from "../../types/file.types";
import { newUuid } from "../utils";

// TODO add real PostHog Project
export const PH_PROJECT_API_KEY =
	"phc_Pqhxx9TL3YeiBss7OfaIMdj1K8X7kjzeUUg7XsM3zpP";
export const API_URL =
	process.env.NODE_ENV == "production"
		? "https://thread-41s7.onrender.com"
		: "http://localhost:5001";

export const CELL_ACTIVE_COLOR = "var(--chakra-colors-orange-500)";

export const SIDEPANEL_WIDTH = 350;
export const SCROLL_TO_BOTTOM_THRESHOLD = 100;

export const FILESYSTEM_PANEL_ID = "filesystem";

export const TERMINAL_PANEL_ID = "terminal";

export const SETTINGS_PANEL_ID = "settings";

export const CONTEXT_WINDOW_SIZE = 3;

export const OUTPUT_AREA_CSS = {
	"&::-webkit-scrollbar": {
		width: "4px",
		height: "4px",
	},
	"&::-webkit-scrollbar-track": {
		background: "var(--chakra-colors-gray-50)",
		width: "6px",
	},
	"&::-webkit-scrollbar-thumb": {
		background: "var(--chakra-colors-green-300)",
		borderRadius: "24px",
	},
};

/* 80px + 3px for active indicator on gutter */
export const CELL_GUTTER_WIDTH = 83;

export const CELL_MINIMUM_HEIGHT = 32;

export const OUTPUT_AREA_MAX_HEIGHT = 650;

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_OUTPUT_LENGTH = 2000;

export const SCROLL_CSS = {
	"&::-webkit-scrollbar": {
		width: "4px",
		height: "4px",
	},
	"&::-webkit-scrollbar-track": {
		background: "var(--chakra-colors-gray-50)",
		width: "6px",
	},
	"&::-webkit-scrollbar-thumb": {
		background: "var(--chakra-colors-orange-300)",
		borderRadius: "24px",
	},
};

export const CHUNK_SIZE = 1 * 1024 * 1024;

export const NEW_NOTEBOOK: () => NotebookFile = () => {
	const id = newUuid();
	return {
		cells: [],
		metadata: {
			threadNotebook: {
				id: id,
				preferredLanguage: "",
			},
		},
		nbformat: 4,
		nbformat_minor: 5,
	};
};

export const START_HIDE_CURSOR = "[?25l";
export const STOP_HIDE_CURSOR = "[?25h";

export const MESSAGES_LOOKBACK_WINDOW = 10;
export const MAX_SPREADSHEET_SIZE_TO_PREVIEW = 5 * 1024 * 1024;
