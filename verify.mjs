// Local checks for the plugin, run with `node verify.mjs`. Nothing here is
// needed at runtime; it exists so a change to cli.mjs or protocol.mjs can be
// checked without going through magpie.

const mod = await import("./index.mjs");
const server = await mod.default.server();
const { findOpencode, listModels, version, supportsStdin } = await import("./cli.mjs");
const { toPrompt, MAX_PROMPT } = await import("./protocol.mjs");

const MODEL = "nemotron-3.5-lightning-free";
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const bin = findOpencode();
check("opencode CLI found", Boolean(bin), bin ?? "not found");
if (!bin) process.exit(1);

const models = await listModels(bin);
check("free models listed", models.length > 0, `${models.length} models`);
console.log(
  models.map((m) => `    ${m.id}  ctx=${m.limit?.context} out=${m.limit?.output}`).join("\n"),
);

// 2.x lists model ids without the metadata 1.x's `models --verbose` gave, and
// reports no token counts at all, so the usage check below only applies to 1.x.
const cliVersion = await version(bin);
const onV2 = await supportsStdin(bin);

check("prompt keeps turns", toPrompt([
  { role: "system", content: "terse" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "say OK" },
]).includes("Assistant:"));

await server.config({});
const call = (await server.auth.loader(async () => ({ type: "api", key: "local" }))).fetch;
const URL_ = "http://127.0.0.1:1/v1/chat/completions";
const post = (body) =>
  call(new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const messages = [{ role: "user", content: "Name one planet. One word." }];

const plain = await post({ model: MODEL, messages });
const completion = await plain.json();
check("non-streaming answers", plain.status === 200 && completion.choices?.[0]?.message?.content,
  `HTTP ${plain.status}: ${JSON.stringify(completion.choices?.[0]?.message?.content)}`);

const streamed = await post({ model: MODEL, messages, stream: true });
const text = await new Response(streamed.body).text();
check("streaming sends [DONE]", streamed.status === 200 && text.includes("data: [DONE]"));
if (onV2) {
  console.log("– streaming sends usage — skipped: OpenCode CLI 2.x sends no step_finish, so no token counts");
} else {
  check("streaming sends usage", text.includes('"usage"'));
}
check("streaming sends finish_reason", text.includes('"finish_reason":"stop"'));

const geo = await post({ model: "beam-free", messages });
const geoBody = await geo.json();
check("geo-blocked model says why", geo.status === 502 && /country|region/i.test(geoBody.error?.message ?? ""),
  geoBody.error?.message);

const unknown = await post({ model: "no-such-model", messages });
const unknownBody = await unknown.json();
check("unknown model lists the free ones", unknown.status === 404 && unknownBody.error?.message.includes(MODEL));

const empty = await post({ model: MODEL, messages: [] });
check("empty messages rejected", empty.status === 400);

console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"} (CLI ${cliVersion}, MAX_PROMPT ${MAX_PROMPT})`);
process.exit(failures ? 1 : 0);
