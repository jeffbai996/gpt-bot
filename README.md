# gpt-discord-bot

OpenAI-backed Discord bot. Standalone TypeScript daemon. Sibling project to [gem-discord-bot](https://github.com/) — same shape, different brain.

> **Status:** v0.1 scaffold. No runtime code yet. See [CHANGELOG.md](./CHANGELOG.md) for the planned epochs.

## What it will do (when built out)

- Chat in allowlisted Discord channels using `gpt-5.5` by default.
- Per-channel model switch between `gpt-5.5`, `gpt-5.4-mini`, `o3`.
- Multimodal input — images, audio, documents.
- Tool use — web search, URL fetch, semantic memory over channel history, optional MCP integrations.
- Lifecycle reactions on user messages (`👀 → 🤔 → ✅`) so the bot is legible while it thinks.
- Reaction-driven actions on its own replies (regenerate, expand, pin, delete, mute, edit).

## What makes this different from gem-discord-bot

Same architectural pattern, different model family. Designed to run alongside gem in the same guild without double-replies — both bots ignore each other via `message.author.bot`.

Use this one when you want OpenAI's reasoning models (o3) or its specific tool-use shape (Responses API + function calling). Use gem when you want Gemini's native multimodal grounding or long-context behavior.

## Getting started

```bash
git clone <this-repo>
cd gpt-discord-bot
npm install
cp .env.example .env  # fill in OPENAI_API_KEY, DISCORD_BOT_TOKEN, DISCORD_APP_ID
npm run start
```

State lives in `~/.gpt/channels/discord/` by default. Override with `GPT_STATE_DIR`.

## License

MIT — see [LICENSE](./LICENSE).
