import { ModelMessage } from "ai";
import { create } from "zustand";

// Persists the running multi-turn conversation between the user and the agent
// so each new query carries the prior turns (and the tool calls/results the
// agent produced) forward as context. Reset with `reset()` (the "New" button).
interface AgentConversationStore {
	messages: ModelMessage[];
	append: (messages: ModelMessage[]) => void;
	reset: () => void;
}

export const useAgentConversationStore = create<AgentConversationStore>(
	(set) => ({
		messages: [],
		append: (messages) =>
			set((state) => ({ messages: [...state.messages, ...messages] })),
		reset: () => set({ messages: [] }),
	}),
);
