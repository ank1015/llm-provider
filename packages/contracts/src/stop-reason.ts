export type StopReason =
  /** Generation ended normally, including a configured stop sequence. */
  | "stop"
  /** Generation was cut short by a token or length limit. */
  | "length"
  /** The assistant yielded tool calls for the caller to execute. */
  | "tool_use"
  /** The assistant explicitly declined to fulfill the request. */
  | "refusal"
  /** A provider content filter interrupted or blocked generation. */
  | "content_filter"
  /** The provider paused a turn that can be continued; distinct from tool use. */
  | "pause_turn";
