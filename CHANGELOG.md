# Changelog

Versioning is `0.MAJOR` (no patch level). Each version reflects a shippable feature epoch; intermediate fixes fold into the surrounding range. Pre-1.0 — breaking changes possible between minors until the public API stabilizes.

Tags are annotated; check them out with `git checkout v0.N` to inspect that point.

---

## v0.2 — discord layer (echo-only, no LLM)

Builds the discord plumbing end-to-end without yet wiring up an OpenAI client. Lets you verify gateway, intents, allowlist, mention rules, slash-command admin flow, and chunking before any model spend.

- `AccessManager` — JSON-backed allowlist (users + channels), per-channel flags (`model`, `reasoning`, `showCode`, `verbose`). State at `~/.gpt/channels/discord/access.json`.
- `PersonaLoader` — reads `persona.md` from state dir, falls back to a default. Hot-swappable via `/gpt persona <filename>`.
- `chunk()` — splits replies under Discord's 2000-char limit, preserving fenced code blocks across split boundaries.
- Slash command `/gpt` with subcommands: `allow`, `revoke`, `channel`, `persona`, `set` (model | reasoning | show_code | verbose).
- `gpt.ts` entry — discord client with Guilds + GuildMessages + MessageContent intents, slash-command handler, message handler that echoes the request back with the resolved per-channel flags. Bot-vs-bot loop guard via `message.author.bot` check so this can coexist with sibling bots in the same channel.
- SIGHUP reload of `access.json` + `persona.md` (no full restart).
- Tests for `chunk` and `AccessManager` under `node --test`.

## v0.1 — initial scaffold

Repo skeleton — no runtime code yet. Establishes the project shape that subsequent versions extend.

- `package.json` with `discord.js`, `openai`, `dotenv`, `tsx`.
- `tsconfig.json` matching the sibling gem-discord-bot conventions (ESNext, strict, Bundler resolution).
- `.gitignore` covering `node_modules`, `.env*`, runtime state files (`persona.md`, `access.json`), and internal-only doc directories.
- `.env.example` with the required env-var shape.
- MIT license, AGENTS.md context, README skeleton.
