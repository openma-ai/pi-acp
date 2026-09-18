/**
 * ACP prompt content → pi prompt text + image attachments (pure).
 *
 * pi accepts a text prompt plus `ImageContent[]`. Text, resource links, and
 * embedded text resources fold into the prompt text in wire order; images are
 * attached alongside. Binary resources and audio are refused explicitly so
 * context is never dropped silently.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";

export interface ConvertedPrompt {
  /** Prompt text for pi (`session.prompt`). */
  text: string;
  /** Image attachments in pi's `ImageContent` shape. */
  images: ImageContent[];
  /** Human-readable text (slash-command parsing, titles). */
  displayText: string;
}

export class UnsupportedPromptContentError extends Error {
  constructor(public readonly contentType: string) {
    super(`unsupported prompt content type: ${contentType}`);
    this.name = "UnsupportedPromptContentError";
  }
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function canonicalImageMimeType(mimeType: string): string | undefined {
  const lower = mimeType.trim().toLowerCase();
  const mapped = lower === "image/jpg" ? "image/jpeg" : lower;
  return IMAGE_MIME_TYPES.has(mapped) ? mapped : undefined;
}

/** `file://` URIs become plain paths; other URIs pass through. */
export function resourcePath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri.slice("file://".length);
    }
  }
  return uri;
}

function contextBlock(uri: string, text: string): string {
  return `<context ref=${JSON.stringify(resourcePath(uri))}>\n${text}\n</context>`;
}

export interface ConvertPromptOptions {
  /** Whether images may be attached (model input capability). Default true. */
  images?: boolean;
}

export function convertPrompt(blocks: ContentBlock[], options: ConvertPromptOptions = {}): ConvertedPrompt {
  const parts: string[] = [];
  const display: string[] = [];
  const images: ImageContent[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        display.push(block.text);
        break;
      case "resource_link": {
        const path = resourcePath(block.uri);
        parts.push(`\n[resource_link name=${JSON.stringify(block.name)} path=${JSON.stringify(path)}]\n`);
        display.push(`@${block.name}`);
        break;
      }
      case "resource": {
        const resource = block.resource;
        if ("text" in resource && typeof resource.text === "string") {
          parts.push(`\n${contextBlock(resource.uri, resource.text)}\n`);
          display.push(`@${resourcePath(resource.uri)}`);
          break;
        }
        throw new UnsupportedPromptContentError("resource (binary)");
      }
      case "image": {
        if (options.images === false) throw new UnsupportedPromptContentError("image");
        const mimeType = canonicalImageMimeType(block.mimeType);
        if (mimeType === undefined) {
          throw new UnsupportedPromptContentError(`image (${block.mimeType})`);
        }
        if (block.data.length === 0) throw new UnsupportedPromptContentError("image (empty)");
        images.push({ type: "image", data: block.data, mimeType });
        display.push("[image]");
        break;
      }
      case "audio":
        throw new UnsupportedPromptContentError("audio");
      default:
        throw new UnsupportedPromptContentError(String((block as { type?: unknown }).type));
    }
  }

  return {
    text: parts.join(""),
    images,
    displayText: display.join(" ").trim(),
  };
}
