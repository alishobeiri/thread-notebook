import {
	ArrowDownIcon,
	ArrowUpIcon,
	CloseIcon,
} from "@chakra-ui/icons";
import {
	Box,
	HStack,
	IconButton,
	Text,
	Textarea,
	Tooltip,
	VStack,
} from "@chakra-ui/react";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import ResizeTextarea from "react-textarea-autosize";
import { ChatSubmitIcon, CodeIcon } from "../../assets/icons";
import {
	CELL_GUTTER_WIDTH,
	CELL_MINIMUM_HEIGHT,
} from "../../utils/constants/constants";
import { trackClickEvent, trackEventData } from "../../utils/posthog";
import {
	isInViewport,
	isPlatformMac,
	multilineStringToString,
} from "../../utils/utils";
import { enableCommandMode } from "../cell/actions/actions";
import useCellStore, { CellStatus } from "../cell/store/CellStore";
import SpinnerWithStopButton from "../misc/SpinnerWithStopButton";
import { useNotebookStore } from "../notebook/store/NotebookStore";
import { AgentTrace } from "./AgentTrace";
import { useMagicInputStore } from "./MagicInputStore";

// Detects an in-progress "@mention" at the caret: an "@" at the start or after
// whitespace, followed by non-whitespace up to the caret. Returns the query
// text and the "@" position, or null if the caret isn't in a mention.
const getMentionToken = (
	value: string,
	caret: number,
): { query: string; start: number } | null => {
	const before = value.slice(0, caret);
	const at = before.lastIndexOf("@");
	if (at === -1) return null;
	if (at > 0 && !/\s/.test(value[at - 1])) return null;
	const query = before.slice(at + 1);
	if (/\s/.test(query)) return null;
	return { query, start: at };
};

const cellFirstLine = (cell: { source: any }): string =>
	multilineStringToString(cell.source)
		.split("\n")
		.find((l) => l.trim()) ?? "";

const goToActiveCell = (mainPanelRef: React.RefObject<HTMLDivElement>) => {
	const activeCell = document.querySelector(".active-cell");
	if (activeCell && mainPanelRef.current) {
		const offset = 100;
		const elementTop = activeCell.getBoundingClientRect().top;
		const containerScrollTop = mainPanelRef.current.scrollTop;
		const containerTop = mainPanelRef.current.getBoundingClientRect().top;
		const relativeTop = elementTop + containerScrollTop - containerTop;
		const offsetPosition = relativeTop - offset;

		trackEventData("[CLICK] Go to active cell");
		mainPanelRef.current.scrollTo({
			top: offsetPosition,
		});
	}
};

export function GoToActiveCell({
	mainPanelRef,
}: {
	mainPanelRef: React.RefObject<HTMLDivElement>;
}) {
	const [showGoToActiveCell, setShowGoToActiveCell] = useState(false);
	const [isAbove, setIsAbove] = useState(true);

	const checkCellPosition = () => {
		const activeCell = document.querySelector(".active-cell");
		if (!activeCell) return;
		const cellEditor = activeCell.querySelector(".cell-editor");

		if (isInViewport(cellEditor)) {
			setShowGoToActiveCell(false);
		} else {
			setShowGoToActiveCell(true);
		}

		// You can also check the position of the cell editor relative to the viewport
		if (cellEditor) {
			const rect = cellEditor.getBoundingClientRect();
			const isAboveViewport = rect.top < 0;
			setIsAbove(isAboveViewport);
		}
	};

	useEffect(() => {
		if (!mainPanelRef.current) return;
		mainPanelRef.current.addEventListener("click", checkCellPosition);
		mainPanelRef.current.addEventListener("scroll", checkCellPosition);

		return () => {
			if (!mainPanelRef.current) return;
			mainPanelRef.current.removeEventListener(
				"click",
				checkCellPosition,
			);
			mainPanelRef.current.removeEventListener(
				"scroll",
				checkCellPosition,
			);
		};
	}, []);

	return (
		<Tooltip label="Go to active cell" placement="left">
			<Box
				as="span"
				display="flex"
				width={`${CELL_GUTTER_WIDTH - 5}px`}
				justifyContent={"flex-end"}
				visibility={showGoToActiveCell ? "visible" : "hidden"}
			>
				<IconButton
					aria-label="Go to active cell"
					size="sm"
					variant="outline"
					borderRadius={"full"}
					icon={isAbove ? <ArrowUpIcon /> : <ArrowDownIcon />}
					backgroundColor="var(--jp-layout-color1)"
					onClick={() => {
						goToActiveCell(mainPanelRef);
					}}
				/>
			</Box>
		</Tooltip>
	);
}

const RightIcon = ({
	isLoading,
	handleQuery,
	value,
}: {
	isLoading: boolean;
	handleQuery: (value: string) => void;
	value: string;
}) => {
	const onStopClick = () => {
		trackClickEvent("[MagicQuery] aborted");
		useNotebookStore.getState().abortMagicQuery();
	};

	return isLoading ? (
		<SpinnerWithStopButton isSpinning={true} onClick={onStopClick} />
	) : (
		<IconButton
			size="sm"
			p={1}
			borderRadius="md"
			colorScheme="orange"
			isDisabled={false}
			icon={<ChatSubmitIcon />}
			onClick={() => handleQuery(value)}
			aria-label="Send query"
		/>
	);
};

export const MagicInput = ({
	refToTrack,
}: {
	refToTrack: React.RefObject<HTMLDivElement>;
}) => {
	const textareaBackgroundColor = "var(--jp-layout-color1)";
	const textareaBorderColor = "var(--jp-border-color2)";
	const isGeneratingCells = useNotebookStore(
		(state) => state.isGeneratingCells,
	);
	const activeCell = useNotebookStore.getState().getActiveCell();
	const cellState =
		useCellStore((state) => state.cellStates)[activeCell.id as string] ??
		{};
	const selectedCode = useMagicInputStore((state) => state.selectedCode);
	const setSelectedCode = useMagicInputStore.getState().setSelectedCode;

	const {
		acceptAndRunProposedSource,
		acceptProposedSource,
		rejectProposedSource,
	} = useCellStore.getState();
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const getCtrlKey = () => {
		const isMac = isPlatformMac();
		return `${isMac ? "⌘" : "Ctrl"}`;
	};

	const getCommandKey = () => {
		if (isGeneratingCells) {
			return `${getCtrlKey()} + ⌫ to stop`;
		}
		return `${getCtrlKey()} + K to focus`;
	};

	const lines = selectedCode.split("\n").length;

	useMagicInputStore.getState().setTextareaRef(textareaRef);

	const value = useMagicInputStore((state) => state.value);
	const { setValue, handleQuery } = useMagicInputStore.getState();

	const [isFocused, setIsFocused] = useState(false);

	// --- @-mention of cells -------------------------------------------------
	const cells = useNotebookStore((state) => state.cells);
	const mentions = useMagicInputStore((state) => state.mentions);
	const { addMention, removeMention } = useMagicInputStore.getState();
	const [mentionToken, setMentionToken] = useState<{
		query: string;
		start: number;
	} | null>(null);
	const [highlightedMention, setHighlightedMention] = useState(0);

	const mentionCandidates = mentionToken
		? cells
				.map((cell, index) => ({ cell, index }))
				.filter(({ cell, index }) => {
					const q = mentionToken.query.toLowerCase();
					if (!q) return true;
					return `${index} ${cell.cell_type} ${cellFirstLine(cell)}`
						.toLowerCase()
						.includes(q);
				})
				.slice(0, 8)
		: [];

	const refreshMentionToken = () => {
		const el = textareaRef.current;
		if (!el) return;
		setMentionToken(
			getMentionToken(el.value, el.selectionStart ?? el.value.length),
		);
		setHighlightedMention(0);
	};

	const selectMention = (cell: any, index: number) => {
		if (!mentionToken) return;
		const newValue =
			value.slice(0, mentionToken.start) +
			value.slice(mentionToken.start + 1 + mentionToken.query.length);
		setValue(newValue);
		addMention({ id: cell.id as string, label: `Cell ${index}` });
		const caret = mentionToken.start;
		setMentionToken(null);
		requestAnimationFrame(() => {
			const el = textareaRef.current;
			if (el) {
				el.focus();
				el.setSelectionRange(caret, caret);
			}
		});
	};

	const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
		setValue(e.target.value);
		setMentionToken(
			getMentionToken(
				e.target.value,
				e.target.selectionStart ?? e.target.value.length,
			),
		);
		setHighlightedMention(0);
	};

	const handleKeyPress = (
		event: React.KeyboardEvent<HTMLTextAreaElement>,
	) => {
		// @-mention menu navigation takes priority while it's open.
		if (mentionToken && mentionCandidates.length > 0) {
			if (event.key === "ArrowDown") {
				setHighlightedMention(
					(h) => (h + 1) % mentionCandidates.length,
				);
				event.preventDefault();
				return;
			}
			if (event.key === "ArrowUp") {
				setHighlightedMention(
					(h) =>
						(h - 1 + mentionCandidates.length) %
						mentionCandidates.length,
				);
				event.preventDefault();
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				const choice = mentionCandidates[highlightedMention];
				selectMention(choice.cell, choice.index);
				event.preventDefault();
				event.stopPropagation();
				return;
			}
			if (event.key === "Escape") {
				setMentionToken(null);
				event.preventDefault();
				return;
			}
		}

		// Handle meta/ctrl + Enter
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			if (event.shiftKey) {
				acceptAndRunProposedSource(activeCell.id as string);
			} else {
				acceptProposedSource(activeCell.id as string);
			}
			event.preventDefault();
		} else if (
			(event.metaKey || event.ctrlKey) &&
			event.key === "Backspace"
		) {
			if (isGeneratingCells) {
				useNotebookStore.getState().abortMagicQuery();
				event.preventDefault();
			} else if (cellState.status == CellStatus.FollowUp) {
				rejectProposedSource(activeCell.id as string);
				event.preventDefault();
			}
		} else if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!isGeneratingCells
		) {
			// Handle Enter key without Shift
			handleQuery(value);
			event.stopPropagation();
			event.preventDefault();
		} else if (event.key === "Escape") {
			// Handle Escape key
			if (selectedCode !== "") {
				setSelectedCode("");
			} else if (textareaRef.current) {
				textareaRef.current.blur();
			}
		}
	};

	return (
		<HStack
			width={"100%"}
			bottom="40px"
			left="0"
			right="0"
			borderColor="gray.200"
			zIndex="1"
			mx="auto"
			backgroundColor="transparent"
			position={"absolute"}
			borderRadius="xl"
		>
			<GoToActiveCell mainPanelRef={refToTrack} />
			<VStack
				position="relative"
				flex="1"
				minW={0}
				tabIndex={0}
				borderWidth={"2px"}
				backgroundColor={textareaBackgroundColor}
				borderRadius="lg"
				boxShadow={"md"}
				alignItems="center"
				pl={3}
				pr={2}
				py={0.5}
				mr={"0.40rem"}
				gap={0.5}
				borderColor={
					isFocused
						? `${"var(--jp-brand-color1)"}`
						: `${textareaBorderColor}`
				}
			>
				<AgentTrace />
				{selectedCode != "" && (
					<HStack
						alignSelf={"flex-start"}
						mt={4}
						px={4}
						py={1}
						w={"100%"}
						bg={"var(--jp-layout-color2)"}
						borderRadius={"lg"}
						justifyContent={"space-between"}
						cursor={"pointer"}
						onClick={() => {
							goToActiveCell(refToTrack);
						}}
					>
						<HStack
							gap={4}
							justifyContent="center"
							alignItems="center"
						>
							<CodeIcon boxSize={"0.7em"} />
							<Text
								fontFamily={"Space Grotesk"}
								fontSize={"sm"}
							>{`Selected ${
								selectedCode.split("\n").length
							} line${lines > 1 ? "s" : ""}`}</Text>
						</HStack>
						<IconButton
							size={"0.1em"}
							icon={<CloseIcon boxSize={"0.7em"} />}
							variant={"ghost"}
							aria-label="Close"
							onClick={(event) => {
								setSelectedCode("");
							}}
						/>
					</HStack>
				)}

				{mentions.length > 0 && (
						<HStack alignSelf="flex-start" w="100%" flexWrap="wrap" gap={1} mt={1}>
							{mentions.map((m) => (
								<HStack
									key={m.id}
									bg={"var(--jp-layout-color2)"}
									borderRadius="md"
									px={2}
									py={0.5}
									gap={1}
								>
									<Text fontSize="xs" fontWeight={600}>@{m.label}</Text>
									<CloseIcon
										boxSize="0.5em"
										cursor="pointer"
										onClick={() => removeMention(m.id)}
									/>
								</HStack>
							))}
						</HStack>
					)}

					{mentionToken && mentionCandidates.length > 0 && (
						<VStack
							alignSelf="stretch"
							w="100%"
							maxH="180px"
							overflowY="auto"
							bg={"var(--jp-layout-color1)"}
							borderWidth="1px"
							borderColor="var(--jp-border-color2)"
							borderRadius="md"
							gap={0}
							mb={1}
							align="stretch"
						>
							{mentionCandidates.map(({ cell, index }, i) => (
								<HStack
									key={cell.id as string}
									px={2}
									py={1}
									gap={2}
									cursor="pointer"
									bg={
										i === highlightedMention
											? "var(--jp-layout-color2)"
											: "transparent"
									}
									onMouseEnter={() => setHighlightedMention(i)}
									onClick={() => selectMention(cell, index)}
								>
									<Text fontSize="xs" fontWeight={600} flexShrink={0}>
										Cell {index}
									</Text>
									<Text fontSize="xs" color="gray.500" flexShrink={0}>
										{cell.cell_type}
									</Text>
									<Text fontSize="xs" color="gray.500" isTruncated minW={0}>
										{cellFirstLine(cell)}
									</Text>
								</HStack>
							))}
						</VStack>
					)}

					<HStack width={"100%"} align="center" gap={2}>
					<Textarea
						ref={textareaRef}
						id="generate-textarea"
						onChange={handleChange}
						onClick={refreshMentionToken}
						value={value}
						onKeyDown={handleKeyPress}
						onFocus={() => {
							setIsFocused(true);
							enableCommandMode();
						}}
						onBlur={() => {
							setIsFocused(false);
							enableCommandMode();
						}}
						boxShadow="none"
						outline="none"
						border="0px solid transparent"
						as={ResizeTextarea}
						fontSize="sm"
						lineHeight="1.4"
						minH="unset"
						py="0.15rem"
						pl="0"
						pr="0"
						rows={1}
						placeholder={"What would you like to do?"}
						_placeholder={{
							fontFamily: "Space Grotesk",
							fontSize: "sm",
						}}
						flexGrow={1}
						minRows={1}
						width="100%"
						resize="none"
						overflow="hidden"
						_focusVisible={{
							outline: "none",
						}}
					/>
					<Text
						flexShrink={0}
						whiteSpace="nowrap"
						fontFamily="Space Grotesk"
						fontSize="0.6rem"
						lineHeight="1"
						opacity={0.6}
						color="var(--chakra-colors-chakra-placeholder-color)"
						display={{ base: "none", md: "block" }}
						m={0}
						p={0}
					>
						{getCommandKey()}
					</Text>
					<RightIcon
						isLoading={isGeneratingCells}
						handleQuery={handleQuery}
						value={value}
					/>
				</HStack>
			</VStack>
		</HStack>
	);
};
