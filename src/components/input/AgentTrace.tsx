import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "@chakra-ui/icons";
import { Box, Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useNotebookStore } from "../notebook/store/NotebookStore";
import { useAgentConversationStore } from "../../utils/magic/agent/conversationStore";
import {
	TraceEntry,
	useAgentTraceStore,
} from "../../utils/magic/agent/traceStore";

type ActionEntry = Extract<TraceEntry, { kind: "action" }>;

const ActionStatusIcon = ({
	status,
}: {
	status: "running" | "done" | "error";
}) => {
	if (status === "running") {
		return <Spinner size="xs" color="orange.400" speed="0.7s" />;
	}
	if (status === "error") {
		return (
			<Text as="span" color="red.400" fontSize="sm" lineHeight="1">
				✗
			</Text>
		);
	}
	return <CheckIcon boxSize="0.6em" color="green.400" />;
};

const ActionRow = ({ entry }: { entry: ActionEntry }) => (
	<HStack
		w="100%"
		gap={2}
		alignItems="center"
		fontFamily="var(--chakra-fonts-mono)"
	>
		<Box flexShrink={0} w="14px" textAlign="center">
			<ActionStatusIcon status={entry.status} />
		</Box>
		<Text fontSize="xs" fontWeight={600} flexShrink={0}>
			{entry.tool}
		</Text>
		{entry.summary && (
			<Text fontSize="xs" color="gray.500" isTruncated minW={0}>
				{entry.summary}
			</Text>
		)}
		{entry.detail && entry.status === "error" && (
			<Text fontSize="xs" color="red.400" isTruncated minW={0}>
				{entry.detail}
			</Text>
		)}
	</HStack>
);

// A run of consecutive tool steps, shown under a clickable header. While any
// step is running (or one errored) it auto-expands; once they all finish
// cleanly it auto-collapses to a one-line "✓ N steps · tools…" summary. The
// header toggles open/closed at any time.
const ActionGroup = ({ actions }: { actions: ActionEntry[] }) => {
	const anyRunning = actions.some((a) => a.status === "running");
	const hasError = actions.some((a) => a.status === "error");
	const [open, setOpen] = useState(true);

	// Auto-expand while active / on error; auto-collapse once finished cleanly.
	// Deps are just the derived flags, so a manual toggle afterwards sticks.
	useEffect(() => {
		setOpen(anyRunning || hasError);
	}, [anyRunning, hasError]);

	const tools = Array.from(new Set(actions.map((a) => a.tool))).join(", ");

	return (
		<VStack w="100%" gap={0.5} align="flex-start">
			<HStack
				w="100%"
				gap={2}
				alignItems="center"
				cursor="pointer"
				fontFamily="var(--chakra-fonts-mono)"
				onClick={() => setOpen(!open)}
			>
				<Box flexShrink={0} w="14px" textAlign="center">
					{anyRunning ? (
						<Spinner size="xs" color="orange.400" speed="0.7s" />
					) : hasError ? (
						<Text as="span" color="red.400" fontSize="sm" lineHeight="1">
							✗
						</Text>
					) : (
						<CheckIcon boxSize="0.6em" color="green.400" />
					)}
				</Box>
				<Text fontSize="xs" fontWeight={600} flexShrink={0}>
					{actions.length} step{actions.length > 1 ? "s" : ""}
				</Text>
				<Text fontSize="xs" color="gray.500" isTruncated flex="1" minW={0}>
					{tools}
				</Text>
				{open ? (
					<ChevronDownIcon boxSize="0.8em" color="gray.400" flexShrink={0} />
				) : (
					<ChevronRightIcon boxSize="0.8em" color="gray.400" flexShrink={0} />
				)}
			</HStack>
			{open && (
				<VStack w="100%" gap={1} align="flex-start" pl={4}>
					{actions.map((a) => (
						<ActionRow key={a.id} entry={a} />
					))}
				</VStack>
			)}
		</VStack>
	);
};

// Minimal markdown renderer for trace text (reasoning + narration). Inherits
// color/style from the wrapper so "thinking" stays muted/italic.
const mdComponents = {
	p: ({ children }: any) => (
		<Text fontSize="xs" color="inherit" mb={1} _last={{ mb: 0 }}>
			{children}
		</Text>
	),
	code: ({ children }: any) => (
		<Box
			as="code"
			fontSize="0.7rem"
			bg="var(--jp-layout-color3)"
			px={1}
			borderRadius="sm"
			fontFamily="var(--chakra-fonts-mono)"
		>
			{children}
		</Box>
	),
	pre: ({ children }: any) => (
		<Box
			as="pre"
			fontSize="0.7rem"
			bg="var(--jp-layout-color3)"
			p={2}
			my={1}
			borderRadius="md"
			overflowX="auto"
			fontFamily="var(--chakra-fonts-mono)"
		>
			{children}
		</Box>
	),
	ul: ({ children }: any) => (
		<Box as="ul" pl={4} mb={1} fontSize="xs">
			{children}
		</Box>
	),
	ol: ({ children }: any) => (
		<Box as="ol" pl={4} mb={1} fontSize="xs">
			{children}
		</Box>
	),
	li: ({ children }: any) => (
		<Box as="li" fontSize="xs">
			{children}
		</Box>
	),
	a: ({ children, href }: any) => (
		<Text as="a" href={href} color="blue.400" textDecoration="underline">
			{children}
		</Text>
	),
	strong: ({ children }: any) => (
		<Text as="strong" fontWeight={700}>
			{children}
		</Text>
	),
	// Render markdown headings as plain small bold text — no large headers in
	// the compact trace.
	h1: ({ children }: any) => heading(children),
	h2: ({ children }: any) => heading(children),
	h3: ({ children }: any) => heading(children),
	h4: ({ children }: any) => heading(children),
	h5: ({ children }: any) => heading(children),
	h6: ({ children }: any) => heading(children),
};

const heading = (children: any) => (
	<Text fontSize="xs" fontWeight={700} color="inherit" mb={1} _last={{ mb: 0 }}>
		{children}
	</Text>
);

const TextRow = ({
	entry,
}: {
	entry: Extract<TraceEntry, { kind: "user" | "thinking" | "note" }>;
}) => {
	if (entry.kind === "user") {
		return (
			<Text
				w="100%"
				fontFamily="Space Grotesk"
				fontSize="xs"
				fontWeight={600}
				mt={1}
				pt={2}
				borderTopWidth="1px"
				borderColor="var(--jp-border-color2)"
				_first={{ borderTopWidth: 0, pt: 0, mt: 0 }}
			>
				{entry.text}
			</Text>
		);
	}
	const isThinking = entry.kind === "thinking";
	return (
		<Box
			w="100%"
			fontSize="xs"
			color={
				isThinking ? "gray.500" : "var(--chakra-colors-chakra-body-text)"
			}
			fontStyle={isThinking ? "italic" : "normal"}
		>
			<Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
				{entry.text}
			</Markdown>
		</Box>
	);
};

// Coalesce consecutive action entries into groups; everything else passes
// through as-is, preserving order.
type RenderItem =
	| { type: "actions"; key: string; actions: ActionEntry[] }
	| { type: "text"; key: string; entry: TraceEntry };

const groupEntries = (entries: TraceEntry[]): RenderItem[] => {
	const items: RenderItem[] = [];
	let i = 0;
	while (i < entries.length) {
		if (entries[i].kind === "action") {
			const actions: ActionEntry[] = [];
			while (i < entries.length && entries[i].kind === "action") {
				actions.push(entries[i] as ActionEntry);
				i++;
			}
			items.push({ type: "actions", key: actions[0].id, actions });
		} else {
			items.push({ type: "text", key: entries[i].id, entry: entries[i] });
			i++;
		}
	}
	return items;
};

const collapsedPreview = (entries: TraceEntry[]): string => {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.kind === "note" || entry.kind === "thinking") {
			return entry.text;
		}
		if (entry.kind === "action") {
			return `${entry.tool} ${entry.summary}`.trim();
		}
	}
	return "";
};

// Live "Thinking" panel rendered above the notebook input. Accumulates the
// whole conversation; finished tool steps fold away to keep it compact.
export const AgentTrace = () => {
	const entries = useAgentTraceStore((state) => state.entries);
	const isRunning = useAgentTraceStore((state) => state.isRunning);
	const collapsed = useAgentTraceStore((state) => state.collapsed);
	const setCollapsed = useAgentTraceStore.getState().setCollapsed;
	const canRevert = useNotebookStore((state) => state.agentCheckpoint != null);

	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (isRunning && !collapsed && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [entries, isRunning, collapsed]);

	if (entries.length === 0 && !isRunning) return null;

	const items = groupEntries(entries);

	return (
		<VStack
			alignSelf="stretch"
			w="100%"
			mt={1}
			gap={0}
			bg="var(--jp-layout-color2)"
			borderRadius="md"
			overflow="hidden"
		>
			<HStack
				w="100%"
				px={3}
				py={0.5}
				gap={2}
				cursor="pointer"
				overflow="hidden"
				onClick={() => setCollapsed(!collapsed)}
			>
				{collapsed ? (
					<ChevronRightIcon boxSize="0.9em" flexShrink={0} />
				) : (
					<ChevronDownIcon boxSize="0.9em" flexShrink={0} />
				)}
				{isRunning && (
					<Spinner size="xs" color="orange.400" speed="0.7s" />
				)}
				{collapsed && !isRunning ? (
					<Text
						fontSize="xs"
						color="gray.500"
						isTruncated
						flex="1"
						minW={0}
					>
						{collapsedPreview(entries)}
					</Text>
				) : (
					<Box flex="1" />
				)}
				{!isRunning && canRevert && (
					<Button
						size="xs"
						variant="ghost"
						colorScheme="gray"
						fontFamily="Space Grotesk"
						flexShrink={0}
						onClick={(e) => {
							e.stopPropagation();
							useNotebookStore
								.getState()
								.revertToAgentCheckpoint();
						}}
					>
						↩ Revert
					</Button>
				)}
				{!isRunning && (
					<Button
						size="xs"
						variant="ghost"
						fontFamily="Space Grotesk"
						flexShrink={0}
						onClick={(e) => {
							e.stopPropagation();
							useAgentTraceStore.getState().clear();
							useAgentConversationStore.getState().reset();
						}}
					>
						Clear
					</Button>
				)}
			</HStack>
			{!collapsed && (
				<VStack
					ref={scrollRef}
					w="100%"
					align="flex-start"
					gap={1}
					pl={3}
					pr={2}
					pb={2}
					maxH="120px"
					overflowY="auto"
					sx={{
						"&::-webkit-scrollbar": { width: "8px" },
						"&::-webkit-scrollbar-track": {
							background: "transparent",
						},
						"&::-webkit-scrollbar-thumb": {
							background: "var(--jp-border-color2)",
							borderRadius: "4px",
							border: "2px solid transparent",
							backgroundClip: "content-box",
						},
					}}
				>
					{items.map((item) =>
						item.type === "actions" ? (
							<ActionGroup key={item.key} actions={item.actions} />
						) : (
							<TextRow
								key={item.key}
								entry={
									item.entry as Extract<
										TraceEntry,
										{ kind: "user" | "thinking" | "note" }
									>
								}
							/>
						),
					)}
				</VStack>
			)}
		</VStack>
	);
};
