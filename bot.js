require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const scraper = require('./scraper');
const storage = require('./storage');
const scheduler = require('./scheduler');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ]
});

// ─── Slash Command Definitions ────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('setleague')
    .setDescription('Set the Music League URL for this server')
    .addStringOption(opt =>
      opt.setName('url')
        .setDescription('The Music League URL (e.g. https://app.musicleague.com/l/xxxx/)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('league')
    .setDescription('Show the current Music League info and active round'),

  new SlashCommandBuilder()
    .setName('remind')
    .setDescription('Set a reminder for submissions or voting')
    .addStringOption(opt =>
      opt.setName('type')
        .setDescription('What to remind about')
        .setRequired(true)
        .addChoices(
          { name: 'Submission deadline', value: 'submission' },
          { name: 'Voting deadline', value: 'voting' },
          { name: 'Both', value: 'both' },
        ))
    .addStringOption(opt =>
      opt.setName('datetime')
        .setDescription('When is the deadline? (e.g. "2024-12-25 18:00" in your local time or ISO format)')
        .setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('remind_before')
        .setDescription('How many minutes before the deadline to send the reminder (default: 60)')
        .setRequired(false)),

  new SlashCommandBuilder()
    .setName('reminders')
    .setDescription('List all active reminders for this server'),

  new SlashCommandBuilder()
    .setName('cancelreminder')
    .setDescription('Cancel a reminder by its ID')
    .addStringOption(opt =>
      opt.setName('id')
        .setDescription('The reminder ID (from /reminders)')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the channel where reminders and league updates are posted')
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('The channel to use')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('fetch')
    .setDescription('Manually fetch and display the latest round info from Music League'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show help for the Music League bot'),
];

// ─── Register Commands ────────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
      body: commands.map(c => c.toJSON()),
    });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildLeagueEmbed(leagueData) {
  const embed = new EmbedBuilder()
    .setColor(0x9E00C4) // Music League's brand purple
    .setTitle(`🎵 ${leagueData.name || 'Music League'}`)
    .setURL(leagueData.url);

  // League stats line
  const statParts = [];
  if (leagueData.totalRounds) statParts.push(`${leagueData.totalRounds} rounds`);
  if (leagueData.songsPerRound) statParts.push(`${leagueData.songsPerRound} song/round`);
  if (leagueData.currentPlayers) statParts.push(`${leagueData.currentPlayers}/${leagueData.maxPlayers ?? '?'} players`);
  if (leagueData.privacy) statParts.push(leagueData.privacy);
  if (leagueData.speed) statParts.push(`⚡ ${leagueData.speed}`);
  if (statParts.length) embed.setDescription(statParts.join(' • '));

  // Active round
  const active = leagueData.activeRound;
  if (active) {
    const roundParts = [];
    if (active.name) roundParts.push(`**${active.name}**`);
    if (active.theme) roundParts.push(`🎨 ${active.theme}`);
    if (active.status) roundParts.push(active.status);
    if (roundParts.length) {
      embed.addFields({ name: '🎧 Active Round', value: roundParts.join('\n'), inline: false });
    }

    // Deadlines from active round
    if (active.submissionDeadline) {
      const d = new Date(active.submissionDeadline);
      const val = isNaN(d) ? active.submissionDeadline : `<t:${Math.floor(d/1000)}:F> (<t:${Math.floor(d/1000)}:R>)`;
      embed.addFields({ name: '📤 Submission Deadline', value: val, inline: false });
    }
    if (active.votingDeadline) {
      const d = new Date(active.votingDeadline);
      const val = isNaN(d) ? active.votingDeadline : `<t:${Math.floor(d/1000)}:F> (<t:${Math.floor(d/1000)}:R>)`;
      embed.addFields({ name: '🗳️ Voting Deadline', value: val, inline: false });
    }
  } else if (leagueData.rounds?.length) {
    embed.addFields({ name: '📋 Rounds', value: `${leagueData.rounds.length} round(s) found, none currently active`, inline: false });
  }

  // Top 3 standings
  if (leagueData.standings?.length) {
    const medals = ['🥇', '🥈', '🥉'];
    const top = leagueData.standings.slice(0, 3)
      .map((s, i) => `${medals[i] || `${i+1}.`} **${s.name}**${s.points != null ? ` — ${s.points} pts` : ''}`)
      .join('\n');
    embed.addFields({ name: '🏆 Standings (Top 3)', value: top, inline: false });
  }

  // Members
  if (leagueData.members?.length) {
    const adminNames = leagueData.members.filter(m => m.isAdmin).map(m => m.name).join(', ');
    if (adminNames) embed.addFields({ name: '👑 Admin', value: adminNames, inline: true });
  }

  embed.setFooter({ text: 'Music League Bot • musicleague.com' });
  embed.setTimestamp();
  return embed;
}

function parseDateTime(input) {
  // Try ISO format first
  let d = new Date(input);
  if (!isNaN(d)) return d;

  // Try "YYYY-MM-DD HH:mm"
  const match = input.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (match) {
    d = new Date(`${match[1]}T${match[2]}:00`);
    if (!isNaN(d)) return d;
  }
  return null;
}

// ─── Interaction Handler ──────────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  const { commandName } = interaction;

  // /help
  if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🎵 Music League Bot — Help')
      .setDescription('Integrate Music League with your Discord server. Since Music League has no public API, this bot scrapes the league page for info.')
      .addFields(
        { name: '/setleague <url>', value: 'Set the Music League URL for this server.' },
        { name: '/league', value: 'Show current league info and round.' },
        { name: '/fetch', value: 'Re-fetch the latest data from the league page.' },
        { name: '/setchannel <#channel>', value: 'Set where reminders and updates are posted.' },
        { name: '/remind <type> <datetime> [remind_before]', value: 'Schedule a reminder for submissions or voting. Datetime format: `2024-12-25 18:00` or ISO 8601.' },
        { name: '/reminders', value: 'List all active reminders.' },
        { name: '/cancelreminder <id>', value: 'Cancel a reminder by ID.' },
      )
      .addFields({
        name: '⚠️ Note on Scraping',
        value: 'Music League requires login to view league details. If your league is private, the bot may only show limited public info. You can manually set deadlines using `/remind`.'
      })
      .setFooter({ text: 'Music League Bot' });
    return interaction.reply({ embeds: [embed] });
  }

  // /setchannel
  if (commandName === 'setchannel') {
    const channel = interaction.options.getChannel('channel');
    storage.setGuildConfig(guildId, { notifyChannelId: channel.id });
    return interaction.reply({ content: `✅ Reminders and updates will be posted in <#${channel.id}>.`, ephemeral: true });
  }

  // /setleague
  if (commandName === 'setleague') {
    const url = interaction.options.getString('url');
    if (!url.includes('musicleague.com')) {
      return interaction.reply({ content: '❌ That doesn\'t look like a Music League URL. Please use a URL from `musicleague.com`.', ephemeral: true });
    }
    storage.setGuildConfig(guildId, { leagueUrl: url });
    await interaction.reply({ content: `⏳ League URL saved! Attempting to fetch info...` });

    try {
      const data = await scraper.fetchLeague(url);
      storage.setGuildConfig(guildId, { leagueCache: data, lastFetched: Date.now() });
      const embed = buildLeagueEmbed({ ...data, url });
      await interaction.editReply({ content: '✅ League set!', embeds: [embed] });
    } catch (err) {
      await interaction.editReply({
        content: `✅ League URL saved, but couldn't auto-fetch data: \`${err.message}\`\n\nThis is expected if your league is private — use \`/remind\` to set deadlines manually.`
      });
    }
    return;
  }

  // /league
  if (commandName === 'league') {
    const config = storage.getGuildConfig(guildId);
    if (!config?.leagueUrl) {
      return interaction.reply({ content: '❌ No league set. Use `/setleague <url>` first.', ephemeral: true });
    }
    if (config.leagueCache) {
      const embed = buildLeagueEmbed({ ...config.leagueCache, url: config.leagueUrl });
      const age = config.lastFetched ? Math.round((Date.now() - config.lastFetched) / 60000) : '?';
      return interaction.reply({ content: `*Last fetched ${age} min ago. Use \`/fetch\` to refresh.*`, embeds: [embed] });
    }
    return interaction.reply({ content: `League URL: <${config.leagueUrl}>\n\nNo cached data yet — use \`/fetch\` to load info.` });
  }

  // /fetch
  if (commandName === 'fetch') {
    const config = storage.getGuildConfig(guildId);
    if (!config?.leagueUrl) {
      return interaction.reply({ content: '❌ No league set. Use `/setleague <url>` first.', ephemeral: true });
    }
    await interaction.reply({ content: '⏳ Fetching league data...' });
    try {
      const data = await scraper.fetchLeague(config.leagueUrl);
      storage.setGuildConfig(guildId, { leagueCache: data, lastFetched: Date.now() });
      const embed = buildLeagueEmbed({ ...data, url: config.leagueUrl });
      await interaction.editReply({ content: '✅ Fetched!', embeds: [embed] });
    } catch (err) {
      await interaction.editReply({
        content: `❌ Failed to fetch: \`${err.message}\`\n\nIf your league is private/requires login, scraping won't work. Use \`/remind\` to set deadlines manually.`
      });
    }
    return;
  }

  // /remind
  if (commandName === 'remind') {
    const type = interaction.options.getString('type');
    const datetimeStr = interaction.options.getString('datetime');
    const remindBefore = interaction.options.getInteger('remind_before') ?? 60;

    const deadline = parseDateTime(datetimeStr);
    if (!deadline) {
      return interaction.reply({
        content: '❌ Couldn\'t parse that date. Try formats like `2024-12-25 18:00` or `2024-12-25T18:00:00Z`.',
        ephemeral: true
      });
    }

    const remindAt = new Date(deadline.getTime() - remindBefore * 60000);
    if (remindAt <= new Date()) {
      return interaction.reply({ content: '❌ That reminder time is in the past!', ephemeral: true });
    }

    const config = storage.getGuildConfig(guildId);
    const channelId = config?.notifyChannelId || interaction.channelId;

    const labels = { submission: 'Submission', voting: 'Voting', both: 'Submission & Voting' };
    const emojis = { submission: '📤', voting: '🗳️', both: '📤🗳️' };

    const reminderId = scheduler.addReminder({
      guildId,
      channelId,
      type,
      deadline: deadline.toISOString(),
      remindAt: remindAt.toISOString(),
      label: labels[type],
      emoji: emojis[type],
    }, client);

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('⏰ Reminder Set!')
      .addFields(
        { name: 'Type', value: `${emojis[type]} ${labels[type]}`, inline: true },
        { name: 'ID', value: `\`${reminderId}\``, inline: true },
        { name: 'Deadline', value: `<t:${Math.floor(deadline.getTime() / 1000)}:F>`, inline: false },
        { name: 'Reminder Fires', value: `<t:${Math.floor(remindAt.getTime() / 1000)}:R>`, inline: false },
        { name: 'Channel', value: `<#${channelId}>`, inline: true },
      )
      .setFooter({ text: `Cancel with /cancelreminder ${reminderId}` });

    return interaction.reply({ embeds: [embed] });
  }

  // /reminders
  if (commandName === 'reminders') {
    const reminders = scheduler.getReminders(guildId);
    if (!reminders.length) {
      return interaction.reply({ content: '📋 No active reminders. Use `/remind` to set one.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⏰ Active Reminders')
      .setDescription(reminders.map(r => {
        const deadlineTs = Math.floor(new Date(r.deadline).getTime() / 1000);
        const remindTs = Math.floor(new Date(r.remindAt).getTime() / 1000);
        return `**ID:** \`${r.id}\` • ${r.emoji} ${r.label}\n📅 Deadline: <t:${deadlineTs}:F>\n🔔 Fires: <t:${remindTs}:R>\n📢 <#${r.channelId}>`;
      }).join('\n\n'));

    return interaction.reply({ embeds: [embed] });
  }

  // /cancelreminder
  if (commandName === 'cancelreminder') {
    const id = interaction.options.getString('id');
    const success = scheduler.cancelReminder(guildId, id);
    if (success) {
      return interaction.reply({ content: `✅ Reminder \`${id}\` cancelled.` });
    } else {
      return interaction.reply({ content: `❌ No reminder found with ID \`${id}\`.`, ephemeral: true });
    }
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
  scheduler.restoreReminders(client);
});

client.login(process.env.DISCORD_TOKEN);