import type { Model, Provider } from "@llm-providers/contracts";
import { OPENAI_MODELS } from "@llm-providers/provider-openai";
import { CHATGPT_MODELS } from "@llm-providers/provider-chatgpt";
import { FIREWORKS_MODELS } from "@llm-providers/provider-fireworks";
import type { Database } from "../db/client.js";
import { getAccount } from "../accounts/service.js";

export const PROVIDERS = [
  { id: "openai", name: "OpenAI" },
  { id: "chatgpt", name: "ChatGPT" },
  { id: "fireworks", name: "Fireworks" },
] as const satisfies readonly { id: Provider; name: string }[];

const catalogs: Record<Provider, readonly Model[]> = {
  openai: OPENAI_MODELS, chatgpt: CHATGPT_MODELS, fireworks: FIREWORKS_MODELS,
};

export function getModels(provider?: Provider): readonly Model[] {
  return provider ? catalogs[provider] : PROVIDERS.flatMap(({ id }) => catalogs[id]);
}

export async function getAccountModels(db: Database, userId: string, accountId: string) {
  const account = await getAccount(db, userId, accountId);
  return getModels(account.provider);
}
