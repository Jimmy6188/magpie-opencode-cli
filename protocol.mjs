// Between an OpenAI-style conversation and one prompt for `opencode run`,
// and between the CLI's JSON events and OpenAI chat completion chunks.

const ROLE_LABEL = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  function: "Tool",
};

// Windows builds one command line for the child process and caps it at
// 32,767 characters. A prompt that fits in argv is passed there; anything
// longer goes to the CLI over stdin, which has no such cap.
export const MAX_ARG = 24_000;

// The real ceiling once the prompt travels on stdin is the model's context
// window, not the command line. 200k characters is roughly 100k tokens of
// Chinese, comfortably inside the 128k-token free models.
export const MAX_PROMPT = 200_000;

export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function toPrompt(messages) {
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = messageText(message).trim();
    if (!text) continue;
    const label = ROLE_LABEL[message?.role] ?? "User";
    lines.push(`${label}: ${text}`);
  }
  if (!lines.length) return "";
  return `${lines.join("\n\n")}\n\nAssistant:`;
}

export function chunk(id, model, created, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function usageChunk(id, model, created, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: usage ?? undefined,
  };
}

export function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

// The CLI reports a finished step with the token counts it was charged.
export function completionUsage(part) {
  const tokens = part?.tokens;
  if (!tokens) return undefined;
  return {
    prompt_tokens: tokens.input ?? 0,
    completion_tokens: tokens.output ?? 0,
    total_tokens: tokens.total ?? (tokens.input ?? 0) + (tokens.output ?? 0),
  };
}

// What a `text` event carries: the text the model produced.
export function eventText(event) {
  if (event?.type !== "text") return "";
  const part = event.part;
  if (part?.type !== "text" || typeof part.text !== "string") return "";
  return part.text;
}

// A failed call comes back in one of two shapes:
//
//   OpenCode CLI 2.x
//     {"type":"error","error":{"type":"provider.free-limit","message":"…","status":429,
//      "response":{"body":"{\"error\":{…}}"},"retryAfterMs":75277000}}
//   OpenCode CLI 1.x
//     {"type":"error","error":{"name":"APIError","data":{"message","statusCode","responseBody"}}}
//
// The status and the retry delay are what let the caller rate-limit the
// provider instead of treating a spent free allowance as a broken call, so
// both are read out here rather than folded into a string.
function decodeBody(body) {
  if (typeof body !== "string") return null;
  if (!body.trimStart().startsWith("{")) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const QUOTA = /free-limit|free.?usage|quota/i;

export function eventFailure(event) {
  if (event?.type !== "error") return null;
  const error = event.error ?? event.part?.error ?? {};
  const data = error.data ?? {};
  const body = decodeBody(data.responseBody) ?? decodeBody(error.response?.body);
  const inner = body?.error?.message ?? body?.message;
  const message =
    [inner, data.message, error.message].find((value) => typeof value === "string" && value) ??
    "OpenCode CLI reported an error";
  const status = [error.status, data.statusCode, body?.error?.status].find(
    (value) => typeof value === "number" && value >= 400,
  );
  const code = String(error.type ?? error.name ?? body?.error?.type ?? "");
  const retryAfterMs = [error.retryAfterMs, data.retryAfterMs, body?.retryAfterMs].find(
    (value) => typeof value === "number" && value > 0,
  );
  return { message, status, code, retryAfterMs, quota: QUOTA.test(`${code} ${message}`) };
}

// Kept for callers that only want the sentence to show a user.
export function eventError(event) {
  const failure = eventFailure(event);
  if (!failure) return null;
  return typeof failure.status === "number"
    ? `${failure.message} (HTTP ${failure.status})`
    : failure.message;
}
