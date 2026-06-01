import {
	Box,
	HStack,
	IconButton,
	Tooltip,
	VStack,
	useColorModeValue,
} from "@chakra-ui/react";
import React, {
	JSXElementConstructor,
	ReactElement,
	ReactNode,
	useEffect,
} from "react";
import { useRouter } from "next/router";
import {
	DiscordIcon,
	FolderIcon,
	GithubIcon,
	HomeIcon,
	SettingsIcon,
} from "../../assets/icons";
import { useNotebookStore } from "../notebook/store/NotebookStore";
import { useResizeWidth } from "../../hooks/useResizeWidth";
import {
	FILESYSTEM_PANEL_ID,
	SETTINGS_PANEL_ID,
	TERMINAL_PANEL_ID,
} from "../../utils/constants/constants";
import FileSystemContent from "./panels/FileSystemContent/FileSystemContent";
import SettingsContent from "./panels/SettingsContent";
import TerminalContent from "./panels/TerminalContent";
import {
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	useSidebarStore,
} from "./store/SidebarStore";

type SidebarIconProps = {
	icon: ReactElement<any, string | JSXElementConstructor<any>> | undefined;
	isSelected?: boolean;
	label: string;
	title?: string;
	onClick?: () => void;
};

const SidebarTooltip: React.FC<{ label: string; children: ReactNode }> = ({
	label,
	children,
}) => {
	return (
		<Tooltip borderRadius={"md"} placement="right" label={label}>
			{children}
		</Tooltip>
	);
};
export const SidebarIcon = React.forwardRef(
	(
		{ icon, onClick, isSelected = false, label = "" }: SidebarIconProps,
		ref: React.Ref<HTMLButtonElement>,
	) => {
		const color = isSelected
			? "orange.500"
			: "var(--chakra-colors-chakra-body-text)";
		const selectedBgColor = useColorModeValue("gray.50", "");
		return (
			<SidebarTooltip label={label}>
				<IconButton
					icon={icon}
					fill={color}
					color={color}
					width="36px"
					height="36px"
					aria-label={label}
					size="sm"
					backgroundColor={isSelected ? selectedBgColor : "unset"}
					variant={isSelected ? "solid" : "ghost"}
					onClick={onClick}
				/>
			</SidebarTooltip>
		);
	},
);

interface SidebarPanelProps {
	panelType: string;
	handleCloseSidebar: () => void;
}

const SidebarPanel: React.FC<SidebarPanelProps> = ({
	panelType,
	handleCloseSidebar,
}) => {
	if (panelType === FILESYSTEM_PANEL_ID) {
		return <FileSystemContent handleCloseSidebar={handleCloseSidebar} />;
	} else if (panelType === SETTINGS_PANEL_ID) {
		return <SettingsContent handleCloseSidebar={handleCloseSidebar} />;
	} else if (panelType === TERMINAL_PANEL_ID) {
		return <TerminalContent handleCloseSidebar={handleCloseSidebar} />;
	} else {
		return null;
	}
};

export default function Sidebar() {
	const router = useRouter();
	const bgColor = useColorModeValue(
		"var(--jp-layout-color2)",
		"var(--jp-layout-color1)",
	);
	const panelType =
		useSidebarStore((state) => state.panelType) ?? FILESYSTEM_PANEL_ID;
	const isExpanded = useSidebarStore((state) => state.isExpanded);
	const sidebarWidth = useSidebarStore((state) => state.sidebarWidth);
	const setSidebarWidth = useSidebarStore((state) => state.setSidebarWidth);
	const handleMouseDown = useResizeWidth(
		sidebarWidth,
		setSidebarWidth,
		MIN_SIDEBAR_WIDTH,
		MAX_SIDEBAR_WIDTH,
	);

	const { setPanelType, setIsExpanded } = useSidebarStore.getState();

	const handleHomeClick = () => {
		// Clear file contents to show launcher
		useNotebookStore.getState().setFileContents(undefined);
		// Remove path from query to go to home
		const { path, ...remainingQueries } = router.query;
		router.push({
			pathname: router.pathname,
			query: remainingQueries,
		});
		// Close sidebar if open
		if (isExpanded) {
			setIsExpanded(false);
			setPanelType("");
		}
	};

	useEffect(() => {
		useSidebarStore.getState().initializeSidebar();
	}, []);

	const handleSidebarIconClick = (type: string) => {
		// If this panel is already open, close the sidebar.
		if (isExpanded && panelType === type) {
			setIsExpanded(false);
			setPanelType("");
			return;
		}

		setIsExpanded(true);
		setPanelType(type);
	};

	const handleCloseSidebar = () => {
		setIsExpanded(false);
	};

	return (
		<HStack gap={0} height="100%">
			<Box
				width="48px"
				position="relative"
				outline="none"
				bg={bgColor}
				height="100%"
				p="2"
				fontFamily={"Space Grotesk"}
			>
				<VStack justifyContent={"space-between"} height="100%">
					<VStack spacing={2} align="center">
						<SidebarIcon
							icon={<HomeIcon />}
							onClick={handleHomeClick}
							label="Home"
						/>
						<SidebarIcon
							icon={<FolderIcon />}
							isSelected={
								isExpanded && panelType === FILESYSTEM_PANEL_ID
							}
							onClick={() =>
								handleSidebarIconClick(FILESYSTEM_PANEL_ID)
							}
							label="Files"
						/>
					</VStack>
					<VStack>
						<SidebarIcon
							icon={<DiscordIcon boxSize="18px" />}
							label={"Join the Discord"}
							onClick={() =>
								window.open(
									"https://discord.gg/ZuHq9hDs2y",
									"_blank",
								)
							}
						/>
						<SidebarIcon
							icon={<GithubIcon boxSize="18px" />}
							label={"Raise an issue on GitHub"}
							onClick={() =>
								window.open(
									"https://github.com/alishobeiri/thread/issues",
									"_blank",
								)
							}
						/>
						<SidebarIcon
							icon={<SettingsIcon />}
							isSelected={
								isExpanded && panelType === SETTINGS_PANEL_ID
							}
							label={"Settings"}
							onClick={() =>
								handleSidebarIconClick(SETTINGS_PANEL_ID)
							}
						/>
					</VStack>
				</VStack>
			</Box>
			{isExpanded && (
				<Box position={"relative"} display={"flex"} height="100%">
					<Box width={`${sidebarWidth}px`} height="100%">
						<SidebarPanel
							panelType={panelType}
							handleCloseSidebar={handleCloseSidebar}
						/>
						<Box
							onMouseDown={handleMouseDown}
							width="3px"
							_light={{
								bg: "blackAlpha.200",
								_hover: {
									bg: "blackAlpha.300",
								},
							}}
							_dark={{
								bg: "whiteAlpha.300",
								_hover: {
									bg: "whiteAlpha.400",
								},
							}}
							height="100%"
							position="absolute"
							right="0"
							top="0"
							cursor="col-resize"
							zIndex="10"
						/>
					</Box>
				</Box>
			)}
		</HStack>
	);
}
