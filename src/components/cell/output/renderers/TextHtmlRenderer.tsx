import { Box, Text, VStack } from "@chakra-ui/react";
import React, { useEffect, useRef, useState } from "react";
import { DataTable, TableData } from "../../../datatable/DataTable";
import { transformRowsAndColumnsToData } from "../../../file/utils";
import CrazyTable from "../../../modals/file-view/CrazyTable";

const ScriptExecutor = ({
	scriptContent,
	scriptSrc,
}: {
	scriptContent?: string | null;
	scriptSrc?: string;
}) => {
	useEffect(() => {
		const script = document.createElement("script");
		script.type = "text/javascript";

		if (scriptSrc) {
			// For an external script, set the src attribute
			script.src = scriptSrc;
		} else if (scriptContent) {
			// For inline script, use textContent
			script.textContent = scriptContent;
		}

		document.body.appendChild(script);

		return () => {
			// Cleanup: remove the script when the component unmounts
			if (document.body.contains(script)) {
				document.body.removeChild(script);
			}
		};
	}, [scriptContent, scriptSrc]); // Dependencies array, re-run effect if these props change

	return null; // This component does not render anything
};

const TextHtmlRenderer = ({
	htmlContent,
	style,
	preserveWhitespace = false,
}: {
	htmlContent: string;
	style?: React.CSSProperties;
	// Real HTML (plotly, tables, …) collapses whitespace normally; preserving
	// it renders the source's indentation/newlines as visible blank space.
	// Only escaped plain-text output should keep its whitespace.
	preserveWhitespace?: boolean;
}) => {
	const textHtmlRef = useRef<HTMLDivElement>(null);
	const [contentSections, setContentSections] = useState<React.ReactNode[]>(
		[],
	);

	// Function to remove or trim adjacent whitespace nodes
	function cleanSurroundingWhitespace(targetNode: Node) {
		// Check previous sibling
		let prevSibling = targetNode.previousSibling;
		if (
			prevSibling &&
			prevSibling.nodeType === Node.TEXT_NODE &&
			/^\s*$/.test(prevSibling.textContent || "")
		) {
			prevSibling.remove();
		}

		// Check next sibling
		let nextSibling = targetNode.nextSibling;
		if (
			nextSibling &&
			nextSibling.nodeType === Node.TEXT_NODE &&
			/^\s*$/.test(nextSibling.textContent || "")
		) {
			nextSibling.remove();
		}
	}

	function processNode(
		node: Node,
		sections: React.ReactNode[],
		head = false,
	) {
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const element = node as Element;

		if (element.nodeName.toLowerCase() === "table") {
			// Check for a caption in the table
			const captionElement = element.querySelector("caption");
			const captionText = captionElement
				? captionElement.textContent
				: "";

			// Determine if the table has a <thead> section
			const firstRow = element.querySelector("tr:first-child");

			const theadElement = element.querySelector("thead");

			// There can be many header rows in the `thead`, our datatable only supports single headers so we skip the rest and show them as regular rows
			const firstRowInHeader =
				theadElement?.querySelector("tr:first-child");
			let headers = Array.from(
				firstRowInHeader?.querySelectorAll("th") ?? [],
			).map((th) => th.textContent ?? "");
			// Table meets the requirements, process as DataTable
			const rows = Array.from(
				element.querySelectorAll(
					"tbody tr, table tr:not(:first-child)",
				),
			)
				.map((tr) => {
					// Include both <th> and <td> elements in the row data
					const rowCells = Array.from(
						tr.querySelectorAll("th, td"),
					).map((td) => td.textContent ?? "");
					return rowCells;
				})
				.filter(
					(row, index) =>
						(!theadElement && firstRow && index == 0) ||
						row.some((cellContent) => cellContent.trim() !== ""),
				); // Skip empty rows

			const oldTableData: TableData = {
				columns: headers,
				rows,
				caption: captionText,
			};

			const tableData = transformRowsAndColumnsToData({
				rows,
				columns: headers,
			});

			sections.push(
				<Box my={1} key={sections.length}>
					{headers && headers.length > 0 ? (
						<VStack alignItems={"flex-start"} gap={0}>
							<CrazyTable
								columns={headers}
								data={tableData}
								key={sections.length}
							/>
						</VStack>
					) : (
						<DataTable data={oldTableData} />
					)}
					{captionText && (
						<Text mt={2} textAlign={"center"}>
							{captionText}
						</Text>
					)}
				</Box>,
			);

			// Remove the processed table from the DOM to avoid re-rendering
			try {
				if (!head) {
					// Clean surrounding whitespace before removing the element
					cleanSurroundingWhitespace(element);
					element.remove();
				}
			} catch {}
		} else if (element.nodeName.toLowerCase() === "script") {
			// Execute script content within the container
			const scriptElement = element as HTMLScriptElement;
			sections.push(
				<ScriptExecutor
					key={sections.length}
					scriptContent={scriptElement.textContent}
					scriptSrc={scriptElement.src}
				/>,
			);

			try {
				if (!head) {
					// Clean surrounding whitespace before removing the element
					cleanSurroundingWhitespace(element);
					scriptElement.remove();
				}
			} catch {}
		} else {
			// Recursively process child nodes
			Array.from(element.childNodes).forEach((child) => {
				processNode(child, sections);
			});
		}
	}

	useEffect(() => {
		const element = textHtmlRef.current;
		if (element) {
			const parser = new DOMParser();
			const doc = parser.parseFromString(htmlContent, "text/html");

			const sections: React.ReactNode[] = [];
			processNode(doc.documentElement, sections);

			// Clean up processed HTML
			if (doc.documentElement) {
				sections.push(
					<div
						style={{
							whiteSpace: preserveWhitespace
								? "pre-wrap"
								: "normal",
							fontSize: "14px",
						}}
						dangerouslySetInnerHTML={{
							__html: doc.documentElement.innerHTML,
						}}
						key={sections.length}
					/>,
				);
			}

			setContentSections(sections);
		}

		// Clean up
		return () => {
			if (element) {
				element.innerHTML = "";
			}
		};
	}, [htmlContent, preserveWhitespace]);

	return (
		<div ref={textHtmlRef} style={{ width: "100%", ...style }}>
			{contentSections.map((section, index) => (
				<React.Fragment key={index}>{section}</React.Fragment>
			))}
		</div>
	);
};

export default TextHtmlRenderer;
