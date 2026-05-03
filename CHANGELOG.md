# Changelog

Versioning is `0.MAJOR` (no patch level). Each version reflects a shippable feature epoch; intermediate fixes fold into the surrounding range. Pre-1.0 — breaking changes possible between minors until the public API stabilizes.

Tags are annotated; check them out with `git checkout v0.N` to inspect that point.

---

## v0.1 — initial scaffold

Repo skeleton — no runtime code yet. Establishes the project shape that subsequent versions extend.

- `package.json` with `discord.js`, `openai`, `dotenv`, `tsx`.
- `tsconfig.json` matching the sibling gem-discord-bot conventions (ESNext, strict, Bundler resolution).
- `.gitignore` covering `node_modules`, `.env*`, runtime state files (`persona.md`, `access.json`), and internal-only doc directories.
- `.env.example` with the required env-var shape.
- MIT license, AGENTS.md context, README skeleton.
