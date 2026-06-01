import {
	Box,
	Button,
	ButtonGroup,
	Divider,
	Flex,
	HStack,
	IconButton,
	Popover,
	PopoverArrow,
	PopoverContent,
	PopoverTrigger,
	Text,
	Tooltip,
	VStack,
} from "@chakra-ui/react";

import { ICell, IUnrecognizedCell } from "@jupyterlab/nbformat";
import { memo, useEffect, useRef, useState } from "react";

import { useRouter } from "next/router";
import { useMemo } from "react";

import ConnectionManager, {
	useConnectionManagerStore,
} from "../../services/connection/connectionManager";

import { default as PythonCellContainer } from "../cell/PythonCell";
import { useNotebookHotkeys } from "./actions/useNotebookHotkeys";
import { MarkdownCell, useNotebookStore } from "./store/NotebookStore";

import { AddIcon } from "@chakra-ui/icons";
import { captureException } from "@sentry/nextjs";
import React from "react";
import { useScrollToBottom } from "../../hooks/useScroll";
import { getCellTypesWithHandlers } from "../../utils/cellOptions";
import { CELL_GUTTER_WIDTH } from "../../utils/constants/constants";
import { initializePosthog, trackEventData } from "../../utils/posthog";
import { isPartiallyInViewport } from "../../utils/utils";
import CellPadding from "../cell/CellPadding";
import MarkdownCellContainer from "../cell/MarkdownCell";
import { enableCommandMode } from "../cell/actions/actions";
import EditableTitle from "../editable/EditableTitle";
import { MagicInput } from "../input/MagicInput";
import Launcher from "../launcher/Launcher";
import Spinner from "../misc/Spinner";
import StatusBar from "../statusbar";
import { triggerCellActionFailureToast } from "../toasts";
import Toolbar from "../toolbar";

export const initializeServerConnection = async () => {
	const isKernelUnknown =
		useConnectionManagerStore.getState().kernelStatus == "unknown";
	if (!isKernelUnknown) {
		return;
	}
	const connectionManager = ConnectionManager.getInstance();

	return connectionManager
		.getServiceManager()
		.then((serviceManager) => serviceManager!.ready)
		.catch((error) => {
			captureException(error);
			console.error(error);
		});
};

const NotebookHeader = () => {
	const { getNotebookName, setNotebookName } = useNotebookStore.getState();
	const fileContents = useNotebookStore((state) => state.fileContents);

	return (
		<>
			{fileContents && (
				<HStack justify={"left"} alignItems="center" width="100%">
					<EditableTitle
						title={getNotebookName()!}
						setTitle={setNotebookName}
					/>
				</HStack>
			)}
		</>
	);
};

export const Notebook = () => {
	const router = useRouter();

	useNotebookHotkeys();
	useNotebookStore.getState().setRouter(router);
	useEffect(() => {
		initializePosthog();
	}, []);

	useEffect(() => {
		const { path, navigateToPath } = useNotebookStore.getState();
		navigateToPath(path);
	}, [router.query.renamed]);

	useEffect(() => {
		const {
			path,
			refreshFiles,
			handleNotebookClick,
			isLoadingNotebook,
			getNotebookPath,
		} = useNotebookStore.getState();

		const routerPath = router.query.path as string | undefined;

		// Return if routerPath is undefined or empty
		if (!routerPath) {
			return;
		}

		// Prevent redundant calls if notebook is already loading or already selected
		const currentNotebookPath = getNotebookPath();
		if (isLoadingNotebook || currentNotebookPath === routerPath) {
			return;
		}

		refreshFiles(path, true).then((files) => {
			// Check if the notebook already exists in the state
			const existingNotebook =
				files && files.find((notebook) => notebook.path === routerPath);

			// Double-check loading state before calling handleNotebookClick to avoid race conditions
			const { isLoadingNotebook: stillLoading } =
				useNotebookStore.getState();
			if (existingNotebook && !stillLoading) {
				handleNotebookClick(existingNotebook);
			} else if (!existingNotebook) {
				// Refresh notebooks only if the notebook isn't found
				console.error("Could not find notebook to select");
			}
		});
	}, [router.query.path]);

	return <MainPanel />;
};

export const MainPanel = () => {
	const mainPanelRef = useRef<HTMLDivElement>(null);
	const isLoadingNotebook = useNotebookStore(
		(state) => state.isLoadingNotebook,
	);
	const activeCellIndex = useNotebookStore((state) => state.activeCellIndex);
	const fileContents = useNotebookStore((state) => state.fileContents);
	const cells = useNotebookStore((state) => state.cells);

	useEffect(() => {
		if (isLoadingNotebook) return;
		// Scroll to top
		mainPanelRef.current?.scrollTo({
			top: 0,
		});
		enableCommandMode();
	}, [isLoadingNotebook]);

	useEffect(() => {
		const activeCell = document.querySelector(".active-cell");
		if (activeCell && mainPanelRef.current) {
			const cellEditor = activeCell.querySelector(".cell-editor");
			if (!isPartiallyInViewport(cellEditor)) {
				const offset = 100;
				const elementTop = activeCell.getBoundingClientRect().top;
				const containerScrollTop = mainPanelRef.current.scrollTop;
				const containerTop =
					mainPanelRef.current.getBoundingClientRect().top;
				const relativeTop =
					elementTop + containerScrollTop - containerTop;
				const offsetPosition = relativeTop - offset;

				mainPanelRef.current.scrollTo({
					top: offsetPosition,
				});
			}
		}
	}, [activeCellIndex]);

	if (isLoadingNotebook) {
		return (
			<Box
				ref={mainPanelRef}
				flexGrow={1}
				display="flex"
				flexDirection="column"
				justifyContent={"center"}
				alignItems={"center"}
				height="100%"
				overflowY="auto"
				minWidth="0"
			>
				<Spinner size="xl" isSpinning={true} color="orange.500" />
			</Box>
		);
	}

	if (!fileContents) {
		return (
			<VStack height="100%" width="100%">
				<Launcher />
			</VStack>
		);
	}

	return (
		<VStack
			gap={0}
			height="100%"
			width="100%"
			position="relative"
			overflow={"hidden"}
		>
			<Toolbar mainPanelRef={mainPanelRef} />
			<Box
				ref={mainPanelRef}
				flexGrow={1}
				display="flex"
				flexDirection="column"
				justifyContent={"center"}
				alignItems={"center"}
				width="100%"
				height="100%"
				overflowY="auto"
				minWidth="0"
				position={"relative"}
				pt="64px"
			>
				<Box
					position={"relative"}
					height="100%"
					gap="20px"
					maxWidth="1200px"
					width="80%"
					mx="auto"
				>
					<NotebookHeader />
					<Cells />
				</Box>
			</Box>
			<MainPanelInputs mainPanelRef={mainPanelRef} />
			<StatusBar />
		</VStack>
	);
};

const MainPanelInputs = ({
	mainPanelRef,
}: {
	mainPanelRef: React.RefObject<HTMLDivElement>;
}) => {
	return (
		<VStack
			position={"absolute"}
			bottom={0}
			zIndex={10}
			width="80%"
			maxWidth="1200px"
		>
			<HStack gap={[0, 3]} position="relative" width="100%">
				<VStack gap={0} width="100%">
					<VStack width="100%" gap="2" pb="40px" position="relative">
						<MagicInput refToTrack={mainPanelRef} />
					</VStack>
				</VStack>
			</HStack>
		</VStack>
	);
};

const CellAdder = ({
	handlePythonClick,
	handleMarkdownClick,
}: {
	handlePythonClick: () => void;
	handleMarkdownClick: () => void;
}) => {
	const buttonOptions = getCellTypesWithHandlers({
		code: handlePythonClick,
		markdown: handleMarkdownClick,
	});

	return (
		<Box>
			<ButtonGroup isAttached fontFamily={"Space Grotesk"}>
				{buttonOptions.map(({ icon, label, handler }) => (
					<Button
						key={`add-cell-button-${label}`}
						size="md"
						variant="outline"
						backgroundColor="var(--chakra-colors-chakra-body-bg)"
						leftIcon={icon}
						onClick={() => {
							const { isGeneratingCells } =
								useNotebookStore.getState();
							if (isGeneratingCells) {
								triggerCellActionFailureToast("addition");
								return;
							}
							handler();
						}}
					>
						<Text fontSize="smaller">{label}</Text>
					</Button>
				))}
			</ButtonGroup>
		</Box>
	);
};

const CellDivider = memo(({ index }: { index: number }) => {
	const [isPopoverOpen, setIsPopoverOpen] = useState(false);

	const openPopover = () => {
		setIsPopoverOpen(true);
	};

	const closePopover = () => {
		setIsPopoverOpen(false);
	};

	// Function to handle adding a Python cell
	const addPythonCell = () => {
		const { addCellAtIndex } = useNotebookStore.getState();
		addCellAtIndex(index, "", "code");
		trackEventData("[CellDivider] Add Python cell");
	};

	// Function to handle adding a Markdown cell
	const addMarkdownCell = () => {
		const { addCellAtIndex } = useNotebookStore.getState();
		addCellAtIndex(index, "", "markdown");
		trackEventData("[CellDivider] Add markdown cell");
	};

	return (
		<Popover isOpen={isPopoverOpen} onClose={closePopover}>
			<PopoverTrigger>
				<HStack
					width="100%"
					align="center"
					cursor={"pointer"}
					gap={2}
					opacity={isPopoverOpen ? 1 : 0}
					_hover={{ opacity: 1 }}
					position="relative"
					height="20px"
					alignItems={"center"}
					onClick={() => {
						openPopover();
						trackEventData("[CellDivider] Popover opened");
					}}
				>
					<Flex
						width={`${CELL_GUTTER_WIDTH}px`}
						justifyContent={"flex-end"}
						alignItems={"center"}
					>
						<Tooltip
							label="Click to add a new block"
							fontSize="12px"
						>
							<IconButton
								aria-label="Add new cell"
								minWidth="0"
								color="#5B768F"
								width="18px"
								height="18px"
								fontSize="10px"
								variant={"ghost"}
								icon={<AddIcon />}
							/>
						</Tooltip>
					</Flex>
					<Divider flex={1} />
				</HStack>
			</PopoverTrigger>
			<PopoverContent
				width="fit-content"
				outline="none"
				boxShadow={"none"}
			>
				<PopoverArrow backgroundColor="var(--chakra-colors-chakra-body-bg)" />
				<CellAdder
					handlePythonClick={addPythonCell}
					handleMarkdownClick={addMarkdownCell}
				/>
			</PopoverContent>
		</Popover>
	);
});
CellDivider.displayName = "CellDivider";

const Cells = () => {
	const cells = useNotebookStore((state) => state.cells);
	const activeCellIndex = useNotebookStore((state) => state.activeCellIndex);
	const executingCells = useNotebookStore((state) => state.executingCells);
	const notebookMode = useNotebookStore((state) => state.notebookMode);
	const currentExecutingCell = useNotebookStore(
		(state) => state.currentExecutingCell,
	);

	return (
		<VStack gap={2} pt={8} pb={"56"} width="100%">
			{cells.map((cell, i) => {
				const cellId = cell.id as string;
				const active = i == activeCellIndex;

				return (
					<Cell
						key={cell.id as string}
						cell={cell}
						isLastCell={i === cells.length - 1}
						index={i}
						active={active}
						isExecuting={cellId == currentExecutingCell}
						queuedForExecution={executingCells.has(cellId)}
						isBeingEdited={notebookMode === "edit" && active}
					/>
				);
			})}
			<HStack>
				<CellPadding />
				<CellAdder
					handlePythonClick={() => {
						const { addCell } = useNotebookStore.getState();
						addCell("", "code");
					}}
					handleMarkdownClick={() => {
						const { addCell } = useNotebookStore.getState();
						addCell("", "markdown");
					}}
				/>
			</HStack>
		</VStack>
	);
};

const Cell = React.memo(function ({
	cell,
	index,
	active,
	isExecuting,
	queuedForExecution,
	isBeingEdited,
	isLastCell,
}: {
	cell: ICell | MarkdownCell | IUnrecognizedCell;
	index: number;
	active: boolean;
	isExecuting: boolean;
	queuedForExecution: boolean;
	isBeingEdited: boolean;
	isLastCell: boolean;
}) {
	const cellRef = useRef<HTMLDivElement>(null);
	const renderCell = useMemo(() => {
		if (cell.cell_type === "code") {
			return (
				<>
					<PythonCellContainer
						active={active}
						cell={cell}
						index={index}
						isExecuting={isExecuting}
						queuedForExecution={queuedForExecution}
						isBeingEdited={isBeingEdited}
					/>
				</>
			);
		} else if (cell.cell_type === "markdown") {
			return (
				<>
					<MarkdownCellContainer
						active={active}
						cell={cell as MarkdownCell}
						index={index}
						isBeingEdited={isBeingEdited}
					/>
				</>
			);
		}
	}, [cell, index, active, isExecuting, isBeingEdited, cellRef]);

	return (
		<Box
			ref={cellRef}
			width="100%"
			position="relative"
			key={`container-${cell.id as string}`}
		>
			{renderCell}
		</Box>
	);
});

Cell.displayName = "ExecutableCell";

export default Notebook;
