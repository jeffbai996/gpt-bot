import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction } from 'discord.js'
import { AccessManager, type ReasoningEffort } from './access.ts'
import { PersonaLoader } from './persona.ts'

const ALLOWED_MODELS = ['gpt-5.5', 'gpt-5.4-mini', 'o3'] as const

export const gptCommand = new SlashCommandBuilder()
  .setName('gpt')
  .setDescription('Admin controls for the gpt bot')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s
    .setName('allow')
    .setDescription('Allow a user to interact with the bot')
    .addUserOption(o => o.setName('user').setDescription('The user to allow').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('revoke')
    .setDescription("Revoke a user's access to the bot")
    .addUserOption(o => o.setName('user').setDescription('The user to revoke').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('channel')
    .setDescription('Set bot access for a channel — enable + mention rule. Other flags via /gpt set.')
    .addChannelOption(o => o.setName('channel').setDescription('The channel to configure').setRequired(true))
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable bot in this channel').setRequired(true))
    .addBooleanOption(o => o.setName('require_mention').setDescription('Require explicit mention').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('persona')
    .setDescription('Hot-swap the bot persona file')
    .addStringOption(o => o.setName('filename').setDescription('The persona filename (e.g. persona.md)').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('compact')
    .setDescription('Force a context-summary rollup now, regardless of the message threshold')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('set')
    .setDescription('Set a per-channel flag (model, reasoning, show_code, verbose). Defaults to current channel.')
    .addStringOption(o => o
      .setName('flag')
      .setDescription('Which flag to set')
      .setRequired(true)
      .addChoices(
        { name: 'model — gpt-5.5 | gpt-5.4-mini | o3 (or "default" to clear)', value: 'model' },
        { name: 'reasoning — minimal | low | medium | high (o-series only)', value: 'reasoning' },
        { name: 'show_code — render tool-call artifacts', value: 'show_code' },
        { name: 'verbose — usage/finish_reason footer', value: 'verbose' },
      )
    )
    .addStringOption(o => o
      .setName('value')
      .setDescription('See flag choices for valid values.')
      .setRequired(true)
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )

export interface CommandDeps {
  // Optional — present only when the SQLite-backed summarization scheduler
  // wired up successfully. /gpt compact reports gracefully when null.
  summarizer: { runForChannel(channelId: string): Promise<{ messageCount: number } | null> } | null
}

export async function executeGptCommand(
  interaction: ChatInputCommandInteraction,
  access: AccessManager,
  persona: PersonaLoader,
  adminUserId: string | undefined,
  deps: CommandDeps = { summarizer: null }
) {
  if (adminUserId && interaction.user.id !== adminUserId) {
    return interaction.reply({ content: 'Unauthorized. You are not the designated bot admin.', ephemeral: true })
  }

  const subcommand = interaction.options.getSubcommand()

  try {
    if (subcommand === 'allow') {
      const targetUser = interaction.options.getUser('user', true)
      await access.allowUser(targetUser.id)
      return interaction.reply({ content: `✅ Access granted to ${targetUser.tag}.`, ephemeral: true })
    }

    if (subcommand === 'revoke') {
      const targetUser = interaction.options.getUser('user', true)
      await access.revokeUser(targetUser.id)
      return interaction.reply({ content: `✅ Access revoked for ${targetUser.tag}.`, ephemeral: true })
    }

    if (subcommand === 'channel') {
      const channel = interaction.options.getChannel('channel', true)
      const enabled = interaction.options.getBoolean('enabled', true)
      const requireMention = interaction.options.getBoolean('require_mention', true)
      await access.setChannel(channel.id, enabled, requireMention)
      const flags = access.channelFlags(channel.id)
      const modelDisplay = flags.model ?? '(default)'
      return interaction.reply({
        content: `✅ <#${channel.id}> configured. enabled=${enabled}, requireMention=${requireMention}. flags: model=${modelDisplay}, reasoning=${flags.reasoning}, showCode=${flags.showCode}, verbose=${flags.verbose} — change via \`/gpt set\`.`,
        ephemeral: true
      })
    }

    if (subcommand === 'persona') {
      const filename = interaction.options.getString('filename', true)
      await persona.load(filename)
      return interaction.reply({ content: `✅ Persona swapped to \`${filename}\`.`, ephemeral: true })
    }

    if (subcommand === 'compact') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved.', ephemeral: true })
      }
      if (!deps.summarizer) {
        return interaction.reply({ content: '⚠️ Summarization unavailable on this runtime (sqlite-vss / better-sqlite3 didn\'t load — usually means Node version too old).', ephemeral: true })
      }
      await interaction.deferReply({ ephemeral: true })
      try {
        const result = await deps.summarizer.runForChannel(channel.id)
        if (!result) {
          return interaction.editReply(`✅ <#${channel.id}> nothing new to summarize.`)
        }
        return interaction.editReply(`✅ <#${channel.id}> compacted ${result.messageCount} messages into the rolling summary.`)
      } catch (e: any) {
        return interaction.editReply(`❌ compact failed: ${e?.message ?? String(e)}`)
      }
    }

    if (subcommand === 'set') {
      const flag = interaction.options.getString('flag', true)
      const rawValue = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }

      try {
        let updated
        if (flag === 'model') {
          // "default" sentinel clears the per-channel override.
          if (rawValue === 'default' || rawValue === '') {
            updated = await access.setChannelFlags(channel.id, { model: null })
          } else if (!ALLOWED_MODELS.includes(rawValue as typeof ALLOWED_MODELS[number])) {
            return interaction.reply({
              content: `❌ \`model\` value must be one of: ${ALLOWED_MODELS.join(', ')} (or "default" to clear). Got \`${rawValue}\`.`,
              ephemeral: true
            })
          } else {
            updated = await access.setChannelFlags(channel.id, { model: rawValue })
          }
        } else if (flag === 'reasoning') {
          if (!['minimal', 'low', 'medium', 'high'].includes(rawValue)) {
            return interaction.reply({
              content: `❌ \`reasoning\` value must be one of: minimal, low, medium, high (got \`${rawValue}\`)`,
              ephemeral: true
            })
          }
          updated = await access.setChannelFlags(channel.id, { reasoning: rawValue as ReasoningEffort })
        } else if (flag === 'show_code' || flag === 'verbose') {
          const truthy = ['true', 't', 'yes', 'y', 'on', '1']
          const falsy = ['false', 'f', 'no', 'n', 'off', '0']
          let parsed: boolean
          if (truthy.includes(rawValue)) parsed = true
          else if (falsy.includes(rawValue)) parsed = false
          else {
            return interaction.reply({
              content: `❌ \`${flag}\` value must be true or false (got \`${rawValue}\`)`,
              ephemeral: true
            })
          }
          const fieldKey = flag === 'show_code' ? 'showCode' : 'verbose'
          updated = await access.setChannelFlags(channel.id, { [fieldKey]: parsed })
        } else {
          return interaction.reply({
            content: `❌ unknown flag \`${flag}\`. Choices: model, reasoning, show_code, verbose.`,
            ephemeral: true
          })
        }

        const modelDisplay = updated.model ?? '(default)'
        const summary = `model=${modelDisplay}, reasoning=${updated.reasoning}, showCode=${updated.showCode}, verbose=${updated.verbose}`
        return interaction.reply({
          content: `✅ <#${channel.id}> \`${flag}\` set. ${summary}`,
          ephemeral: true
        })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    return interaction.reply({ content: `❌ Unknown subcommand: ${subcommand}`, ephemeral: true })
  } catch (e: any) {
    if (interaction.replied || interaction.deferred) {
      return interaction.followUp({ content: `❌ Error: ${e.message}`, ephemeral: true })
    }
    return interaction.reply({ content: `❌ Error: ${e.message}`, ephemeral: true })
  }
}
