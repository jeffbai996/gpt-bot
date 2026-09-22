// Must be the first import of the entry file: shared modules read their
// env namespace at load time (see squad-bot-kit/env.ts).
process.env.SQUAD_BOT_ENV_PREFIX ??= 'GPT'
