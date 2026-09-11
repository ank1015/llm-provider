import type { Metadata } from "./metadata.js";

export interface TextContent {
  readonly type: "text";
  readonly text: string;
  readonly metadata?: Metadata;
}

export type ImageDetail = "auto" | "low" | "high" | "original";

/** A remote image URL. Adapters must still validate URL syntax at runtime. */
export type ImageUrl = `http://${string}` | `https://${string}`;

export interface ImageContent {
  readonly type: "image";
  readonly url: ImageUrl;
  readonly detail?: ImageDetail;
  readonly metadata?: Metadata;
}

/** Content accepted in user messages and tool results. */
export type ContentPart = TextContent | ImageContent;
