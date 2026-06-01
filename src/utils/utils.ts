import { captureException } from "@sentry/nextjs";
import { v4 as uuidv4 } from "uuid";
import { useInvalidConnectionModalStore } from "../components/modals/invalid-connection/InvalidConnectionStore";
import { ThreadNotebookCell } from "../types/code.types";
import { ThreadNotebookFile } from "../types/file.types";
import { trackEventData } from "./posthog";

export function getTimePartition(date: string): string {
	const updatedDate = new Date(date);
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	const isToday = updatedDate.toDateString() === today.toDateString();
	const isYesterday = updatedDate.toDateString() === yesterday.toDateString();
	const isLast7Days =
		(today.getTime() - updatedDate.getTime()) / (1000 * 3600 * 24) < 7;

	if (isToday) return "Today";
	if (isYesterday) return "Yesterday";
	if (isLast7Days) return "Last 7 Days";
	return "Older";
}

export const partitionChatItems = (
	items: ThreadNotebookFile[],
): Record<string, ThreadNotebookFile[]> => {
	return items.reduce(
		(acc: Record<string, ThreadNotebookFile[]>, item: ThreadNotebookFile) => {
			const partition = getTimePartition(item.last_modified.toString());
			if (!acc[partition]) {
				acc[partition] = [];
			}
			acc[partition].push(item);
			return acc;
		},
		{},
	);
};

export function getAppTheme(): "dark" | "light" {
	return (localStorage.getItem("chakra-ui-color-mode") ?? "dark") as
		| "dark"
		| "light";
}

export function canBeInteger(str: string) {
	const num = parseInt(str);
	return !isNaN(num) && num.toString() === str;
}

export function isInViewport(element: any) {
	if (!element) return false;

	const rect = element.getBoundingClientRect();

	return (
		rect.top >= 0 &&
		rect.left >= 0 &&
		rect.bottom <=
			(window.innerHeight || document.documentElement.clientHeight) &&
		rect.right <=
			(window.innerWidth || document.documentElement.clientWidth)
	);
}

// True if any part of the element is vertically within the viewport. Used to
// decide whether the active cell needs scrolling: a partially-visible cell (the
// usual case when clicking a cell you scrolled half past) should be left alone
// to avoid a jarring jump; only fully off-screen cells get scrolled into view.
export function isPartiallyInViewport(element: any) {
	if (!element) return false;
	const rect = element.getBoundingClientRect();
	const viewportHeight =
		window.innerHeight || document.documentElement.clientHeight;
	return rect.bottom > 0 && rect.top < viewportHeight;
}

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export const newUuid = () => {
	return uuidv4();
};

export const getCookie = (name: string): string | null => {
	const nameLenPlus = name.length + 1;
	return (
		document.cookie
			.split(";")
			.map((c) => c.trim())
			.filter((cookie) => {
				return cookie.substring(0, nameLenPlus) === `${name}=`;
			})
			.map((cookie) => {
				return decodeURIComponent(cookie.substring(nameLenPlus));
			})[0] || null
	);
};

export const isPlatformMac = (): boolean => {
	if (typeof window !== "undefined" && window.navigator) {
		return window.navigator.platform.toUpperCase().indexOf("MAC") >= 0;
	}
	return false;
};

export const capitalizeFirstLetter = (str: string) => {
	return str.charAt(0).toUpperCase() + str.slice(1);
};

export const getFileName = (file?: ThreadNotebookFile) => {
	if (!file) return "";
	const isFile = "updated_at" in file || "type" in file;
	if (isFile) {
		return (file as File).name.trim();
	} else {
		return "123";
	}
};

export const getFileId = (file?: ThreadNotebookFile) => {
	if (!file) return "";
	return file.name;
};

export const getDateFromFile = (file?: ThreadNotebookFile) => {
	if (!file) return "";
	return file.last_modified;
};

export const multilineStringToString = (str: string | string[]) => {
	return Array.isArray(str) ? str.join("") : str;
};

export function convertPythonListStringToArray(inputString: string) {
	inputString = inputString.trim();
	if (!inputString.startsWith("[") || !inputString.endsWith("]")) {
		throw new Error(
			"Invalid input format. Input must be a Python list representation.",
		);
	}
	let trimmedString = inputString.substring(1, inputString.length - 2);

	return trimmedString
		.split("', '")
		.map((element) => element.replace(/(^')|('$)/g, ""));
}

export async function threadNotebookFetch(url: string, body: any, signal?: AbortSignal) {
	trackEventData("threadNotebookFetch", { url });
	const response: any = await fetch(url, { ...body, signal }).then((res) => {
		if (res.status == 401) {
			useInvalidConnectionModalStore
				.getState()
				.setShowInvalidConnectionModal(true);
		}
		return res;
	});

	return response;
}

export const isUrlSafe = (title: string) => {
	return /^[a-zA-Z0-9-_ .]+$/.test(title);
};

export const makeUrlSafe = (title: string) => {
	return title.replace(/[^a-zA-Z0-9-_ .]+/g, "-");
};

export const getThreadNotebookCellMetadata = (
	cell: ThreadNotebookCell,
): Record<string, any> => {
	if (!cell.metadata) {
		cell.metadata = {};
	}

	if (!cell.metadata.threadNotebook) {
		cell.metadata.threadNotebook = {};
	}

	return cell.metadata.threadNotebook as Record<string, any>;
};

export const removeAnsiEscapeSequences = (text: string) => {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
};

export const extractErrorLineWithRegex = (errorText: string) => {
	// Modify the regex to find the '---->' arrow
	let regex = /(-+>)/g;
	let matches = errorText.match(regex);

	if (matches) {
		// Find the latest longest arrow match
		let longestArrowIndex = -1;
		let longestArrow = matches.reduce((a, b, index) => {
			if (b.length > a.length) {
				longestArrowIndex = index;
				return b;
			}
			return a;
		}, "");
		let longestArrowRegex = new RegExp(`(${longestArrow}\\s*(.+))`, "g");
		let allMatches = [...Array.from(errorText.matchAll(longestArrowRegex))];
		const lastMatch = allMatches.pop();
		if (lastMatch) {
			return lastMatch[2];
		}
		captureException(new Error("Could not find error line: " + errorText));
		return null;
	} else {
		// Extract line number and code line as before if no arrow is found
		let lineNumberRegex = /line\s+(\d+)/;
		let lineNumberMatch = errorText.match(lineNumberRegex);
		let lineNumber = lineNumberMatch ? lineNumberMatch[1].trim() : null;

		if (lineNumber) {
			const codeLineRegex = new RegExp(
				`(?:^|\\D)(${lineNumber}\\s+[^\\d].*)`,
				"m",
			);
			const codeLineMatch = errorText.match(codeLineRegex);
			const codeLine = codeLineMatch ? codeLineMatch[1].trim() : null;

			if (codeLine) {
				return `${codeLine}`;
			}
		}
	}
	return null;
};

export const limitStringLength = (str: string, maxLength = 200) => {
	const delimeter = "[[...]]";
	const length = str.length;
	const maxStrLength = maxLength - delimeter.length;
	if (length > maxLength) {
		return (
			str.substring(0, Math.floor(maxStrLength / 2)) +
			delimeter +
			str.substring(length - Math.floor(maxStrLength / 2), length)
		);
	} else {
		return str;
	}
};

export const stringifyWithoutStringValues = (obj: any): string => {
	if (obj === undefined || obj === null) {
		return "";
	}

	return JSON.stringify(obj, (key, value) => {
		if (typeof value === "string") {
			return value;
		}
		if (typeof value === "object" && value !== null) {
			return Object.entries(value).reduce((acc, [k, v]) => {
				if (typeof v === "string") {
					(acc as Record<string, any>)[k] = v;
				} else {
					(acc as Record<string, any>)[k] = JSON.parse(
						JSON.stringify(v),
					);
				}
				return acc;
			}, {});
		}
		return value;
	});
};

export const isValidUUID = (uuidString: string): boolean => {
	const uuidRegex: RegExp =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuidString);
};
