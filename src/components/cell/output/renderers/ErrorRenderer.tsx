import {
	Box,
	Button,
	HStack,
	VStack,
	useColorModeValue,
} from "@chakra-ui/react";
import AnsiToHtml from "ansi-to-html";
import React, { useMemo, useRef } from "react";
import { MagnifyingGlassIcon, WandIcon } from "../../../../assets/icons";
import { useScrollToBottom } from "../../../../hooks/useScroll";
import {
	OUTPUT_AREA_CSS,
	OUTPUT_AREA_MAX_HEIGHT,
} from "../../../../utils/constants/constants";
import {
	extractErrorLineWithRegex,
	removeAnsiEscapeSequences,
} from "../../../../utils/utils";
import { useNotebookStore } from "../../../notebook/store/NotebookStore";
import { trackEventData } from "../../../../utils/posthog";
import useCellStore, { CellStatus } from "../../store/CellStore";

const FixButton = ({ onClick }: { onClick: () => void }) => {
	return (
		<Button
			leftIcon={<WandIcon />}
			size="sm"
			colorScheme="orange"
			variant="solid"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
				trackEventData("[Output] Automatically fix error clicked");
			}}
			fontFamily={"var(--chakra-fonts-body)"}
		>
			Automatically fix error
		</Button>
	);
};

// The string jupyter lab generates for the last traceback
const TRACEBACK_START_TARGET_STRING =
	"---------------------------------------------------------------------------";

const ErrorRenderer = ({
	cellId,
	traceback,
	containerRef,
	index,
	ename,
	evalue,
}: {
	cellId: string;
	traceback: string[];
	containerRef: React.RefObject<HTMLDivElement>;
	ename: string;
	evalue: string;
	index: number;
}) => {
	const magicQuery = useNotebookStore.getState().magicQuery;
	const errorOutputRef = useRef<HTMLDivElement>(null);
	const tracebackRef = useRef<HTMLDivElement>(null);
	const errorBgColor = useColorModeValue("red.100", "red.900");
	const joinedTraceback = traceback
		.map((traceback) => removeAnsiEscapeSequences(traceback))
		.join("\n");
	const getLineThatErrored = () => extractErrorLineWithRegex(joinedTraceback);
	const getErrorPrompt = () => {
		return `lineThatErrored: ${getLineThatErrored()}
error: ${ename + ": " + evalue}`;
	};

	const convert = useColorModeValue(
		new AnsiToHtml({
			newline: true,
			colors: {
				3: "var(--chakra-colors-red-200)",
			},
			fg: "var(--chakra-colors-chakra-body-text)",
			bg: "transparent",
		}),
		new AnsiToHtml({
			newline: true,
			colors: {
				1: "var(--chakra-colors-red-200)",
				6: "var(--chakra-colors-green-400)",
				2: "var(--chakra-colors-green-300)",
				3: "var(--chakra-colors-red-200)",
			},
			fg: "var(--chakra-colors-chakra-body-text)",
			bg: "transparent",
		}),
	);

	const formattedTraceback = useMemo(() => {
		const targetIndex = traceback.findIndex((line) =>
			line.includes(TRACEBACK_START_TARGET_STRING),
		);

		const lastTraceback = traceback.slice(
			targetIndex != -1 ? -targetIndex : -traceback.length,
		);

		return lastTraceback.map((line) => convert.toHtml(line)).join("<br/>");
	}, [traceback, convert]);

	const { handleScroll: handleScrollTraceback } =
		useScrollToBottom(tracebackRef);

	return (
		<VStack
			alignItems={"flex-start"}
			ref={errorOutputRef}
			width="100%"
			gap={0}
			minH={0}
		>
			<HStack alignItems={"stretch"} width="100%">
				<Box
					bg={errorBgColor}
					width="100%"
					sx={OUTPUT_AREA_CSS}
					position={"relative"}
					ref={tracebackRef}
					onScroll={handleScrollTraceback}
				>
					<pre
						style={{
							whiteSpace: "pre-wrap",
							padding: "0 var(--chakra-space-4)",
							backgroundColor: errorBgColor,
						}}
						dangerouslySetInnerHTML={{ __html: formattedTraceback }}
					/>

					<HStack px="4" my="4">
						<FixButton
							onClick={() => {
								// Focus the cell, then let the agent fix the error.
								useNotebookStore
									.getState()
									.setActiveCell(cellId);
								magicQuery(
									"Fix the following error:\n" +
										getErrorPrompt(),
								);
							}}
						/>

						<Button
							size="sm"
							fontFamily={"body"}
							leftIcon={<MagnifyingGlassIcon />}
							variant={"solid"}
							colorScheme="pink"
							onClick={() => {
								useNotebookStore
									.getState()
									.setActiveCell(cellId);
								magicQuery(
									"Explain the following error in a markdown cell:\n" +
										getErrorPrompt(),
								);
							}}
						>
							Explain error
						</Button>
					</HStack>
				</Box>
			</HStack>
		</VStack>
	);
};

export default ErrorRenderer;
