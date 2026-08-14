export const BITNET_MODEL_ID = "microsoft/bitnet-b1.58-2B-4T";

// bitnet-api 0.1.0 shipped the former bitnet-demo.azurewebsites.net host.
// Microsoft's current BitNet repository points to this replacement demo;
// its /completion and /gpuresult wire formats remain compatible.
const BITNET_BASE_URL =
  "https://demo-bitnet-h0h8hcfqeqhrf5gf.canadacentral-01.azurewebsites.net";
const BITNET_HEADERS = {
  "content-type": "application/json",
  "user-agent": "BitNetClient/1.0",
};
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

type Message = { role: string; content: string };

/**
 * Recreates bitnet-api 0.1.0's public demo transport:
 * CPU is a directly streamed SSE response; GPU is an asynchronous request
 * followed by /gpuresult polling and therefore cannot stream token deltas.
 */
export async function bitnetChatCompletion(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const messages = normalizeMessages(body.messages);
  if (!messages.length)
    return error("messages must contain at least one text message.", 400, "messages");
  if (body.tools || body.functions)
    return error("Mini (Preview) does not support tool or function calling.", 400, "tools", "unsupported_feature");

  const fastMode = body.fast_mode === true || body.device === "gpu";
  const wantsStream = body.stream === true;
  if (fastMode && wantsStream) {
    return error(
      "Mini Fast Mode cannot stream because the upstream BitNet demo's GPU path only returns completed jobs. Set stream to false or fast_mode to false.",
      400,
      "stream",
      "bitnet_gpu_streaming_unsupported",
    );
  }

  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  const session = crypto.randomUUID().replaceAll("-", "");
  if (fastMode) return gpuCompletion(messages, id, created, session, signal);
  return cpuCompletion(messages, id, created, session, wantsStream, signal);
}

function normalizeMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Message[] => {
    if (!entry || typeof entry !== "object") return [];
    const role = typeof (entry as { role?: unknown }).role === "string"
      ? (entry as { role: string }).role
      : "user";
    const raw = (entry as { content?: unknown }).content;
    if (typeof raw === "string") return [{ role, content: raw }];
    if (!Array.isArray(raw)) return [];
    const text = raw.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = (part as { text?: unknown }).text;
      return typeof candidate === "string" ? [candidate] : [];
    }).join("\n");
    return text ? [{ role, content: text }] : [];
  });
}

async function cpuCompletion(
  messages: Message[],
  id: string,
  created: number,
  session: string,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${BITNET_BASE_URL}/completion`, {
      method: "POST",
      headers: BITNET_HEADERS,
      body: JSON.stringify({
        messages,
        userId: `osaii_${session}`,
        chatId: `osaii_${session}`,
        device: "cpu",
      }),
      signal,
    });
  } catch (cause) {
    return unavailable("The BitNet demo CPU endpoint is unreachable.", cause);
  }
  if (!upstream.ok || !upstream.body) return upstreamFailure(upstream, "CPU");
  if (stream) return translateCpuStream(upstream.body, id, created);

  const content = await collectCpuStream(upstream.body);
  return completion(content, id, created, "cpu");
}

function translateCpuStream(body: ReadableStream<Uint8Array>, id: string, created: number): Response {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let ended = false;
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended) return controller.close();
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: BITNET_MODEL_ID,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })}\n\n`));
        return;
      }
      while (true) {
        const next = await reader.read();
        if (next.done) {
          if (buffer.trim()) emitCpuLine(buffer, controller, encoder, id, created);
          controller.enqueue(encoder.encode(openAiChunk(id, created, "", "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          ended = true;
          controller.close();
          return;
        }
        buffer += decoder.decode(next.value, { stream: true });
        let newline = buffer.indexOf("\n");
        let emitted = false;
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          emitted = emitCpuLine(line, controller, encoder, id, created) || emitted;
          newline = buffer.indexOf("\n");
        }
        if (emitted) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-osaii-bitnet-device": "cpu",
    },
  });
}

function emitCpuLine(
  line: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  id: string,
  created: number,
): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return false;
  try {
    const data = JSON.parse(trimmed.slice(5).trim()) as { finished?: unknown; content?: unknown };
    if (data.finished === true) return false;
    if (typeof data.content !== "string" || !data.content) return false;
    controller.enqueue(encoder.encode(openAiChunk(id, created, data.content, null)));
    return true;
  } catch {
    return false;
  }
}

async function collectCpuStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim().startsWith("data:")) return [];
    try {
      const data = JSON.parse(line.trim().slice(5).trim()) as { finished?: unknown; content?: unknown };
      return data.finished === true || typeof data.content !== "string" ? [] : [data.content];
    } catch {
      return [];
    }
  }).join("");
}

async function gpuCompletion(
  messages: Message[],
  id: string,
  created: number,
  session: string,
  signal?: AbortSignal,
): Promise<Response> {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  if (!latestUser) return error("A user message is required for Mini Fast Mode.", 400, "messages");
  const promptIndex = messages.lastIndexOf(latestUser);
  let submitted: Response;
  try {
    submitted = await fetch(`${BITNET_BASE_URL}/completion`, {
      method: "POST",
      headers: BITNET_HEADERS,
      body: JSON.stringify({
        messages: { prompt: latestUser.content, history: messages.slice(0, promptIndex) },
        userId: `osaii_${session}`,
        chatId: `osaii_${session}`,
        device: "gpu",
      }),
      signal,
    });
  } catch (cause) {
    return unavailable("The BitNet demo GPU endpoint is unreachable.", cause);
  }
  if (!submitted.ok) return upstreamFailure(submitted, "GPU");
  const accepted: { request_id?: unknown } = await submitted
    .json<{ request_id?: unknown }>()
    .catch(() => ({}));
  if (typeof accepted.request_id !== "string" || !accepted.request_id)
    return error("The BitNet demo did not return a GPU request ID.", 502, null, "invalid_upstream_response");

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return error("The request was cancelled.", 499, null, "request_cancelled");
    let result: Response;
    try {
      result = await fetch(`${BITNET_BASE_URL}/gpuresult/${encodeURIComponent(accepted.request_id)}`, {
        headers: BITNET_HEADERS,
        signal,
      });
    } catch (cause) {
      return unavailable("Polling the BitNet demo GPU result failed.", cause);
    }
    if (!result.ok) return upstreamFailure(result, "GPU polling");
    const payload: {
      status?: unknown;
      data?: { response?: unknown };
    } = await result.json<{
      status?: unknown;
      data?: { response?: unknown };
    }>().catch(() => ({}));
    if (payload.status === "complete") {
      if (typeof payload.data?.response !== "string")
        return error("The BitNet demo completed without a text response.", 502, null, "invalid_upstream_response");
      const response = completion(payload.data.response, id, created, "gpu");
      response.headers.set("x-osaii-streaming-disabled", "upstream-bitnet-demo-gpu");
      return response;
    }
    // The Python client polls every 250 ms. A Worker invocation has a bounded
    // subrequest budget, so preserve the same polling protocol at a 2-second
    // cadence (at most 45 result fetches in the 90-second window).
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return error("The BitNet demo GPU job did not finish within 90 seconds.", 504, null, "upstream_timeout");
}

function completion(content: string, id: string, created: number, device: "cpu" | "gpu"): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: BITNET_MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  }), { headers: { ...JSON_HEADERS, "x-osaii-bitnet-device": device } });
}

function openAiChunk(id: string, created: number, content: string, finishReason: "stop" | null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model: BITNET_MODEL_ID,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

async function upstreamFailure(response: Response, path: string): Promise<Response> {
  const detail = (await response.text()).trim().slice(0, 500);
  return error(
    `The BitNet demo ${path} request failed with status ${response.status}${detail && !detail.startsWith("<") ? `: ${detail}` : "."}`,
    502,
    null,
    "bitnet_demo_error",
  );
}

function unavailable(message: string, cause: unknown): Response {
  const suffix = cause instanceof Error && cause.message ? ` ${cause.message}` : "";
  return error(`${message}${suffix}`.slice(0, 700), 503, null, "bitnet_demo_unavailable");
}

function error(message: string, status: number, param: string | null, code: string | null = null): Response {
  return new Response(JSON.stringify({
    error: { message, type: status >= 500 ? "server_error" : "invalid_request_error", param, code },
  }), { status, headers: JSON_HEADERS });
}
