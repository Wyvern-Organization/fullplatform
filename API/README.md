# OSAII API

The Worker exposes an OpenAI-compatible Poolside gateway at:

`https://osaii.wyvernhub.net/api/v1`

Supported endpoints:

- `GET /models`
- `POST /chat/completions` (including streaming, tools/function calling,
  structured outputs, reasoning, and multi-turn tool-result messages)
- Any other model request endpoint offered by Poolside under `/v1` (for example,
  the legacy `/completions` endpoint) is transparently forwarded when it has a
  `model` field.

The gateway queries Poolside's model endpoint before each completion and rejects models that are not available to the configured Poolside account.

Selected Logfare models are available with the `logfare/` prefix. Requests that
reference an under-18 person are rejected before leaving OSAII; use Poolside for
those non-Logfare requests.

The public gateway has lightweight per-client limits per Worker edge instance:

- Laguna XS: 30 requests/minute
- Mini (Preview): unlimited on its normal streaming CPU path; Fast Mode uses a separate GPU fair-use bucket (5 RPM / 30 RPH / 100 RPD for guests; 10 RPM / 100 RPH / 300 RPD for keyed accounts)
- Laguna S and any other model: 15 requests/minute
- All models combined: 300 requests/hour and 1,000 requests/day

Responses include rate-limit headers for each window.

Studio also offers an optional browser-side “Sign in with ChatGPT” connection
using `@openai-oauth/web`. The OAuth session stays encrypted in the user’s
browser; OSAII receives request-bound credentials only. Signed-in users can
discover their account’s Codex models and use `/studio/api/chatgpt/models`,
`/chat/completions`, `/responses`, `/images/generations`, and `/images/edits`.
Fast, Smart, and Logfare Advanced models remain available alongside Codex.

Successful non-streaming completions also expose token accounting headers such
as `x-osaii-usage-cached-tokens` and `x-osaii-usage-reasoning-tokens`. If a
short reasoning budget ends before visible output, the gateway keeps the 200
response and adds `x-osaii-completion-warning: reasoning_budget_exhausted` with
a retry instruction in `message.content`; hidden reasoning is never used as a
substitute for the answer.
