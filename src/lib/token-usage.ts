export type TokenUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
};

export type TokenTrackingOptions = {
  db: D1Database;
  ctx: ExecutionContext;
  request: Request;
  accountId?: number | null;
  surface: string;
  provider: string;
  model: string;
  path: string;
};

function finiteTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractTokenUsage(payload: unknown): TokenUsage | null {
  const root = objectValue(payload);
  if (!root) return null;
  const response = objectValue(root.response);
  const usage = objectValue(root.usage) ?? objectValue(response?.usage);
  if (!usage) return null;

  const promptDetails = objectValue(
    usage.prompt_tokens_details ?? usage.input_tokens_details ?? usage.inputTokenDetails,
  );
  const completionDetails = objectValue(
    usage.completion_tokens_details ?? usage.output_tokens_details ?? usage.outputTokenDetails,
  );
  const promptTokens = finiteTokenCount(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens,
  );
  const completionTokens = finiteTokenCount(
    usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens,
  );
  const reportedTotal = finiteTokenCount(
    usage.total_tokens ?? usage.totalTokens,
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal ?? (
      promptTokens !== null && completionTokens !== null
        ? promptTokens + completionTokens
        : null
    ),
    cachedTokens: finiteTokenCount(
      promptDetails?.cached_tokens ?? promptDetails?.cacheReadTokens,
    ),
    reasoningTokens: finiteTokenCount(
      completionDetails?.reasoning_tokens ?? completionDetails?.reasoningTokens,
    ),
  };
}

function usageFromHeaders(headers: Headers): TokenUsage | null {
  const read = (name: string) => {
    const raw = headers.get(name);
    return raw === null ? null : finiteTokenCount(Number(raw));
  };
  const usage = {
    promptTokens: read("x-osaii-usage-prompt-tokens"),
    completionTokens: read("x-osaii-usage-completion-tokens"),
    totalTokens: read("x-osaii-usage-total-tokens"),
    cachedTokens: read("x-osaii-usage-cached-tokens"),
    reasoningTokens: read("x-osaii-usage-reasoning-tokens"),
  };
  return Object.values(usage).some((value) => value !== null) ? usage : null;
}

const anonHashMemo = new WeakMap<object, string>();
async function anonymousHash(request: Request): Promise<string> {
  const memo = anonHashMemo.get(request as unknown as object);
  if (memo) return memo;
  const address = request.headers.get("cf-connecting-ip") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  const hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
  anonHashMemo.set(request as unknown as object, hash);
  return hash;
}

async function recordTokenUsage(
  options: TokenTrackingOptions,
  response: Response,
  usage: TokenUsage | null,
): Promise<void> {
  const accountId = options.accountId ?? null;
  const ipHash = accountId === null ? await anonymousHash(options.request) : null;
  await options.db.prepare(
    `INSERT INTO token_usage(
      account_id,ip_hash,surface,provider,model,path,status,streamed,
      prompt_tokens,completion_tokens,total_tokens,cached_tokens,reasoning_tokens,usage_reported
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    accountId,
    ipHash,
    options.surface.slice(0, 60),
    options.provider.slice(0, 60),
    options.model.slice(0, 200),
    options.path.slice(0, 300),
    response.status,
    (response.headers.get("content-type") || "").toLowerCase().includes("text/event-stream") ? 1 : 0,
    usage?.promptTokens ?? null,
    usage?.completionTokens ?? null,
    usage?.totalTokens ?? null,
    usage?.cachedTokens ?? null,
    usage?.reasoningTokens ?? null,
    usage ? 1 : 0,
  ).run();
}

function scheduleRecord(
  options: TokenTrackingOptions,
  response: Response,
  usage: TokenUsage | null,
): void {
  options.ctx.waitUntil(
    recordTokenUsage(options, response, usage).catch((error) => {
      console.error(JSON.stringify({
        event: "token_usage_write_failed",
        error: error instanceof Error ? error.message : String(error),
        surface: options.surface,
      }));
    }),
  );
}

function inspectSseLine(line: string): TokenUsage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const raw = trimmed.slice(5).trim();
  if (!raw || raw === "[DONE]") return null;
  try {
    return extractTokenUsage(JSON.parse(raw));
  } catch {
    return null;
  }
}

function trackedEventStream(
  response: Response,
  options: TokenTrackingOptions,
): Response {
  if (!response.body) {
    scheduleRecord(options, response, null);
    return response;
  }
  const [clientBody, accountingBody] = response.body.tee();
  options.ctx.waitUntil((async () => {
    const reader = accountingBody.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: TokenUsage | null = null;
    const inspectCompleteLines = () => {
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        usage = inspectSseLine(buffer.slice(0, newline)) ?? usage;
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        inspectCompleteLines();
      }
      buffer += decoder.decode();
      inspectCompleteLines();
      if (buffer) usage = inspectSseLine(buffer) ?? usage;
    } catch (error) {
      console.error(JSON.stringify({
        event: "token_usage_stream_read_failed",
        error: error instanceof Error ? error.message : String(error),
        surface: options.surface,
      }));
    }
    await recordTokenUsage(options, response, usage);
  })().catch((error) => {
    console.error(JSON.stringify({
      event: "token_usage_write_failed",
      error: error instanceof Error ? error.message : String(error),
      surface: options.surface,
    }));
  }));
  return new Response(clientBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Observe provider accounting without changing model output. Successful SSE
 * bodies are inspected incrementally; bounded JSON responses are cloned and
 * parsed after the client response has already been returned.
 */
export function trackTokenResponse(
  response: Response,
  options: TokenTrackingOptions,
): Response {
  if (!response.ok) return response;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    return trackedEventStream(response, options);
  }

  const headerUsage = usageFromHeaders(response.headers);
  if (headerUsage) {
    scheduleRecord(options, response, headerUsage);
    return response;
  }
  const clone = response.clone();
  options.ctx.waitUntil((async () => {
    const payload = contentType.includes("json")
      ? await clone.json().catch(() => null)
      : null;
    await recordTokenUsage(options, response, extractTokenUsage(payload));
  })().catch((error) => {
    console.error(JSON.stringify({
      event: "token_usage_write_failed",
      error: error instanceof Error ? error.message : String(error),
      surface: options.surface,
    }));
  }));
  return response;
}

export function providerForModel(model: string): string {
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : "chatgpt";
}
