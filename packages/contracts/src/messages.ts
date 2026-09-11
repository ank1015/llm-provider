import type { ContentPart, TextContent } from "./content.js";
import type { Metadata } from "./metadata.js";
import type { Provider } from "./models.js";

export interface MessageBase {
  readonly id?: string;
  /** Unix timestamp in milliseconds. */
  readonly timestamp?: number;
  readonly metadata?: Metadata;
}

export interface UserMessage extends MessageBase {
  readonly role: "user";
  readonly content: readonly ContentPart[];
}

export interface SystemMessage extends MessageBase {
  readonly role: "system";
  readonly content: readonly TextContent[];
}

/** Native provider output for replay; response-level statistics belong elsewhere. */
export interface AssistantMessage<P extends Provider = Provider> extends MessageBase {
  readonly role: "assistant";
  readonly provider: P;
  readonly content: readonly unknown[];
}

export interface ToolResultError {
  readonly message: string;
  readonly name?: string;
}

export type ToolResultOutcome =
  | { readonly status: "success" }
  | { readonly status: "error"; readonly error: ToolResultError };

export interface ToolResultMessage extends MessageBase {
  readonly role: "tool_result";
  readonly toolName: string;
  readonly toolCallId: string;
  readonly content: readonly ContentPart[];
  readonly outcome: ToolResultOutcome;
  /** Application-owned details separate from model-visible content. */
  readonly details?: unknown;
}

export interface CustomMessage extends MessageBase {
  readonly role: "custom";
  /** Identifies how a consumer should interpret the data. */
  readonly tag: string;
  /** Arbitrary payload; its shape is determined by the tag and consumer. */
  readonly data: unknown;
}

export type Message =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | SystemMessage
  | CustomMessage;
