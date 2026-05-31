import {
	Box,
	Button,
	CircularProgress,
	CircularProgressLabel,
	HStack,
	Text,
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

const CellExecutionContainer = ({
	index,
	active,
	isExecuting,
	queuedForExecution,
	executionCount,
}: {
	index: number;
	active: boolean;
	isExecuting: boolean;
	queuedForExecution: boolean;
	executionCount?: ExecutionCount;
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

	// The cell is "busy" from the moment it is queued until it finishes, so the
	// timer starts ticking the instant the user hits run (covering queue time
	// during a reactive cascade), not only once it becomes the active cell.
	const isBusy = isExecuting || queuedForExecution;

	useEffect(() => {
		if (!isBusy) {
			clearTimer();
			return;
		}

		setHasExecuted(true);
		setExecutionTime(0);

		// Start the timer, updating every 100ms so it visibly counts up.
		const startTime = Date.now();
		timerRef.current = window.setInterval(() => {
			setExecutionTime(Date.now() - startTime);
		}, 100);

		// Stop and freeze on the final value when the cell finishes.
		return () => {
			clearTimer();
		};
	}, [isBusy]);

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
			lineHeight="28.2px"
			justifyContent={"flex-end"}
			alignItems={"flex-start"}
			gap={1}
			onMouseEnter={() => setIsHovering(true)}
			onMouseLeave={() => setIsHovering(false)}
		>
			{/* Timer sits beside the run icon, not below it, so the gutter
			    never grows taller than a one-line cell and pushes the output
			    away. While busy it counts up live (from 0.0s); afterwards it
			    freezes on the final time, hidden only for instant cells. */}
			{(isBusy ||
				(hasExecuted && (executionTime / 1000).toFixed(1) !== "0.0")) && (
				<Text fontSize="xs" lineHeight="22px">
					{(executionTime / 1000).toFixed(1)}s
				</Text>
			)}
			<Box height={"22px"}>{iconElement}</Box>
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

	// Reactive status, shown as a colored strip on the cell's left edge:
	// amber when stale (an upstream input changed), blue when modified since
	// its last run. The active-cell color always takes precedence.
	const isStale = useNotebookStore((state) =>
		state.staleCells.has(id as string),
	);
	const lastSrc = useNotebookStore(
		(state) => state.lastExecutedSource[id as string],
	);
	const staleColor = useColorModeValue("orange.500", "orange.300");
	const dirtyColor = useColorModeValue("blue.400", "blue.300");

	const isDirty =
		lastSrc !== undefined && multilineStringToString(cell.source) !== lastSrc;

	let edgeColor = "transparent";
	let edgeLabel: string | undefined;
	if (active) {
		edgeColor = CELL_ACTIVE_COLOR;
	} else if (isStale) {
		edgeColor = staleColor;
		edgeLabel = "Stale — an upstream cell changed";
	} else if (isDirty) {
		edgeColor = dirtyColor;
		edgeLabel = "Modified since last run";
	}

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
				borderLeft={`3px solid ${edgeColor}`}
				title={edgeLabel}
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
