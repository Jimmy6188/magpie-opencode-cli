// Offline checks for the plugin. `node verify.mjs` talks to the real CLI and so
// needs a free allowance; this file drives the request path with a fake runner
// instead, so the error and streaming behaviour stays checkable at any time.
//
//   bun selftest.mjs      (or: node selftest.mjs)

const mod = await import("./index.mjs");
const { eventFailure } = await import("./protocol.mjs");

const MODEL = "glm-5.3-flash-free";
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const quota = {
  type: "provider.free-limit",
  message: "Free usage limit reached. Connect a provider or subscribe to OpenCode Go.",
  status: 429,
  response: {
    body: JSON.stringify({
      type: "error",
      error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
    }),
  },
  retryAfterMs: 75_277_000,
};

const script = (events) => async function* () {
  for (const event of events) yield event;
};

const text = (value) => ({
  type: "text",
  part: { type: "text", text: value },
});
const stepStart = { type: "step_start", part: { type: "step-start" } };
const stepFinish = {
  type: "step_finish",
  part: { type: "step-finish", tokens: { input: 11, output: 4, total: 15 } },
};

const runs = {
  quota: script([{ type: "error", error: quota }, stepStart]),
  errorMid: script([stepStart, text("partial "), { type: "error", error: quota }]),
  okV2: script([stepStart, text("Hello"), text(" world")]),
  okV1: script([stepStart, text("Hi"), stepFinish]),
  legacy: script([
    {
      type: "error",
      error: {
        name: "APIError",
        data: { message: "boom", statusCode: 503, responseBody: '{"error":{"message":"upstream down"}}' },
      },
    },
  ]),
  throws: async function* () {
    throw new Error("opencode run exited 1: nope");
  },
};

const list = async () => [
  { id: MODEL, providerID: "opencode", cost: { input: 0, output: 0 } },
];

function makePlugin(run) {
  return mod.default.server({ run, list }).then(async (plugin) => {
    await plugin.config({});
    return plugin.auth.loader(async () => ({ type: "api", key: "local" }));
  });
}

const call = (send, body, init = {}) =>
  send("http://127.0.0.1:1/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

const ask = (content = "hi") => ({ model: MODEL, messages: [{ role: "user", content }] });

// 1. Non-streaming quota failure: a real status the caller can act on.
{
  const { fetch } = await makePlugin(runs.quota);
  const res = await call(fetch, ask());
  const body = await res.json();
  const retry = Number(res.headers.get("retry-after"));
  check(
    "non-streaming quota answers 429",
    res.status === 429 && body.error?.type === "rate_limit_error",
    `HTTP ${res.status} ${JSON.stringify(body.error?.type)}`,
  );
  check("quota carries Retry-After", retry > 0, `${res.headers.get("retry-after")}s`);
  check(
    "quota message says when it resets",
    /resets at \d{4}-\d{2}-\d{2}/.test(body.error?.message ?? ""),
    body.error?.message,
  );
}

// 2. Streaming quota failure: the bug this patch exists for.
{
  const { fetch } = await makePlugin(runs.quota);
  const res = await call(fetch, { ...ask(), stream: true });
  const body = await res.text();
  check(
    "streaming quota answers 429 before the stream",
    res.status === 429 && res.headers.get("retry-after") !== null,
    `HTTP ${res.status}, retry-after ${res.headers.get("retry-after")}`,
  );
  check("streaming quota sends no SSE payload", !body.includes("data:"), body.slice(0, 80));
}

// 3. Streaming success on 2.x: no step_finish, so the stop chunk is synthesised.
{
  const { fetch } = await makePlugin(runs.okV2);
  const res = await call(fetch, { ...ask(), stream: true });
  const body = await res.text();
  check("2.x stream answers 200", res.status === 200, `HTTP ${res.status}`);
  check("2.x stream carries the text", body.includes("Hello") && body.includes(" world"));
  check("2.x stream finishes", body.includes('"finish_reason":"stop"'));
  check("2.x stream ends with [DONE]", body.trimEnd().endsWith("data: [DONE]"));
}

// 4. Streaming success on 1.x: usage plus finish_reason from step_finish.
{
  const { fetch } = await makePlugin(runs.okV1);
  const res = await call(fetch, { ...ask(), stream: true });
  const body = await res.text();
  check("1.x stream reports usage", body.includes('"completion_tokens":4'), body.match(/"usage":[^}]+}/)?.[0]);
  check("1.x stream finishes once", body.match(/"finish_reason":"stop"/g)?.length === 1);
}

// 5. A failure after the stream started still has to be readable.
{
  const { fetch } = await makePlugin(runs.errorMid);
  const res = await call(fetch, { ...ask(), stream: true });
  const body = await res.text();
  check(
    "mid-stream failure is surfaced",
    res.status === 200 && body.includes('"upstream_error"') && body.includes("[DONE]"),
    body.slice(0, 120),
  );
}

// 6. Non-streaming success still returns a complete completion object.
{
  const { fetch } = await makePlugin(runs.okV1);
  const res = await call(fetch, ask());
  const body = await res.json();
  check(
    "non-streaming success answers 200",
    res.status === 200 && body.choices?.[0]?.message?.content === "Hi",
    JSON.stringify(body.choices?.[0]?.message),
  );
  check("non-streaming success reports usage", body.usage?.total_tokens === 15, JSON.stringify(body.usage));
}

// 7. A CLI that dies without a JSON error is still a 502, not a hang.
{
  const { fetch } = await makePlugin(runs.throws);
  const res = await call(fetch, ask());
  const body = await res.json();
  check("crashed CLI answers 502", res.status === 502 && /exited 1/.test(body.error?.message ?? ""), body.error?.message);
}

// 8. Older CLI error shape keeps working.
{
  const { fetch } = await makePlugin(runs.legacy);
  const res = await call(fetch, ask());
  const body = await res.json();
  check(
    "1.x error shape is parsed",
    res.status === 503 && body.error?.message === "upstream down",
    `HTTP ${res.status} ${body.error?.message}`,
  );
}

// 9. Request validation did not change.
{
  const { fetch } = await makePlugin(runs.okV2);
  const unknown = await call(fetch, { model: "nope", messages: [{ role: "user", content: "hi" }] });
  const unknownBody = await unknown.json();
  check("unknown model answers 404", unknown.status === 404 && unknownBody.error?.message.includes(MODEL));
  const empty = await call(fetch, { model: MODEL, messages: [] });
  check("empty messages answer 400", empty.status === 400);
  const bad = await call(fetch, ask(), { body: "not json" });
  check("non-JSON body answers 400", bad.status === 400);
}

// 10. The failure parser reads both shapes and the retry hint.
{
  const parsed = eventFailure({ type: "error", error: quota });
  check(
    "parser reads 2.x quota event",
    parsed?.quota && parsed.status === 429 && parsed.retryAfterMs === 75_277_000 && parsed.message.includes("Free usage limit"),
    JSON.stringify(parsed),
  );
  const legacy = eventFailure({
    type: "error",
    error: { name: "APIError", data: { message: "boom", statusCode: 503, responseBody: '{"error":{"message":"upstream down"}}' } },
  });
  check(
    "parser reads 1.x event",
    legacy?.status === 503 && legacy.message === "upstream down" && legacy.quota === false,
    JSON.stringify(legacy),
  );
  check("parser ignores non-error events", eventFailure(stepStart) === null);
}

console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
