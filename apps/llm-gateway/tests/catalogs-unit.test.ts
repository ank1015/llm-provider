import assert from "node:assert/strict";
import { it } from "node:test";
import { OPENAI_MODELS } from "@llm-providers/provider-openai";
import { CHATGPT_MODELS } from "@llm-providers/provider-chatgpt";
import { FIREWORKS_MODELS } from "@llm-providers/provider-fireworks";
import { getModels, PROVIDERS } from "../src/catalogs/service.js";
import { validateModel } from "../src/jobs/provider.js";

it("uses the provider packages' exact catalogs and stable provider order", () => {
  assert.deepEqual(PROVIDERS, [{ id: "openai", name: "OpenAI" }, { id: "chatgpt", name: "ChatGPT" }, { id: "fireworks", name: "Fireworks" }]);
  assert.equal(getModels("openai"), OPENAI_MODELS);
  assert.equal(getModels("chatgpt"), CHATGPT_MODELS);
  assert.equal(getModels("fireworks"), FIREWORKS_MODELS);
  assert.deepEqual(getModels(), [...OPENAI_MODELS, ...CHATGPT_MODELS, ...FIREWORKS_MODELS]);
});

it("shares advertised model membership with job validation without merging provider identities", () => {
  for (const provider of PROVIDERS) {
    for (const model of getModels(provider.id)) {
      assert.equal(model.provider, provider.id);
      assert.doesNotThrow(() => validateModel(provider.id, model.id));
    }
    assert.throws(() => validateModel(provider.id, "not-in-catalog"));
  }
  assert.equal(new Set(getModels().map((model) => `${model.provider}:${model.id}`)).size, getModels().length);
});
