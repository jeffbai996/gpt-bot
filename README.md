# gpt-discord-bot

OpenAI-backed Discord bot. Standalone TypeScript daemon. Sibling project to [gem-discord-bot](https://github.com/jeffbai996/gem-discord-bot) — same shape, different brain, designed to coexist in the same guild without looping.

> **Status:** v0.11 — sister-repo parity sync. See [CHANGELOG.md](./CHANGELOG.md) for the per-epoch breakdown.

## What it does

- **Chat** in allowlisted Discord channels. Per-channel model switch between `gpt-5.5` (default), `gpt-5.4-mini`, `o3`. Reasoning effort tunable for the o-series.
- **Streaming** replies edit a `💭 thinking…` placeholder in place as tokens arrive.
- **Multimodal** — images via OpenAI vision; audio transcribed via whisper; text/code files inlined; PDFs / video surfaced as `[attachments not ingested]` so the model knows about them.
- **Tools** — `fetch_url` (with SSRF guard, Readability extraction), `web_search` (via search-preview model side-call), `search_memory` (semantic recall over channel history), and any MCP server's tools (auto-registered via streamable-HTTP).
- **Lifecycle reactions** — `👀 received → 🤔 thinking → ✅ replied`, with branches for `📎 ingesting`, `🧠 reasoning` (o-series + gpt-5 CoT summary), `🌐 searching`, `🔧 tooling`, `✂️ truncated`, `🛑 blocked`, `⚠️ denied`, `❌ errored`.
- **Reaction-driven actions** — user reactions on the bot's replies trigger 🔁 regenerate, 🔍 expand, 📌 pin (per-channel pinned-facts file injected into system prompt), ❌ delete, 🔇/🔊 mute toggle, ✏️ edit-on-next-message.
- **Persistent semantic memory** — every allowed user message gets embedded (`text-embedding-3-small`) and stored in sqlite-vss. Background summarization rolls older messages into a per-channel summary that sits above the active history in the system prompt.

## What makes this different from gem-discord-bot

Same architectural pattern, different model family. Two bots can run in the same guild without double-replies — both ignore each other via `message.author.bot`.

Use this one when you want OpenAI's reasoning models or its specific tool-use shape. Use gem when you want Gemini's native multimodal grounding or long-context behavior.

## Getting started

```bash
git clone <this-repo>
cd gpt-discord-bot
npm install
cp .env.example ~/.gpt/channels/discord/.env
# Fill in OPENAI_API_KEY, DISCORD_BOT_TOKEN, DISCORD_APP_ID
npm run start
```

State (allowlist, persona, embeddings DB, summaries, pinned facts) lives at `~/.gpt/channels/discord/` by default. Override with `GPT_STATE_DIR`.

### Slash commands

- `/gpt allow <user>` — add a user to the allowlist.
- `/gpt revoke <user>` — remove access.
- `/gpt channel <channel> <enabled> <require_mention>` — configure channel access.
- `/gpt persona <filename>` — hot-swap the persona file (loaded from state dir).
- `/gpt set <flag> <value> [<channel>]` — per-channel `model`, `reasoning`, `show_code`, or `verbose`.
- `/gpt compact [<channel>]` — force a context-summary rollup now.

SIGHUP reloads `access.json` and `persona.md` without a restart.

### Runtime

- Node.js 22+ recommended. Native modules (`better-sqlite3`, `sqlite-vss`, `jsdom`) gracefully degrade on older versions: the bot still runs, just without the affected feature (RAG / HTML extraction).
- Designed to run as a systemd user service. Hot-reload of access + persona via SIGHUP.

## Tests

```bash
node --test --import tsx tests/*.test.ts
```

66/67 passing on the dev box (1 skipped — Node 18 ABI mismatch on the jsdom-touching HTML extraction test).

## License

MIT — see [LICENSE](./LICENSE).
