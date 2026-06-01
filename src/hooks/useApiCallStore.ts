import { create } from "zustand";

interface ApiCallState {
	apiCallCount: number;
	incrementApiCallCount: () => void;
	resetApiCallCount: () => void;
	checkAndIncrementApiCallCount: () => boolean;
}

export const MAX_AI_API_CALLS = 25;

const useApiCallStore = create<ApiCallState>((set) => ({
	apiCallCount:
		typeof window !== "undefined"
			? parseInt(
					localStorage.getItem("threadNotebookApiCallCount") || "0",
					10,
			  )
			: 0,
	incrementApiCallCount: () =>
		set((state) => {
			const newCount = state.apiCallCount + 1;
			localStorage.setItem(
				"threadNotebookApiCallCount",
				newCount.toString(),
			);
			return { apiCallCount: newCount };
		}),
	resetApiCallCount: () =>
		set(() => {
			localStorage.setItem("threadNotebookApiCallCount", "0");
			return { apiCallCount: 0 };
		}),
	checkAndIncrementApiCallCount: () => {
		const { incrementApiCallCount } = useApiCallStore.getState();

		// AI query limit disabled for now: always allow the call through
		// instead of capping at MAX_AI_API_CALLS and showing the limit modal.
		// (Re-enable by restoring the isLocal/openAIKey/serverProxyUrl checks
		// and the apiCallCount >= MAX_AI_API_CALLS gate.)
		incrementApiCallCount();
		return true;
	},
}));

export default useApiCallStore;
