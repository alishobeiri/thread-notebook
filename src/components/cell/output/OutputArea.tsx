import "katex/dist/katex.min.css";
import {
	Box,
	Flex,
	HStack,
	Text,
	VStack,
	useBreakpointValue,
	useColorModeValue,
} from "@chakra-ui/react";
import { IDisplayData, IError, IOutput, IStream } from "@jupyterlab/nbformat";
import AnsiToHtml from "ansi-to-html";
import React, { useEffect, useMemo, useRef, useState } from "react";

// Only offer the Jupyter-style collapse control once the output is tall enough
// that hiding it is actually useful.
const COLLAPSE_MIN_HEIGHT = 150;
import { useScrollToBottom } from "../../../hooks/useScroll";
import {
	CELL_GUTTER_WIDTH,
	OUTPUT_AREA_MAX_HEIGHT,
	SCROLL_CSS,
	SCROLL_TO_BOTTOM_THRESHOLD,
	START_HIDE_CURSOR,
	STOP_HIDE_CURSOR,
} from "../../../utils/constants/constants";
import { multilineStringToString } from "../../../utils/utils";
import { useNotebookStore } from "../../notebook/store/NotebookStore";
import { mimeRenderer } from "./mimeRenderer";
import ErrorRenderer from "./renderers/ErrorRenderer";

interface OutputAreaProps {
	index: number;
	cellId: string;
	outputs: IOutput[];
	className?: string;
}

const convert = new AnsiToHtml({ newline: true });

let cursor = {
	shouldShow: true,
	outputIndex: 0,
};
const streamPreProcessor = (streamOutput: IStream, i: number) => {
	const startHideCursor = streamOutput.text.includes(START_HIDE_CURSOR);
	const stopHideCursor = streamOutput.text.includes(STOP_HIDE_CURSOR);

	if (startHideCursor) {
		cursor = {
			shouldShow: false,
			outputIndex: i,
		};
	} else if (stopHideCursor) {
		cursor = {
			shouldShow: true,
			outputIndex: i + 1,
		};
	}
};

// Hard cap on how much stream (stdout/stderr) text we put in the DOM. A huge
// print loop can produce megabytes of output; rendering it all as one <pre>
// freezes/crashes the tab. We keep the most recent slice (that's usually what
// matters) and prepend a notice, mirroring Jupyter's own output truncation.
const MAX_STREAM_OUTPUT_CHARS = 100_000;

const capStreamText = (text: string): string => {
	if (text.length <= MAX_STREAM_OUTPUT_CHARS) return text;
	const removed = text.length - MAX_STREAM_OUTPUT_CHARS;
	return (
		`[… ${removed.toLocaleString()} earlier characters truncated to keep the UI responsive — showing the last ${MAX_STREAM_OUTPUT_CHARS.toLocaleString()} characters …]\n` +
		text.slice(text.length - MAX_STREAM_OUTPUT_CHARS)
	);
};

const streamPostProcessor = (streamOutput: IStream) => {
	return capStreamText(
		multilineStringToString(streamOutput.text)
			.replace(START_HIDE_CURSOR, "")
			.replace(STOP_HIDE_CURSOR, ""),
	);
};

const shouldHideOutput = (i: number, outputsLength: number) => {
	return (
		!cursor.shouldShow && cursor.outputIndex <= i && i != outputsLength - 1
	);
};

const OutputArea: React.FC<OutputAreaProps> = React.memo(
	({ index, cellId, outputs, className = "" }) => {
		const outputRef = useRef<HTMLDivElement>(null);
		const setActiveCell = useNotebookStore.getState().setActiveCell;
		// Jupyter-style: click the left gutter bar to collapse/expand the output.
		const [collapsed, setCollapsed] = useState(false);
		// Whether the output is tall enough to be worth collapsing.
		const [canCollapse, setCanCollapse] = useState(false);
		const accentColor = useColorModeValue("orange.500", "orange.400");

		// Re-measure as the content actually changes size — outputs like plots,
		// tables and images render/grow asynchronously, so a one-shot measure
		// would miss them and never reveal the collapse control.
		useEffect(() => {
			const el = outputRef.current;
			if (!el) return;
			const measure = () =>
				setCanCollapse(el.scrollHeight > COLLAPSE_MIN_HEIGHT);
			measure();
			const observer = new ResizeObserver(measure);
			observer.observe(el);
			return () => observer.disconnect();
		}, [outputs, collapsed]);

		const showCollapseControl = canCollapse || collapsed;
		const { handleScroll } = useScrollToBottom(
			outputRef,
			SCROLL_TO_BOTTOM_THRESHOLD,
		);

		const renderedOutputs = useMemo(
			() =>
				outputs.map((output: IOutput, i) => {
					let mimeKey: string;
					delete output["transient"];
					switch (output.output_type) {
						case "stream":
							const streamOutput = output as IStream;
							streamPreProcessor(streamOutput, i);
							if (shouldHideOutput(i, outputs.length)) {
								return null;
							}

							return (
								<pre
									style={{
										width: "100%",
										fontFamily: "monospace",
										whiteSpace: "pre-wrap",
									}}
									key={i}
									dangerouslySetInnerHTML={{
										__html: convert.toHtml(
											streamPostProcessor(streamOutput),
										),
									}}
								/>
							);
						case "display_data":
							const displayData = output as IDisplayData;
							mimeKey = Object.keys(displayData.data)
								.sort()
								.join(";");
							return mimeRenderer(
								i,
								cellId,
								mimeKey,
								displayData,
							);
						case "execute_result":
							const executeResult = output as IDisplayData;
							mimeKey = Object.keys(executeResult.data)
								.sort()
								.join(";");
							return mimeRenderer(
								i,
								cellId,
								mimeKey,
								executeResult,
							);
						case "error":
							const errorResult = output as IError;
							return (
								<ErrorRenderer
									cellId={cellId as string}
									containerRef={outputRef}
									key={i}
									index={index}
									traceback={errorResult.traceback}
									ename={errorResult.ename}
									evalue={errorResult.evalue}
								/>
							);
					}
				}),
			[cellId, outputs, index, outputRef],
		);

		return (
			<HStack
				width={"100%"}
				overflow="auto"
				justifyContent={"flex-start"}
				position="relative"
				gap={2}
				className={className}
				alignItems={"stretch"}
				fontSize={"var(--jp-code-font-size)"}
				borderLeft="3px solid transparent"
				onClick={() => setActiveCell(cellId)}
			>
				<Flex
					width={`${CELL_GUTTER_WIDTH}px`}
					flexShrink={0}
					justifyContent="flex-end"
					alignItems="stretch"
					cursor={showCollapseControl ? "pointer" : "default"}
					role={showCollapseControl ? "button" : undefined}
					aria-label={
						!showCollapseControl
							? undefined
							: collapsed
							? "Expand output"
							: "Collapse output"
					}
					title={
						!showCollapseControl
							? undefined
							: collapsed
							? "Expand output"
							: "Collapse output"
					}
					onClick={(e) => {
						if (!showCollapseControl) return;
						e.stopPropagation();
						setCollapsed((c) => !c);
					}}
					sx={{ "&:hover .output-collapse-bar": { opacity: 0.9 } }}
				>
					{showCollapseControl && (
						<Box
							className="output-collapse-bar"
							w="4px"
							mr="3px"
							my={1}
							borderRadius="full"
							bg={accentColor}
							opacity={collapsed ? 0.9 : 0.45}
							transition="opacity 0.12s ease"
						/>
					)}
				</Flex>
				{collapsed ? (
					<Box
						flex={1}
						py={1}
						cursor="pointer"
						onClick={() => setCollapsed(false)}
					>
						<Text fontSize="xs" color="gray.500" fontFamily="body">
							Output collapsed — click to expand
						</Text>
					</Box>
				) : (
					<VStack
						spacing={0}
						ref={outputRef}
						w={"100%"}
						flex={1}
						overflowX={"hidden"}
						maxHeight={`${OUTPUT_AREA_MAX_HEIGHT}px`}
						overflowY={"auto"}
						fontFamily={"monospace"}
						alignItems={"flex-start"}
						zIndex="6"
						sx={SCROLL_CSS}
						onScroll={handleScroll}
					>
						{renderedOutputs}
					</VStack>
				)}
			</HStack>
		);
	},
);

OutputArea.displayName = "OutputArea";
export default OutputArea;
