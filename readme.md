# 🎵 Music League Discord Bot

A Discord bot that integrates with [Music League](https://app.musicleague.com) — supporting league info display, web scraping of public pages, and flexible reminder scheduling for submission and voting deadlines.

---

## Features

| Command                                     | Description                               |
| ------------------------------------------- | ----------------------------------------- |
| `/setleague <url>`                          | Set the Music League URL for your server  |
| `/league`                                   | Display current league info and round     |
| `/fetch`                                    | Re-fetch latest data from the league page |
| `/setchannel <#channel>`                    | Set where reminders are posted            |
| `/remind <type> <datetime> [remind_before]` | Schedule a reminder                       |
| `/reminders`                                | List all active reminders                 |
| `/cancelreminder <id>`                      | Cancel a reminder by ID                   |
| `/help`                                     | Show command help                         |

---

## Setup

### 1. Create a Discord Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** → click **Add Bot**
4. Under **Token**, click **Reset Token** and copy it
5. Under **Privileged Gateway Intents**, enable **Server Members Intent** and **Message Content Intent** if needed
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Send Messages`, `Embed Links`, `Mention Everyone`
   - Copy the generated URL and open it to invite the bot to your server
7. Copy your **Application ID** (shown on the General Information page)

### 2. Install & Configure

```bash
# Clone or download the bot files
cd musicleague-bot

# Install dependencies
npm install

# Copy and fill in your .env
cp .env.example .env
```

Edit `.env`:

```
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
```

### 3. Run the Bot

```bash
npm start
```

Slash commands register automatically on first start. They may take up to a minute to appear in Discord.

---

## Usage Guide

### Setting Up Your League

```
/setchannel #music-league        ← Where reminders get posted
/setleague https://app.musicleague.com/l/your-league-id/
```

The bot will attempt to scrape the league page. If your league is private or requires login, scraping won't work — but you can still use `/remind` to manually set deadline reminders.

### Scheduling Reminders

```
# Remind about submission deadline, 60 min before (default)
/remind type:Submission deadline  datetime:2024-12-25 18:00

# Remind about voting, 2 hours (120 min) before
/remind type:Voting deadline  datetime:2024-12-27 20:00  remind_before:120

# Remind about both deadlines at once
/remind type:Both  datetime:2024-12-28 18:00  remind_before:30
```

**Supported datetime formats:**

- `2024-12-25 18:00` (treated as local server time)
- `2024-12-25T18:00:00Z` (UTC)
- `2024-12-25T13:00:00-05:00` (with timezone offset)

When the reminder fires, it sends an @everyone ping to the configured channel.

### Managing Reminders

```
/reminders                   ← List all active reminders with their IDs
/cancelreminder abc12345     ← Cancel a specific reminder
```

Reminders are persisted to disk and restored if the bot restarts.

---

## Notes on Scraping

Music League does **not** have a public API. The bot attempts to scrape the league page for:

- League name
- Current round name and theme
- Status (submissions open / voting open / results)
- Deadlines (if visible in the HTML)

**Limitations:**

- Music League pages are partially client-side rendered (React). Some data may not be extractable via simple HTML scraping.
- Private leagues require login cookies — the bot cannot authenticate.
- The most reliable way to use this bot is to **manually set reminders** using `/remind` with dates from your league.

### Future Enhancement: Puppeteer

For full scraping support (including JS-rendered content), you can add Puppeteer:

```bash
npm install puppeteer
```

Then update `scraper.js` to use a headless browser for rendering. If you're logged in via cookies, you could export your session cookies and pass them to Puppeteer for authenticated scraping.

---

## File Structure

```
musicleague-bot/
├── bot.js          # Main bot + command handlers
├── scraper.js      # Music League page scraper
├── scheduler.js    # Reminder scheduling (setTimeout + persistence)
├── storage.js      # JSON file storage for configs and reminders
├── data/           # Auto-created; stores guilds.json + reminders.json
├── .env            # Your secrets (not committed)
├── .env.example    # Template
└── package.json
```

---

## Hosting

For 24/7 uptime, host on:

- **Railway** / **Render** / **Fly.io** (free tiers available)
- **A VPS** (DigitalOcean, Linode, etc.) with `pm2` for process management:
  ```bash
  npm install -g pm2
  pm2 start bot.js --name musicleague-bot
  pm2 save
  pm2 startup
  ```

---

## License

MIT — use freely, modify as needed.
