import { afterEach, expect, test } from "bun:test";
import { poolsideModelRequest } from "../API/poolside.ts";

const LAGUNA = "community/YoannDev90/poolside-laguna-s-2.1:free";
const LLAMA = "community/ZapGaming/llama3.1-8b-xturbo";
const originalFetch = globalThis.fetch;

type CatalogModelOptions = {
  readonly prices?: Readonly<Record<string, string>>;
  readonly tools?: boolean;
  readonly capabilities?: readonly string[];
};

function catalogModel(id: string, options: CatalogModelOptions = {}) {
  const prices = options.prices ?? {};
  const tools = options.tools ?? false;
  const capabilities = options.capabilities ?? [];
  return {
    id,
    community: true,
    category: "text",
    paid_only: false,
    health: { status: "healthy" },
    pricing: { currency: "pollen", ...prices },
    input_modalities: ["text"],
    supported_endpoints: ["/v1/chat/completions"],
    capabilities,
    tools,
  };
}

type GatewayOptions = {
  readonly catalogModels: readonly unknown[];
  readonly body: Readonly<Record<string, unknown>>;
  readonly pollinationsKey?: string | null;
  readonly primaryStatus?: number;
};

async function callGateway(options: GatewayOptions) {
  const catalogModels = options.catalogModels;
  const body = options.body;
  const pollinationsKey = options.pollinationsKey === undefined ? "test-key" : options.pollinationsKey;
  const primaryStatus = options.primaryStatus ?? 503;
  const pollinationsModels: string[] = [];
  let catalogRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "https://inference.poolside.ai/v1/chat/completions") {
      return new Response(JSON.stringify({ error: { message: "primary unavailable" } }), { status: primaryStatus });
    }
    if (url === "https://gen.pollinations.ai/v1/models?source=community") {
      catalogRequests += 1;
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return Response.json({ data: catalogModels });
    }
    if (url === "https://gen.pollinations.ai/v1/chat/completions") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      const payload: unknown = JSON.parse(String(init?.body));
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Expected a JSON object in the Pollinations request body");
      }
      const model = Reflect.get(payload, "model");
      expect(typeof model).toBe("string");
      pollinationsModels.push(typeof model === "string" ? model : "");
      return Response.json({
        id: "chatcmpl-fallback",
        model,
        choices: [{ message: { role: "assistant", content: "fallback answer" }, finish_reason: "stop" }],
      });
    }
    throw new Error(`Unexpected request to ${url}`);
  };

  const response = await poolsideModelRequest(
    new Request("https://osaii.example/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ model: "poolside/laguna-s-2.1", ...body }),
    }),
    { POOLSIDE_API_KEY: "test-poolside-key", ...(pollinationsKey ? { POLLINATIONS_API_KEY: pollinationsKey } : {}) },
    "/chat/completions",
    { safetyAlreadyChecked: true, modelAlreadyValidated: true, finalOutputSafety: false },
  );
  return { response, pollinationsModels, catalogRequests };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("uses a healthy free community model with tool support after a retryable Poolside failure", async () => {
  const result = await callGateway({
    catalogModels: [
      catalogModel(LAGUNA, { tools: true, capabilities: ["tool_calling", "reasoning"] }),
      catalogModel(LLAMA),
    ],
    body: {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    },
  });

  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("x-osaii-fallback-provider")).toBe("pollinations");
  expect(result.response.headers.get("x-osaii-fallback-model")).toBe(LAGUNA);
  expect(result.pollinationsModels).toEqual([LAGUNA]);
  expect(result.catalogRequests).toBe(1);
});

test("skips a community model as soon as its live catalog price is nonzero", async () => {
  const result = await callGateway({
    catalogModels: [
      catalogModel(LAGUNA, { prices: { promptTextTokens: "0.000001" }, tools: true, capabilities: ["tool_calling"] }),
      catalogModel(LLAMA),
    ],
    body: { messages: [{ role: "user", content: "hello" }] },
  });

  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("x-osaii-fallback-model")).toBe(LLAMA);
  expect(result.pollinationsModels).toEqual([LLAMA]);
});

test("returns the primary provider error when the live catalog has no free candidate", async () => {
  const result = await callGateway({
    catalogModels: [
      catalogModel(LAGUNA, { prices: { promptTextTokens: "0.000001" }, tools: true, capabilities: ["tool_calling"] }),
      catalogModel(LLAMA, { prices: { completionTextTokens: "0.000001" } }),
    ],
    body: { messages: [{ role: "user", content: "hello" }] },
  });

  expect(result.response.status).toBe(503);
  expect(result.response.headers.get("x-osaii-fallback-provider")).toBeNull();
  expect(result.pollinationsModels).toEqual([]);
});

test("does not attempt Pollinations when its runtime key is absent", async () => {
  const result = await callGateway({
    catalogModels: [catalogModel(LAGUNA, { tools: true, capabilities: ["tool_calling"] })],
    body: { messages: [{ role: "user", content: "hello" }] },
    pollinationsKey: null,
  });

  expect(result.response.status).toBe(503);
  expect(result.catalogRequests).toBe(0);
  expect(result.pollinationsModels).toEqual([]);
});

test("does not route a client error through the fallback provider", async () => {
  const result = await callGateway({
    catalogModels: [catalogModel(LAGUNA, { tools: true, capabilities: ["tool_calling"] })],
    body: { messages: [{ role: "user", content: "hello" }] },
    primaryStatus: 400,
  });

  expect(result.response.status).toBe(400);
  expect(result.catalogRequests).toBe(0);
  expect(result.pollinationsModels).toEqual([]);
});
