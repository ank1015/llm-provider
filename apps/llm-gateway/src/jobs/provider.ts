import type { AssistantResponse, Provider } from "@llm-providers/contracts";
import { createOpenAiClient, DEFAULT_OPENAI_BASE_URL, type OpenAiClientOptions, type OpenAiRequestInput } from "@llm-providers/provider-openai";
import { createChatGptClient, DEFAULT_CHATGPT_BASE_URL, type ChatGptClientOptions, type ChatGptRequestInput } from "@llm-providers/provider-chatgpt";
import { createFireworksClient, DEFAULT_FIREWORKS_BASE_URL, type FireworksClientOptions, type FireworksRequestInput } from "@llm-providers/provider-fireworks";
import type { providerAccounts, StoredRequest } from "../db/schema.js";
import { decryptSecret } from "../crypto.js";
import { ApiError } from "../errors.js";
import { getModels } from "../catalogs/service.js";

const baseUrls = { openai: DEFAULT_OPENAI_BASE_URL, chatgpt: DEFAULT_CHATGPT_BASE_URL, fireworks: DEFAULT_FIREWORKS_BASE_URL };
export type Account = typeof providerAccounts.$inferSelect;

export function validateModel(provider: Provider, modelId: string) {
  if (!getModels(provider).some((model) => model.id === modelId)) {
    throw new ApiError(400, "invalid_model", "Model is not in the account provider's catalog.");
  }
}

/** Only operator-trusted origins may receive credentials. Clients also reject redirects. */
export function validateDestination(account: Pick<Account, "provider" | "config">, extraOrigins: readonly string[]) {
  const origin = new URL(account.config.baseUrl as string ?? baseUrls[account.provider]).origin;
  if (origin !== new URL(baseUrls[account.provider]).origin && !extraOrigins.includes(origin)) {
    throw new ApiError(400, "destination_not_allowed", "The account's provider origin is not allowed by this gateway.");
  }
}

export type Execute = (account: Account, modelId: string, request: StoredRequest, signal: AbortSignal, timeoutMs: number) => Promise<AssistantResponse>;

export function createExecutor(encryptionKey: Buffer, extraOrigins: readonly string[], fetch?: typeof globalThis.fetch): Execute {
  return async (account, modelId, request, signal, timeoutMs) => {
    validateDestination(account, extraOrigins);
    const secrets = JSON.parse(decryptSecret(account.secretsEncrypted, encryptionKey,
      `user:${account.userId}:account:${account.id}:${account.provider}:secrets`)) as Record<string, unknown>;
    // Settings were validated on account writes. Clients validate their own configuration and request.
    const options = { ...account.config, ...secrets, fetch };
    const input = { ...request, modelId };
    const call = { signal, timeoutMs: Math.min(timeoutMs, account.config.timeoutMs as number ?? 15 * 60 * 1000) };
    switch (account.provider) {
      case "openai": return createOpenAiClient(options as OpenAiClientOptions).complete(input as OpenAiRequestInput, call);
      case "chatgpt": return createChatGptClient(options as ChatGptClientOptions).complete(input as ChatGptRequestInput, call);
      case "fireworks": return createFireworksClient(options as FireworksClientOptions).complete(input as FireworksRequestInput, call);
    }
  };
}
