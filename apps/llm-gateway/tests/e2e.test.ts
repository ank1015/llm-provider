import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { it } from "node:test";
import type { Provider } from "@llm-providers/contracts";
import { startStack, until } from "./helpers/stack.js";

it("runs the compiled gateway end to end with all three provider protocols", { timeout: 120_000 }, async () => {
  const callbacks: { eventId: string; jobId: string; response?: unknown }[] = [];
  const upstream: { provider: string; body: Record<string, unknown> }[] = [];
  const receiverErrors: unknown[] = [];
  let webhookSecret = "";
  let retryProvider = true;
  let retryCallback = true;
  const stack = await startStack(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = JSON.parse(raw);
      if (req.url === "/events") {
        const timestamp = String(req.headers["x-llm-gateway-timestamp"]);
        const eventId = String(req.headers["x-llm-gateway-event-id"]);
        const expected = `v1=${createHmac("sha256", webhookSecret).update(`${timestamp}.${eventId}.${raw}`).digest("hex")}`;
        assert.equal(req.headers["x-llm-gateway-signature"], expected);
        assert.equal(body.eventId, eventId);
        assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 30);
        callbacks.push(body);
        if (retryCallback) { retryCallback = false; res.writeHead(503); }
        else res.writeHead(204);
        res.end();
        return;
      }
      const provider = req.url!.split("/")[1]!;
      upstream.push({ provider, body });
      assert.equal(req.headers.authorization, `Bearer test-${provider}-credential`);
      assert.equal(req.method, "POST");
      if (provider === "openai" && retryProvider) {
        retryProvider = false;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "temporary fixture failure" } }));
        return;
      }
      if (body.metadata?.scenario === "fail") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "private-provider-error" } }));
        return;
      }
      const output = [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Fixture reply", annotations: [] }] }];
      const response = { id: `resp_${upstream.length}`, object: "response", model: body.model,
        status: "completed", output, usage: { input_tokens: 10, output_tokens: 2,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
      if (provider === "chatgpt") {
        assert.equal(req.url, "/chatgpt/codex/responses");
        assert.equal(req.headers.accept, "text/event-stream");
        assert.equal(req.headers["chatgpt-account-id"], "fixture-account");
        assert.equal(body.stream, true);
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Completed output is absent: replay must use output_item.done, not text deltas.
        const events = [{ type: "response.created", response: { id: response.id } },
          { type: "response.output_text.delta", delta: "Ignored delta" },
          { type: "response.output_item.done", item: output[0] },
          { type: "response.completed", response: { ...response, id: undefined, output: [] } }];
        for (const event of events) {
          const data = `data: ${JSON.stringify(event)}\n\n`;
          res.write(data.slice(0, 13)); res.write(data.slice(13));
        }
        res.end();
      } else {
        assert.equal(req.url, provider === "openai" ? "/openai/responses" : "/fireworks/chat/completions");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(provider === "openai" ? response : {
          id: response.id, object: "chat.completion", model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant",
            content: "Fixture reply", reasoning_content: "Fixture reasoning" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
        }));
      }
    } catch (error) {
      receiverErrors.push(error);
      res.writeHead(500); res.end();
    }
  });
  try {
    const { request, adminKey } = stack;
    const registered = await request("/v1/admin/users", adminKey, "POST", { name: "E2E", callbackUrl: `${stack.origin}/events` }, 201);
    webhookSecret = registered.webhookSecret;
    const token = registered.key.secret;
    const foreign = await request("/v1/admin/users", adminKey, "POST", { name: "Other", callbackUrl: `${stack.origin}/events` }, 201);
    assert.equal((await request("/v1/me", token)).id, registered.user.id);
    await request("/v1/me", token, "PATCH", { name: "E2E updated" });
    await request("/v1/accounts", undefined, "GET", undefined, 401);
    assert.equal((await request("/v1/providers", token)).data.length, 3);
    const accounts = new Map<Provider, { id: string; modelId: string }>();
    for (const provider of ["openai", "chatgpt", "fireworks"] as const) {
      const catalog = await request(`/v1/models?provider=${provider}`, token);
      const modelId = catalog.data[0].id;
      const account = await request("/v1/accounts", token, "POST", { provider, name: provider,
        config: { baseUrl: `${stack.origin}/${provider}`, timeoutMs: 10_000,
          ...(provider === "chatgpt" ? { accountId: "fixture-account" } : {}) },
        secrets: provider === "chatgpt" ? { accessToken: `test-${provider}-credential` } : { apiKey: `test-${provider}-credential` },
      }, 201);
      accounts.set(provider, { id: account.id, modelId });
      assert.deepEqual(await request(`/v1/accounts/${account.id}/models`, token), catalog);
      await request(`/v1/accounts/${account.id}`, foreign.key.secret, "GET", undefined, 404);
    }
    assert.equal((await request("/v1/accounts", token)).data.length, 3);
    const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
    const openai = accounts.get("openai")!;
    const fresh = (key: string) => ({ accountId: openai.id, modelId: openai.modelId,
      idempotencyKey: key, instructions: "Be brief.", messages: [message("Hello")] });
    const cancelled = await request("/v1/jobs", token, "POST", fresh("cancel"), 202);
    assert.equal((await request(`/v1/jobs/${cancelled.id}/cancel`, token, "POST")).status, "cancelled");
    let worker = stack.worker();
    const finish = (id: string) => until(() => request(`/v1/jobs/${id}`, token),
      (job) => ["succeeded", "failed", "cancelled"].includes(job.status));
    const parents: string[] = [];
    for (const [provider, account] of accounts) {
      const input = { ...fresh(provider), accountId: account.id, modelId: account.modelId };
      const submitted = await request("/v1/jobs", token, "POST", input, 202);
      parents.push(submitted.id);
      assert.equal((await request("/v1/jobs", token, "POST", input, 202)).id, submitted.id);
      await request("/v1/jobs", token, "POST", { ...input, instructions: "Changed" }, 409);
      const job = await finish(submitted.id);
      assert.equal(job.status, "succeeded");
      assert.equal(job.response.message.provider, provider);
      assert.equal(job.response.usage.output, 2);
      assert.equal(job.requestStatus, "retained");
      await request(`/v1/jobs/${job.id}`, foreign.key.secret, "GET", undefined, 404);
      const child = await request("/v1/jobs", token, "POST", {
        idempotencyKey: `${provider}-child`, previousJobId: job.id, messages: [message("Continue")],
      }, 202);
      const continued = await finish(child.id);
      assert.equal(continued.status, "succeeded");
      assert.deepEqual(continued.request.messages, [...input.messages, job.response.message, message("Continue")]);
      const wire = upstream.filter((call) => call.provider === provider).at(-1)!.body;
      const messages = (provider === "fireworks" ? wire.messages : wire.input) as unknown[];
      const native = job.response.message.content[0];
      assert.ok(messages.some((item) => JSON.stringify(item) === JSON.stringify(native)));
    }
    const attempts = await request(`/v1/jobs/${parents[0]}/attempts`, token);
    assert.deepEqual(attempts.data.map((attempt: { status: string }) => attempt.status), ["failed", "succeeded"]);
    const failed = await request("/v1/jobs", token, "POST", { ...fresh("failure"), providerOptions: { metadata: { scenario: "fail" } } }, 202);
    const failure = await finish(failed.id);
    assert.equal(failure.status, "failed");
    assert.equal(failure.error.httpStatus, 400);
    assert.ok(!JSON.stringify(failure).includes("private-provider-error"));
    assert.equal((await request(`/v1/jobs/${failed.id}/attempts`, token)).data.length, 1);

    // Advance only the fixture's retry clock; delivery still uses the real queue and HTTPS sender.
    await until(async () => (await stack.pool.query("select id from webhook_deliveries where status = 'retry_wait'")).rowCount, (count) => count === 1);
    await stack.pool.query("update webhook_deliveries set next_attempt_at = now() where status = 'retry_wait'");
    const deliveries = await until(() => request("/v1/webhook-deliveries", token),
      (result) => result.data.length === 8 && result.data.every((item: { status: string }) => item.status === "delivered"));
    const delivery = deliveries.data.find((item: { jobId: string }) => item.jobId === parents[0]);
    const details = await request(`/v1/webhook-deliveries/${delivery.id}`, token);
    assert.deepEqual(details.payload.response, (await request(`/v1/jobs/${parents[0]}`, token)).response);
    const priorCallbacks = callbacks.filter((event) => event.eventId === delivery.id).length;
    await request(`/v1/webhook-deliveries/${delivery.id}/redeliver`, token, "POST", undefined, 202);
    await until(() => request(`/v1/webhook-deliveries/${delivery.id}`, token), (result) => result.status === "delivered");
    assert.equal(callbacks.filter((event) => event.eventId === delivery.id).length, priorCallbacks + 1);
    assert.equal((await request("/v1/usage", token)).summary.jobs.total, "8");
    const usage = await request("/v1/usage?groupBy=provider", token);
    assert.equal(usage.data.length, 3);
    assert.equal(usage.summary.tokens.output.knownTotal, "12");
    assert.equal((await request("/v1/usage", foreign.key.secret)).summary.jobs.total, "0");

    // Accepted jobs survive a worker restart; startup cleanup removes expired input only.
    await stack.stop(worker);
    const durable = await request("/v1/jobs", token, "POST", fresh("restart"), 202);
    await stack.pool.query("update job_requests set expires_at = now() - interval '1 second' where job_id = $1", [parents[0]]);
    await request("/v1/jobs", token, "POST", { previousJobId: parents[0], idempotencyKey: "expired-parent", messages: [] }, 410);
    worker = stack.worker();
    assert.equal((await finish(durable.id)).status, "succeeded");
    assert.equal((await request(`/v1/jobs/${parents[0]}`, token)).requestStatus, "expired");
    assert.equal((await stack.pool.query("select 1 from job_requests where job_id = $1", [parents[0]])).rowCount, 0);
    await request(`/v1/accounts/${openai.id}`, token, "DELETE", undefined, 204);
    await request(`/v1/accounts/${openai.id}`, token, "GET", undefined, 404);
    assert.equal((await request(`/v1/jobs/${durable.id}`, token)).status, "succeeded");
    await request(`/v1/admin/users/${registered.user.id}/keys/${registered.key.id}`, adminKey, "DELETE", undefined, 204);
    await request("/v1/me", token, "GET", undefined, 401);
    assert.deepEqual(receiverErrors, []);
    for (const secret of [token, webhookSecret, "test-openai-credential", "private-provider-error"]) {
      assert.ok(!stack.logs().includes(secret), "Sensitive value appeared in process logs.");
    }
  } finally {
    await stack.close();
  }
});
