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
import { findOpencode, listModels, runPrompt } from "./cli.mjs";
import {
  MAX_PROMPT,
  SSE_DONE,
  chunk,
  completionUsage,
  eventError,
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

function jsonError(status, message, type = "invalid_request_error") {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json" },
  });
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

async function refresh() {
  const models = await listModels(bin);
  const next = {};
  for (const entry of models) next[entry.id] = toModel(entry);
  return next;
}

// magpie's plugin host calls this once per start; the object it returns is the
// plugin. (An object exported in its place is rejected: "exports no OpenCode
// plugin function".)
async function server() {
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
                known = await refresh();
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

            const id = `chatcmpl-${randomUUID().replace(/-/g, "")}`;
            const created = Math.floor(Date.now() / 1000);
            const streaming = body.stream === true;
            const caller = request.signal;

            if (!streaming) {
              let text = "";
              let usage;
              let failure;
              try {
                for await (const event of runPrompt(bin, model, prompt, caller)) {
                  text += eventText(event);
                  const error = eventError(event);
                  if (error) failure = error;
                  if (event?.type === "step_finish") {
                    usage = completionUsage(event.part);
                    break;
                  }
                }
              } catch (error) {
                // The CLI's own error event, already read off stdout, says more
                // than "exited 1": keep the first one.
                if (!failure) failure = error?.message ?? String(error);
              }
              if (failure) return jsonError(502, failure, "upstream_error");
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
            const stream = new ReadableStream({
              start(controller) {
                const send = (event) => controller.enqueue(encoder.encode(sse(event)));
                const stop = new AbortController();
                const abort = () => stop.abort();
                caller?.addEventListener("abort", abort, { once: true });
                (async () => {
                  try {
                    for await (const event of runPrompt(bin, model, prompt, stop.signal)) {
                      const error = eventError(event);
                      if (error) {
                        send({ error: { message: error, type: "upstream_error" } });
                        break;
                      }
                      const text = eventText(event);
                      if (text) send(chunk(id, model, created, { content: text }));
                      if (event?.type === "step_finish") {
                        const usage = completionUsage(event.part);
                        if (usage) send(usageChunk(id, model, created, usage));
                        send(chunk(id, model, created, {}, "stop"));
                        break;
                      }
                    }
                    controller.enqueue(encoder.encode(SSE_DONE));
                  } catch (error) {
                    const message = error?.message ?? String(error);
                    try {
                      send({ error: { message, type: "upstream_error" } });
                      controller.enqueue(encoder.encode(SSE_DONE));
                    } catch {
                      // The caller already went away.
                    }
                  } finally {
                    caller?.removeEventListener("abort", abort);
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
          known = await refresh();
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
