import type { AssistantMessage } from "./messages.js";
import type { Provider } from "./models.js";
import type { StopReason } from "./stop-reason.js";
import type { Usage } from "./usage.js";

export interface AssistantResponse<P extends Provider = Provider> {
  readonly id: string;
  /** Model ID selected from our catalog. */
  readonly modelId: string;
  /** Provider-reported model identifier, when different from the selected ID. */
  readonly resolvedModelId?: string;
  readonly message: AssistantMessage<P>;
  readonly stopReason: StopReason;
  readonly usage?: Usage;
  readonly durationMs: number;
  /** Unix timestamp in milliseconds. */
  readonly timestamp: number;
}
