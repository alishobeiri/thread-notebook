export type ModelInformation = {
	openAIKey?: string;
	openAIBaseUrl?: string;
	ollamaUrl?: string;
	ollamaModel?: string;
	anthropicKey?: string,
	anthropicModel?: string,
	anthropicBaseUrl?: string,
	isLocal?: boolean,
	modelType?: string;
};

export const getModelForRequest = (modelInformation?: ModelInformation) => {
	const { modelType, ollamaModel, anthropicModel } = modelInformation || {};

	if (modelType === "ollama") {
		return ollamaModel || "";
	}

	if (modelType === "anthropic") {
		return anthropicModel || "";
	}

	return "gpt-5.5";
};

export const getAPIKeyForRequest = (modelInformation?: ModelInformation) => {
	const { modelType, openAIKey, anthropicKey } = modelInformation || {};

	if (modelType === "ollama") {
		return "EMPTY";
	}

	if (modelType === "anthropic") {
		const ANTHROPIC_API_KEY: string = process.env.ANTHROPIC_API_KEY || "";
		return anthropicKey || ANTHROPIC_API_KEY;
	}

	const OPENAI_API_KEY: string = process.env.OPENAI_API_KEY || "";
	return openAIKey || OPENAI_API_KEY;
};

export const getBaseURLForRequest = (modelInformation?: ModelInformation) => {
	const { modelType, openAIBaseUrl, ollamaUrl, anthropicBaseUrl } = modelInformation || {};

	if (modelType === "ollama") {
		return ollamaUrl || "http://0.0.0.0:11434/v1";
	}

	if (modelType === "anthropic") {
		const ANTHROPIC_BASE_URL: string =
			process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1";

		return anthropicBaseUrl || ANTHROPIC_BASE_URL;
	}

	const OPENAI_BASE_URL: string =
		process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

	return openAIBaseUrl || OPENAI_BASE_URL;
};
