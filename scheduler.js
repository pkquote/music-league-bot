/**
 * scheduler.js
 * Manages in-memory setTimeout timers for reminders,
 * backed by persistent storage so they survive restarts.
 */

const { EmbedBuilder } = require('discord.js');
const storage = require('./storage');
const { randomUUID } = require('crypto');

// Map of reminderId -> timeoutHandle
const activeTimers = new Map();

function buildReminderEmbed(reminder, config) {
  const deadlineTs = Math.floor(new Date(reminder.deadline).getTime() / 1000);
  const leagueUrl = config?.leagueUrl;
  const leagueName = config?.leagueCache?.name || 'your Music League';

  const embed = new EmbedBuilder()
    .setColor(reminder.type === 'voting' ? 0xEB459E : 0xFEE75C)
    .setTitle(`${reminder.emoji} ${reminder.label} Deadline Reminder!`)
    .setDescription(`⏰ The **${reminder.label}** deadline for **${leagueName}** is coming up!`)
    .addFields(
      { name: '📅 Deadline', value: `<t:${deadlineTs}:F> (<t:${deadlineTs}:R>)`, inline: false },
    );

  if (leagueUrl) {
    embed.addFields({ name: '🔗 League Link', value: leagueUrl, inline: false });
  }

  const tips = {
    submission: '🎵 Make sure you\'ve submitted your song before the deadline!',
    voting: '🗳️ Don\'t forget to listen and vote for your favorites!',
    both: '🎵 Submit your song AND vote before the deadline!',
  };
  embed.addFields({ name: '💡 Tip', value: tips[reminder.type] || '' });
  embed.setFooter({ text: `Reminder ID: ${reminder.id} • Cancel with /cancelreminder ${reminder.id}` });
  embed.setTimestamp();
  return embed;
}

/**
 * Schedule a reminder timer.
 */
function scheduleTimer(reminder, client) {
  const now = Date.now();
  const fireAt = new Date(reminder.remindAt).getTime();
  const delay = fireAt - now;

  if (delay <= 0) {
    // Already past — remove it
    storage.removeReminder(reminder.id);
    activeTimers.delete(reminder.id);
    return;
  }

  // Max setTimeout is ~24.8 days; for longer delays, reschedule
  const MAX_DELAY = 2147483647; // ~24.8 days
  if (delay > MAX_DELAY) {
    // Re-check in 24 days
    const handle = setTimeout(() => scheduleTimer(reminder, client), MAX_DELAY);
    activeTimers.set(reminder.id, handle);
    return;
  }

  const handle = setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(reminder.channelId);
      if (channel) {
        const guildStorage = require('./storage');
        const config = guildStorage.getGuildConfig(reminder.guildId);
        const embed = buildReminderEmbed(reminder, config);
        await channel.send({ content: '@everyone', embeds: [embed] });
      }
    } catch (err) {
      console.error(`Failed to send reminder ${reminder.id}:`, err.message);
    } finally {
      // Remove from storage and active timers
      storage.removeReminder(reminder.id);
      activeTimers.delete(reminder.id);
    }
  }, delay);

  activeTimers.set(reminder.id, handle);
}

/**
 * Add a new reminder (called from bot.js).
 */
function addReminder(opts, client) {
  const id = randomUUID().slice(0, 8);
  const reminder = { id, ...opts };
  storage.addReminder(reminder);
  scheduleTimer(reminder, client);
  return id;
}

/**
 * Cancel a reminder.
 */
function cancelReminder(guildId, id) {
  const reminders = storage.getRemindersForGuild(guildId);
  const reminder = reminders.find(r => r.id === id);
  if (!reminder) return false;

  if (activeTimers.has(id)) {
    clearTimeout(activeTimers.get(id));
    activeTimers.delete(id);
  }
  storage.removeReminder(id);
  return true;
}

/**
 * Get active reminders for a guild (excluding past ones).
 */
function getReminders(guildId) {
  const now = new Date();
  return storage.getRemindersForGuild(guildId).filter(r => new Date(r.remindAt) > now);
}

/**
 * On bot startup, restore all saved reminders.
 */
function restoreReminders(client) {
  const all = storage.getAllReminders();
  const now = new Date();
  let restored = 0;
  let expired = 0;

  for (const reminder of all) {
    if (new Date(reminder.remindAt) <= now) {
      // Expired while bot was offline — remove silently
      storage.removeReminder(reminder.id);
      expired++;
    } else {
      scheduleTimer(reminder, client);
      restored++;
    }
  }

  console.log(`⏰ Restored ${restored} reminder(s), removed ${expired} expired.`);
}

module.exports = { addReminder, cancelReminder, getReminders, restoreReminders };