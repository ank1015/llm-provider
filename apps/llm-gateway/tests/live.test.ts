import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { it } from "node:test";
import { startStack, until } from "./helpers/stack.js";

// Explicit opt-in only. Never included in pnpm test or test:e2e; these calls can incur charges.
for (const provider of ["openai", "fireworks"] as const) {
  it(`completes a live ${provider} job, continuation, usage, and signed callback`, { timeout: 180_000 }, async () => {
    const apiKey = process.env[provider === "openai" ? "LIVE_OPENAI_API_KEY" : "LIVE_FIREWORKS_API_KEY"];
    if (!apiKey) throw new Error(`Missing live ${provider} credential in the test runner environment.`);
    let secret = "";
    const received: { eventId: string; jobId: string; response?: unknown; error?: unknown }[] = [];
    let signatureError = false;
    const stack = await startStack(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const timestamp = String(req.headers["x-llm-gateway-timestamp"]);
      const eventId = String(req.headers["x-llm-gateway-event-id"]);
      const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${eventId}.${raw}`).digest("hex")}`;
      if (req.headers["x-llm-gateway-signature"] !== signature) signatureError = true;
      received.push(JSON.parse(raw));
      res.writeHead(204); res.end();
    });
    try {
      const { request } = stack;
      const user = await request("/v1/admin/users", stack.adminKey, "POST", {
        name: `Live ${provider} smoke test`, callbackUrl: `${stack.origin}/events`,
      }, 201);
      secret = user.webhookSecret;
      const token = user.key.secret;
      const account = await request("/v1/accounts", token, "POST", {
        name: "Temporary live account", provider, config: { timeoutMs: 45_000 }, secrets: { apiKey },
      }, 201);
      assert.ok(!JSON.stringify(account).includes(apiKey), "Account response must not expose credentials.");
      const modelId = provider === "openai" ? process.env.LIVE_OPENAI_MODEL ?? "gpt-5.6-luna"
        : process.env.LIVE_FIREWORKS_MODEL ?? "accounts/fireworks/models/glm-5p3-flash";
      const input = { idempotencyKey: "live-first", accountId: account.id, modelId,
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with just OK." }] }],
        providerOptions: provider === "openai" ? { max_output_tokens: 128 } : { max_tokens: 128 },
      };
      stack.worker();
      const submitted = await request("/v1/jobs", token, "POST", input, 202);
      assert.equal((await request("/v1/jobs", token, "POST", input, 202)).id, submitted.id);
      const finish = (id: string) => until(() => request(`/v1/jobs/${id}`, token),
        (job) => ["succeeded", "failed"].includes(job.status), 145_000);
      const job = await finish(submitted.id);
      await until(async () => received.some((event) => event.jobId === job.id), Boolean);
      assert.equal(signatureError, false);
      assert.deepEqual(received.find((event) => event.jobId === job.id)?.response ?? null, job.response);
      if (job.status !== "succeeded") {
        // Gateway errors are sanitized; do not print provider bodies, account objects, or keys.
        throw new Error(`${provider} live job failed: ${job.error?.code}, HTTP ${job.error?.httpStatus ?? "unavailable"}. Signed failure callback received.`);
      }
      assert.equal(job.response.message.provider, provider);
      assert.ok(job.response.message.content.length > 0);
      const child = await request("/v1/jobs", token, "POST", {
        idempotencyKey: "live-second", previousJobId: job.id,
        messages: [{ role: "user", content: [{ type: "text", text: "Again, reply with just OK." }] }],
      }, 202);
      const continued = await finish(child.id);
      assert.equal(continued.status, "succeeded", `${provider} continuation failed: ${continued.error?.code}, HTTP ${continued.error?.httpStatus ?? "unavailable"}`);
      assert.deepEqual(continued.request.messages[1], job.response.message);
      await until(async () => received.some((event) => event.jobId === child.id), Boolean);
      assert.equal(signatureError, false);
      const usage = await request(`/v1/usage?accountId=${account.id}`, token);
      assert.equal(usage.summary.jobs.succeeded, "2");
      assert.ok(BigInt(usage.summary.tokens.output.knownAttempts) > 0n);
      console.log(`${provider}: two live jobs and signed callbacks succeeded; recorded output tokens=${usage.summary.tokens.output.knownTotal}, estimated total USD=${usage.summary.costUsd.total.knownTotal ?? "unknown"}.`);
      for (const value of [apiKey, token, secret]) assert.ok(!stack.logs().includes(value), "Sensitive value appeared in process logs.");
    } finally {
      await stack.close();
    }
  });
}
