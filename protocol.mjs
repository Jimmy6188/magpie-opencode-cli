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

// OpenCode reports a failed call as
// {"type":"error","error":{"name":"APIError","data":{"message","statusCode","responseBody"}}}
// where responseBody is the provider's own JSON error.
export function eventError(event) {
  if (event?.type !== "error") return null;
  const error = event.error ?? event.part?.error ?? {};
  let message = error.data?.message ?? error.message;
  const body = error.data?.responseBody;
  if (typeof body === "string" && body.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner === "string" && inner) message = inner;
    } catch {
      // The body is not JSON; the outer message stands.
    }
  }
  if (typeof message !== "string" || !message) message = "OpenCode CLI reported an error";
  const status = error.data?.statusCode;
  return typeof status === "number" ? `${message} (HTTP ${status})` : message;
}
