import {
	Box,
	Button,
	CircularProgress,
	CircularProgressLabel,
	Flex,
	HStack,
	Text,
	Tooltip,
	VStack,
	useColorModeValue,
} from "@chakra-ui/react";
import { ExecutionCount, ICell, IOutput } from "@jupyterlab/nbformat";
import { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import React, { useEffect, useRef, useState } from "react";
import {
	CheckmarkIcon,
	PlayCircleIcon,
	StopCircleIcon,
} from "../../assets/icons";
import ConnectionManager from "../../services/connection/connectionManager";
import {
	CELL_ACTIVE_COLOR,
	CELL_GUTTER_WIDTH,
	CELL_MINIMUM_HEIGHT,
} from "../../utils/constants/constants";
import { isPlatformMac, multilineStringToString } from "../../utils/utils";
import { useNotebookStore } from "../notebook/store/NotebookStore";
import InputArea from "./input/InputArea";
import OutputArea from "./output/OutputArea";
import useCellStore, { CellStatus } from "./store/CellStore";

interface CellContainerProps {
	index: number;
	active: boolean;
	cell: ICell;
	queuedForExecution: boolean;
	isExecuting: boolean;
	isBeingEdited: boolean;
}

interface PythonCellProps {
	index: number;
	active: boolean;
	cell: ICell;
	isBeingEdited: boolean;
}

const CellHeaderActions = ({ cell }: { cell: ICell }) => {
	const { id: cellId } = cell;
	const cellState = useCellStore((state) => state.cellStates)[
		cellId as string
	];

	const getShortcutKey = () => (isPlatformMac() ? "⌘" : "Ctrl");

	useEffect(() => {
		// Define the keydown event handler
		const handleDocumentKeyDown = (event: KeyboardEvent) => {
			// Do not process if the cell state is follow up
			if (cellState?.status !== CellStatus.FollowUp) return;

			if (event.key === "Enter" && event.metaKey && event.shiftKey) {
				const { acceptAndRunProposedSource } = useCellStore.getState();
				acceptAndRunProposedSource(cellId as string);
				event.stopPropagation();
				event.preventDefault();
			} else if (event.key === "Enter" && event.metaKey) {
				const { acceptProposedSource } = useCellStore.getState();
				acceptProposedSource(cellId as string);
				event.stopPropagation();
				event.preventDefault();
			} else if (event.key === "Backspace" && event.metaKey) {
				const { rejectProposedSource } = useCellStore.getState();
				rejectProposedSource(cellId as string);
				event.stopPropagation();
				event.preventDefault();
			}
		};

		// Add the keydown event listener to the document
		document.addEventListener("keydown", handleDocumentKeyDown);

		// Clean up the event listener on unmount
		return () => {
			document.removeEventListener("keydown", handleDocumentKeyDown);
		};
	}, [cellId, cellState?.status]);

	return (
		<>
			{cellState?.status === CellStatus.FollowUp && (
				<HStack
					gap={1}
					px={2}
					py={2}
					justifyContent={"flex-start"}
					bg={"var(--chakra-colors-chakra-body-bg)"}
				>
					{cell && (
						<Button
							size="xs"
							colorScheme="green"
							onClick={() => {
								const { acceptAndRunProposedSource } =
									useCellStore.getState();
								acceptAndRunProposedSource(cellId as string);
							}}
						>
							{"Update and run (" +
								getShortcutKey() +
								"+Shift+⏎)"}
						</Button>
					)}
					<Button
						size="xs"
						variant={"ghost"}
						colorScheme="green"
						leftIcon={<CheckmarkIcon />}
						onClick={() => {
							const { acceptProposedSource } =
								useCellStore.getState();
							acceptProposedSource(cellId as string);
						}}
					>
						{"Update (" + getShortcutKey() + "+⏎)"}
					</Button>
					<Button
						size="xs"
						variant={"ghost"}
						colorScheme="red"
						display="flex"
						onClick={() => {
							const { rejectProposedSource } =
								useCellStore.getState();
							rejectProposedSource(cellId as string);
						}}
					>
						{"Reject (" + getShortcutKey() + "+⌫)"}
					</Button>
				</HStack>
			)}
		</>
	);
};

const PythonCell = ({
	index,
	active,
	cell,
	isBeingEdited,
}: PythonCellProps) => {
	const cellRef = useRef<HTMLDivElement>(null);
	const cmRef = useRef<ReactCodeMirrorRef>(null);
	const defaultBorderColor = useColorModeValue(
		"var(--jp-border-color2)",
		"var(--jp-border-color0)",
	);

	return (
		<Box
			ref={cellRef}
			minHeight={`${CELL_MINIMUM_HEIGHT}px`}
			flex="1"
			overflow="auto"
			tabIndex={0}
			width="100%"
			border={
				isBeingEdited
					? `3px solid ${CELL_ACTIVE_COLOR}`
					: `3px solid ${defaultBorderColor}`
			}
		>
			{active && <CellHeaderActions cell={cell} />}
			<InputArea
				index={index}
				active={active}
				cell={cell}
				ref={cmRef}
				isBeingEdited={isBeingEdited}
			/>
		</Box>
	);
};

// Small gutter indicator: amber when the cell is stale (an upstream input
// changed), blue when it was edited since it last ran. Nothing when in sync.
const ReactiveStatusDot = ({
	cellId,
	source,
}: {
	cellId: string;
	source: ICell["source"];
}) => {
	const isStale = useNotebookStore((state) => state.staleCells.has(cellId));
	const lastSrc = useNotebookStore(
		(state) => state.lastExecutedSource[cellId],
	);
	const staleColor = useColorModeValue("orange.500", "orange.300");
	const dirtyColor = useColorModeValue("blue.400", "blue.300");

	const isDirty =
		lastSrc !== undefined && multilineStringToString(source) !== lastSrc;

	if (!isStale && !isDirty) {
		return null;
	}

	const label = isStale
		? "Stale — an upstream cell changed"
		: "Modified since last run";

	return (
		<Tooltip label={label} fontSize="xs" placement="left">
			<Box
				width="8px"
				height="8px"
				borderRadius="full"
				backgroundColor={isStale ? staleColor : dirtyColor}
			/>
		</Tooltip>
	);
};

const CellExecutionContainer = ({
	index,
	active,
	isExecuting,
	queuedForExecution,
	executionCount,
	cellId,
	source,
}: {
	index: number;
	active: boolean;
	isExecuting: boolean;
	queuedForExecution: boolean;
	executionCount?: ExecutionCount;
	cellId: string;
	source: ICell["source"];
}) => {
	const [hasExecuted, setHasExecuted] = useState(false);
	const [isHovering, setIsHovering] = useState(false);
	const [executionTime, setExecutionTime] = useState(0);
	const timerRef = useRef<number | null>(null);
	const hoverRef = useRef<HTMLDivElement>(null);
	const actionColor = useColorModeValue("orange.500", "orange.400");
	const stopColor = useColorModeValue("red.300", "red.400");

	executionCount = executionCount ?? null;

	const clearTimer = () => {
		if (timerRef.current) {
			clearInterval(timerRef.current);
			timerRef.current = null;
		}
	};

	useEffect(() => {
		if (isExecuting) {
			setHasExecuted(true);
			setExecutionTime(0);

			// Start the timer
			const startTime = Date.now();
			timerRef.current = window.setInterval(() => {
				setExecutionTime(Date.now() - startTime);
			}, 100); // Update every 100 milliseconds

			// Cleanup the timer when the component unmounts or when isExecuting changes
			return () => {
				clearTimer();
			};
		} else {
			clearTimer();
		}
	}, [isExecuting]);

	useEffect(() => {
		const checkIfHoveredOutside = (e: MouseEvent) => {
			if (
				hoverRef.current &&
				!hoverRef.current.contains(e.target as Node)
			) {
				setIsHovering(false);
			}
		};

		document.addEventListener("mousemove", checkIfHoveredOutside);

		return () => {
			document.removeEventListener("mousemove", checkIfHoveredOutside);
		};
	}, []);

	const handleRunCell = async () => {
		const { executeCell } = useNotebookStore.getState();
		const cell = useNotebookStore.getState().cells[index];
		await executeCell(cell.id as string);
	};

	let iconElement;
	if (queuedForExecution) {
		iconElement = (
			<CircularProgress
				isIndeterminate
				color={actionColor}
				thickness={"12"}
				size="22px"
				onClick={() => {
					ConnectionManager.getInstance().kernel?.interrupt();
					useNotebookStore.getState().abortMagicQuery();
				}}
			>
				<CircularProgressLabel>
					<StopCircleIcon
						color={stopColor}
						cursor={"pointer"}
						boxSize="18px"
					/>
				</CircularProgressLabel>
			</CircularProgress>
		);
	} else if ((!hasExecuted && active) || isHovering) {
		iconElement = (
			<PlayCircleIcon
				onClick={handleRunCell}
				cursor={"pointer"}
				color={actionColor}
				boxSize="22px"
			/>
		);
	} else {
		iconElement = <Text>[{executionCount}]</Text>;
	}

	return (
		<HStack
			ref={hoverRef}
			fontFamily="monospace"
			width={`${CELL_GUTTER_WIDTH}px`}
			height="100%"
			lineHeight="28.2px"
			justifyContent={"space-between"}
			onMouseEnter={() => setIsHovering(true)}
			onMouseLeave={() => setIsHovering(false)}
		>
			<Flex />
			<VStack width="100%" height="100%" alignItems={"flex-end"} flex={1}>
				<Box height={"22px"}>{iconElement}</Box>

				{hasExecuted && (executionTime / 1000).toFixed(1) !== "0.0" && (
					<Text fontSize="xs">
						{(executionTime / 1000).toFixed(1)}s
					</Text>
				)}

				<ReactiveStatusDot cellId={cellId} source={source} />
			</VStack>
		</HStack>
	);
};

const PythonCellContainer: React.FC<CellContainerProps> = ({
	active,
	cell,
	index,
	queuedForExecution,
	isExecuting,
	isBeingEdited,
}) => {
	const topOfCellRef = useRef<HTMLDivElement>(null);
	const { id, outputs, execution_count } = cell;

	return (
		<VStack
			width="100%"
			gap={0.5}
			height="100%"
			className={active ? "active-cell" : "python-cell"}
		>
			<HStack
				ref={topOfCellRef}
				width="100%"
				height="100%"
				gap={2}
				overflow="auto"
				borderLeft={
					active
						? `3px solid ${CELL_ACTIVE_COLOR}`
						: "3px solid transparent"
				}
				alignItems="flex-start"
				position="relative"
				onClick={() => {
					const { setActiveCell } = useNotebookStore.getState();
					setActiveCell(cell.id as string);
				}}
			>
				<CellExecutionContainer
					index={index}
					active={active}
					isExecuting={isExecuting}
					queuedForExecution={queuedForExecution}
					executionCount={execution_count as ExecutionCount}
					cellId={cell.id as string}
					source={cell.source}
				/>
				<PythonCell
					index={index}
					active={active}
					cell={cell}
					isBeingEdited={isBeingEdited}
				/>
			</HStack>
			{outputs && (
				<OutputArea
					index={index}
					cellId={cell.id as string}
					outputs={outputs as IOutput[]}
				/>
			)}
		</VStack>
	);
};

export default PythonCellContainer;
