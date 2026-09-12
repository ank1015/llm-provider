import type { Message, ToolDefinition } from "@llm-providers/contracts";
import { z } from "zod";
import { provider } from "../accounts/validation.js";
import { pageQuery } from "../pagination.js";

const fields = z.record(z.string(), z.unknown());
const base = { id: z.string().optional(), timestamp: z.number().optional(), metadata: fields.optional() };
const text = z.strictObject({ type: z.literal("text"), text: z.string(), metadata: fields.optional() });
const image = z.strictObject({
  type: z.literal("image"), url: z.templateLiteral([z.enum(["http://", "https://"]), z.string()]),
  detail: z.enum(["auto", "low", "high", "original"]).optional(), metadata: fields.optional(),
});
const content = z.array(z.discriminatedUnion("type", [text, image]));
const message: z.ZodType<Message> = z.discriminatedUnion("role", [
  z.strictObject({ ...base, role: z.literal("user"), content }),
  z.strictObject({ ...base, role: z.literal("system"), content: z.array(text) }),
  z.strictObject({ ...base, role: z.literal("assistant"), provider, content: z.array(z.unknown()) }),
  z.strictObject({
    ...base, role: z.literal("tool_result"), toolName: z.string(), toolCallId: z.string(), content,
    outcome: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("success") }),
      z.strictObject({ status: z.literal("error"), error: z.strictObject({ message: z.string(), name: z.string().optional() }) }),
    ]), details: z.unknown().optional(),
  }),
  z.strictObject({ ...base, role: z.literal("custom"), tag: z.string(), data: z.unknown() }),
]);
const tool: z.ZodType<ToolDefinition> = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("function"), name: z.string(), description: z.string(),
    parameters: fields, outputSchema: fields.optional(), strict: z.boolean().optional() }),
  z.strictObject({ type: z.literal("custom"), name: z.string(), description: z.string(),
    format: z.strictObject({ syntax: z.literal("lark"), definition: z.string() }) }),
]);

const idempotencyKey = z.string().min(1).max(200).regex(/^\S+$/);
export const submission = z.union([
  z.strictObject({
    idempotencyKey, previousJobId: z.null().optional().default(null),
    accountId: z.uuid(), modelId: z.string().min(1).max(300),
    instructions: z.string().optional(), messages: z.array(message),
    tools: z.array(tool).default([]), providerOptions: fields.default({}),
  }),
  z.strictObject({ idempotencyKey, previousJobId: z.uuid(), messages: z.array(message) }),
]);
export type Submission = z.infer<typeof submission>;
export const status = z.enum(["queued", "running", "retry_wait", "succeeded", "failed", "cancelled"]);
export const listQuery = pageQuery.extend({
  accountId: z.uuid().optional(), provider: provider.optional(), modelId: z.string().max(300).optional(),
  status: status.optional(), from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  idempotencyKey: idempotencyKey.optional(),
}).refine((input) => !input.from || !input.to || Date.parse(input.from) <= Date.parse(input.to));
