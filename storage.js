/**
 * storage.js
 * Simple JSON-based persistence for guild configs and reminders.
 * For production, swap this out for a database like SQLite or PostgreSQL.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'guilds.json');
const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Guild Configs ────────────────────────────────────────────────────────────

function loadConfigs() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfigs(configs) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
}

function getGuildConfig(guildId) {
  const configs = loadConfigs();
  return configs[guildId] || null;
}

function setGuildConfig(guildId, updates) {
  const configs = loadConfigs();
  configs[guildId] = { ...(configs[guildId] || {}), ...updates };
  saveConfigs(configs);
  return configs[guildId];
}

// ─── Reminders ────────────────────────────────────────────────────────────────

function loadReminders() {
  try {
    return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveReminders(reminders) {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
}

function addReminder(reminder) {
  const reminders = loadReminders();
  reminders.push(reminder);
  saveReminders(reminders);
}

function removeReminder(id) {
  const reminders = loadReminders();
  const filtered = reminders.filter(r => r.id !== id);
  saveReminders(filtered);
}

function getRemindersForGuild(guildId) {
  return loadReminders().filter(r => r.guildId === guildId);
}

function getAllReminders() {
  return loadReminders();
}

module.exports = {
  getGuildConfig,
  setGuildConfig,
  addReminder,
  removeReminder,
  getRemindersForGuild,
  getAllReminders,
};