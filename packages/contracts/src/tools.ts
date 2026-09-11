/** JSON Schema object describing a tool's input or output. */
export type ToolSchema = Readonly<Record<string, unknown>>;

export interface FunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolSchema;
  /** Optional output schema for application-owned tool consumers. */
  readonly outputSchema?: ToolSchema;
  readonly strict?: boolean;
}

export type GrammarSyntax = "lark";

export interface CustomToolFormat {
  readonly syntax: GrammarSyntax;
  readonly definition: string;
}

export interface CustomTool {
  readonly type: "custom";
  readonly name: string;
  readonly description: string;
  readonly format: CustomToolFormat;
}

export type ToolDefinition = FunctionTool | CustomTool;
