import { LlmError } from "@llm-providers/contracts";
import type { Provider } from "@llm-providers/contracts";
import { createOpenAiClient } from "@llm-providers/provider-openai";
import { createChatGptClient } from "@llm-providers/provider-chatgpt";
import { createFireworksClient } from "@llm-providers/provider-fireworks";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { parse } from "../http.js";

export const provider = z.enum(["openai", "chatgpt", "fireworks"]);
const name = z.string().trim().min(1).max(200);
const fields = z.record(z.string(), z.unknown());
const nonemptyFields = fields.refine((value) => Object.keys(value).length > 0);
export const createInput = z.strictObject({
  name, provider, config: fields.default({}), secrets: fields,
  enabled: z.boolean().default(true),
});
export const patchInput = z.strictObject({
  name: name.optional(), enabled: z.boolean().optional(),
  config: nonemptyFields.optional(), secrets: nonemptyFields.optional(),
}).refine((value) => Object.keys(value).length > 0);

const baseConfig = z.strictObject({ baseUrl: z.string().max(2048).optional(), timeoutMs: z.number().optional() });
const openAiSettings = z.strictObject({
  config: baseConfig.extend({ organization: z.string().optional(), project: z.string().optional() }),
  secrets: z.strictObject({ apiKey: z.string() }),
});
const chatGptSettings = z.strictObject({
  config: baseConfig.extend({ accountId: z.string() }),
  secrets: z.strictObject({ accessToken: z.string() }),
});
const fireworksSettings = z.strictObject({
  config: baseConfig,
  secrets: z.strictObject({ apiKey: z.string() }),
});

export type CreateAccountInput = z.infer<typeof createInput>;
export type AccountPatch = z.infer<typeof patchInput>;

/** Shape checks at the gateway; existing clients own configuration semantics. No network calls. */
export function validateSettings(provider: Provider, config: unknown, secrets: unknown) {
  try {
    switch (provider) {
      case "openai": {
        const settings = parse(openAiSettings, { config, secrets });
        createOpenAiClient({ ...settings.config, ...settings.secrets });
        return settings;
      }
      case "chatgpt": {
        const settings = parse(chatGptSettings, { config, secrets });
        createChatGptClient({ ...settings.config, ...settings.secrets });
        return settings;
      }
      case "fireworks": {
        const settings = parse(fireworksSettings, { config, secrets });
        createFireworksClient({ ...settings.config, ...settings.secrets });
        return settings;
      }
    }
  } catch (error) {
    if (error instanceof LlmError && error.kind === "invalid_config") {
      throw new ApiError(400, "invalid_account_config", "Invalid provider configuration or credentials.");
    }
    throw error;
  }
}
