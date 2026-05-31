import { IDisplayData, IExecuteResult } from "@jupyterlab/nbformat";
import { escape } from "lodash";
import { InlineMath } from "react-katex";
import { multilineStringToString } from "../../../utils/utils";
import {
	APPLICATION_JAVASCRIPT,
	APP_JS_MIME_TYPE,
	GIF_MIME_TYPE,
	IMG_APNG,
	IMG_AVIF,
	IMG_GIF,
	IMG_JPEG,
	IMG_PNG,
	IMG_PNG_IMG_SVG,
	IMG_PNG_IMG_SVG_TEXT_PLAIN,
	IMG_SVG,
	IMG_SVG_TEXT_PLAIN,
	IMG_WEBP,
	IPYWIDGET_STATE_MIMETYPE,
	IPYWIDGET_VIEW_MIMETYPE,
	LATEX,
	LATEX_DISP_MIME_TYPE,
	PNG_JPG_MIME_TYPE,
	PNG_MIME_TYPE,
	TEXT_HTML,
	TEXT_HTML_TEXT_PLAIN_MIME_TYPE,
	TEXT_PLAIN,
} from "./mimeTypes";
import IPyWidgetsRenderer from "./renderers/IPyWidgetsRenderer";
import ImageRenderer from "./renderers/ImageRenderer";
import TextHtmlRenderer from "./renderers/TextHtmlRenderer";

export const mimeRenderer = (
	outputIndex: number,
	cellId: string,
	mimeKey: string,
	output: IDisplayData | IExecuteResult,
) => {
	const data = output.data;

	// if contains both the iwidget view and the ipywidget state then return the widget renderer:
	if (IPYWIDGET_VIEW_MIMETYPE in data && IPYWIDGET_STATE_MIMETYPE in data) {
		return <IPyWidgetsRenderer key={outputIndex} data={data} />;
	}

	switch (mimeKey) {
		case PNG_MIME_TYPE:
		case PNG_JPG_MIME_TYPE:
		case GIF_MIME_TYPE:
		case IMG_APNG:
		case IMG_AVIF:
		case IMG_GIF:
		case IMG_WEBP:
		case IMG_PNG:
		case IMG_JPEG:
			return <ImageRenderer key={outputIndex} data={output.data} />;
		case IMG_PNG_IMG_SVG:
		case IMG_SVG_TEXT_PLAIN:
		case IMG_PNG_IMG_SVG_TEXT_PLAIN:
			// SVG is a special type of image
			return (
				<TextHtmlRenderer
					key={outputIndex}
					htmlContent={data[IMG_SVG] as string}
				/>
			);
		case APP_JS_MIME_TYPE:
			return (
				<TextHtmlRenderer
					key={outputIndex}
					htmlContent={`<script>${data[APPLICATION_JAVASCRIPT]}</script>`}
				/>
			);
		case LATEX_DISP_MIME_TYPE:
			const latexString = data[LATEX] as string;
			const cleanedLatexString = latexString.replace(/\$/g, "");
			return <InlineMath key={outputIndex} math={cleanedLatexString} />;
		case TEXT_HTML:
		case TEXT_PLAIN:
		case TEXT_HTML_TEXT_PLAIN_MIME_TYPE:
		default:
			// Render everything we haven't special cased as HTML or plain text if it's possible
			if (TEXT_HTML in data) {
				return (
					<TextHtmlRenderer
						key={outputIndex}
						htmlContent={multilineStringToString(
							data[TEXT_HTML] as string,
						)}
					/>
				);
			} else if (TEXT_PLAIN in data) {
				return (
					<TextHtmlRenderer
						key={outputIndex}
						preserveWhitespace
						htmlContent={escape(
							multilineStringToString(data[TEXT_PLAIN] as string),
						)}
					/>
				);
			}
		// It is something we haven't seen before and it isn't HTML; we don't try to render it and skip completely
	}
};
