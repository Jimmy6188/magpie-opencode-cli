// A magpie provider plugin that serves OpenCode's free models by driving the
// OpenCode CLI installed on this machine.
//
// Why the CLI: OpenCode answers its free tier only to its own client. The
// same request sent straight to https://opencode.ai/inference/v1 comes back
// 429 FreeUsageLimitError whether it carries the anonymous "public"
// credential or a real Console key, while `opencode run` with the same model
// answers normally. So the plugin runs the CLI and translates between
// OpenAI chat completions and the CLI's JSON event stream.

import { randomUUID } from "node:crypto";
import { findOpencode, listModels, runPrompt, supportsStdin } from "./cli.mjs";
import {
  MAX_ARG,
  MAX_PROMPT,
  SSE_DONE,
  chunk,
  completionUsage,
  eventFailure,
  eventText,
  sse,
  toPrompt,
  usageChunk,
} from "./protocol.mjs";

const PROVIDER = "opencode-cli";
const SDK = "@ai-sdk/openai-compatible";
// Never contacted: every request goes through this plugin's own fetch.
const PLACEHOLDER_BASE = "http://127.0.0.1:1/v1";

const bin = findOpencode();
// What the last successful listing gave, so a failed one keeps the models shown.
let known = {};

function jsonError(status, message, type = "invalid_request_error", headers = {}) {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const QUOTA = /free.?limit|free.?usage|quota/i;

function resetText(retryAfterMs) {
  const at = new Date(Date.now() + retryAfterMs);
  const pad = (value) => String(value).padStart(2, "0");
  const clock = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const hours = (retryAfterMs / 3_600_000).toFixed(1);
  return `${clock}（约 ${hours} 小时后）`;
}

// A spent free allowance is rate limiting, not a broken call: OpenCode answers
// 429 FreeUsageLimitError with the delay it will accept requests again after.
// Passing that through as 429 plus Retry-After is what lets magpie cool the
// provider down and fall back to the next one in the group, instead of
// reporting the same failure on every retry.
function describeFailure(failure) {
  const retryAfterMs = Number(failure?.retryAfterMs);
  const hasRetry = Number.isFinite(retryAfterMs) && retryAfterMs > 0;
  const quota = Boolean(failure?.quota) || QUOTA.test(String(failure?.message ?? ""));
  const upstream = Number(failure?.status);
  const status = quota ? 429 : Number.isFinite(upstream) && upstream >= 400 ? upstream : 502;
  let message = failure?.message || "OpenCode CLI reported an error";
  if (quota && hasRetry) message += ` Free quota resets at ${resetText(retryAfterMs)}.`;
  return {
    status,
    message,
    type: status === 429 ? "rate_limit_error" : "upstream_error",
    retryAfterMs: quota && hasRetry ? retryAfterMs : undefined,
  };
}

function failureResponse(failure) {
  const described = describeFailure(failure);
  const headers = described.retryAfterMs
    ? { "retry-after": String(Math.max(1, Math.ceil(described.retryAfterMs / 1000))) }
    : {};
  return jsonError(described.status, described.message, described.type, headers);
}

function toModel(entry) {
  return {
    id: entry.id,
    name: entry.name || entry.id,
    api: { id: entry.id, npm: SDK },
    limit: {
      context: entry.limit?.context ?? 128_000,
      output: entry.limit?.output ?? 32_000,
    },
    capabilities: {
      reasoning: Boolean(entry.capabilities?.reasoning),
      // Tool calling needs the JSON-envelope protocol; chat only for now.
      toolcall: false,
      attachment: Boolean(entry.capabilities?.attachment),
      input: { text: true, image: Boolean(entry.capabilities?.attachment) },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: entry.variants ?? undefined,
    status: entry.status,
    free: true,
  };
}

async function refresh(list) {
  const models = await list(bin);
  const next = {};
  for (const entry of models) next[entry.id] = toModel(entry);
  return next;
}

// magpie's plugin host calls this once per start; the object it returns is the
// plugin. (An object exported in its place is rejected: "exports no OpenCode
// plugin function".) The overrides exist so the offline checks can drive the
// request path without spending a free allowance.
async function server(options = {}) {
  const run = options.run ?? runPrompt;
  const list = options.list ?? listModels;
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= {
        name: "OpenCode CLI",
        npm: SDK,
        api: PLACEHOLDER_BASE,
        models: {},
      };
    },

    auth: {
      provider: PROVIDER,
      single: true,
      icon: "https://opencode.ai/favicon-v3.ico",
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          keyless: true,
          label: "本机 OpenCode CLI（无需密钥，用 CLI 自己的身份）",
          placeholder: "不需要填写",
          async authorize() {
            return { type: "success", key: "local" };
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        if (!bin) {
          throw new Error(
            "OpenCode CLI not found. Install it with `npm i -g opencode-ai`, then sign in again.",
          );
        }
        return {
          baseURL: PLACEHOLDER_BASE,
          apiKey: "local",
          async fetch(input, init) {
            const request = new Request(input, init);
            if (request.method !== "POST") {
              throw new Error(`Unsupported method ${request.method}`);
            }
            let body;
            try {
              body = await request.json();
            } catch {
              return jsonError(400, "Expected a JSON request body");
            }

            const model = typeof body?.model === "string" ? body.model : "";
            if (!Object.hasOwn(known, model) && Object.keys(known).length === 0) {
              // A gateway process that has not listed models yet arrives here
              // with nothing known: ask the CLI once rather than fail the call.
              try {
                known = await refresh(list);
              } catch {
                // Left empty; the 404 below says which models there are.
              }
            }
            if (!Object.hasOwn(known, model)) {
              const available = Object.keys(known).sort().join(", ") || "none";
              return jsonError(
                404,
                `Model ${model} is not an OpenCode CLI free model. Free models: ${available}.`,
                "not_found_error",
              );
            }

            const prompt = toPrompt(body.messages);
            if (!prompt) {
              return jsonError(400, "The request carried no message text");
            }
            if (prompt.length > MAX_PROMPT) {
              return jsonError(
                400,
                `The conversation is too long for one OpenCode CLI call (${prompt.length} characters, limit ${MAX_PROMPT}). Start a new conversation.`,
              );
            }
            if (prompt.length > MAX_ARG && !(await supportsStdin(bin))) {
              // 1.x cannot take the prompt on stdin, so argv stays the ceiling.
              return jsonError(
                400,
                `The conversation is too long for one OpenCode CLI call (${prompt.length} characters, limit ${MAX_ARG}). Start a new conversation.`,
              );
            }

            const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
            const created = Math.floor(Date.now() / 1000);
            const streaming = body.stream === true;
            const caller = request.signal;

            if (!streaming) {
              let text = "";
              let usage;
              let failure;
              try {
                for await (const event of run(bin, model, prompt, caller)) {
                  const reported = eventFailure(event);
                  if (reported) failure = reported;
                  else text += eventText(event);
                  if (event?.type === "step_finish") {
                    usage = completionUsage(event.part);
                    break;
                  }
                }
              } catch (error) {
                // The CLI's own error event, already read off stdout, says more
                // than "exited 1": keep the first one.
                if (!failure) failure = { message: error?.message ?? String(error) };
              }
              if (failure) return failureResponse(failure);
              return new Response(
                JSON.stringify({
                  id,
                  object: "chat.completion",
                  created,
                  model,
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: text },
                      finish_reason: "stop",
                    },
                  ],
                  usage,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              );
            }

            const encoder = new TextEncoder();
            const stop = new AbortController();
            const abort = () => stop.abort();
            caller?.addEventListener("abort", abort, { once: true });

            // A rejected call can be the very first thing the CLI prints. Read
            // that first event before the response is committed: a streaming
            // request that fails on quota has to answer 429, otherwise the
            // caller gets a 200 whose body carries the error and cannot retry
            // or fall back on the status at all.
            const iteration = run(bin, model, prompt, stop.signal)[Symbol.asyncIterator]();
            let head;
            try {
              head = await iteration.next();
            } catch (error) {
              caller?.removeEventListener("abort", abort);
              stop.abort();
              return jsonError(502, error?.message ?? String(error), "upstream_error");
            }
            const headFailure = head.done ? null : eventFailure(head.value);
            if (headFailure) {
              caller?.removeEventListener("abort", abort);
              stop.abort();
              try {
                await iteration.return?.();
              } catch {
                // The CLI was already stopped by the abort above.
              }
              return failureResponse(headFailure);
            }

            const stream = new ReadableStream({
              start(controller) {
                const send = (event) => controller.enqueue(encoder.encode(sse(event)));
                // OpenCode CLI 1.x ends a step with `step_finish`; 2.x emits
                // only `step_start` and `text`, so the stop chunk has to be
                // sent when the event stream ends instead. Returns true once
                // the answer is over, either way.
                let finished = false;
                let failed = false;
                const emit = (event) => {
                  const failure = eventFailure(event);
                  if (failure) {
                    failed = true;
                    send({
                      error: { message: describeFailure(failure).message, type: "upstream_error" },
                    });
                    return true;
                  }
                  const text = eventText(event);
                  if (text) send(chunk(id, model, created, { content: text }));
                  if (event?.type === "step_finish") {
                    const usage = completionUsage(event.part);
                    if (usage) send(usageChunk(id, model, created, usage));
                    send(chunk(id, model, created, {}, "stop"));
                    finished = true;
                    return true;
                  }
                  return false;
                };
                (async () => {
                  try {
                    if (!head.done) emit(head.value);
                    while (!finished && !failed) {
                      const next = await iteration.next();
                      if (next.done) break;
                      if (emit(next.value)) break;
                    }
                    if (!finished && !failed) send(chunk(id, model, created, {}, "stop"));
                    controller.enqueue(encoder.encode(SSE_DONE));
                  } catch (error) {
                    if (!caller?.aborted) {
                      const message = error?.message ?? String(error);
                      try {
                        send({ error: { message, type: "upstream_error" } });
                        controller.enqueue(encoder.encode(SSE_DONE));
                      } catch {
                        // The caller already went away.
                      }
                    }
                  } finally {
                    caller?.removeEventListener("abort", abort);
                    try {
                      await iteration.return?.();
                    } catch {
                      // Nothing left to stop.
                    }
                    controller.close();
                  }
                })();
              },
              cancel() {
                // The caller hung up: the CLI is stopped through stop.signal,
                // whose listener above fires on the caller's abort.
              },
            });
            return new Response(stream, {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              },
            });
          },
        };
      },
      async usage() {
        return { plan: "OpenCode CLI", windows: [] };
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models;
        try {
          known = await refresh(list);
        } catch (error) {
          // The CLI could not be asked: keep the list already shown, and say
          // why once, since magpie would otherwise show an empty provider.
          console.log(`opencode-cli: listing free models failed: ${error?.message ?? error}`);
          return provider.models;
        }
        return known;
      },
    },
  };
}

export default { id: PROVIDER, server };

export const _internal = { toModel, PROVIDER, SDK, PLACEHOLDER_BASE, bin };
