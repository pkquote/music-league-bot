/**
 * scraper.js — Rewritten based on actual Music League page structure.
 *
 * How Music League works (discovered via source inspection):
 *   - Uses HTMX + Alpine.js + server-side rendered HTML fragments
 *   - Main page /l/{id}/ contains: league name, members (in Alpine x-data JSON), stats
 *   - Rounds are loaded via HTMX: GET /l/{id}/-/rounds
 *   - Standings: GET /l/{id}/-/standings
 *   - Member data is HTML-encoded JSON embedded in x-data attributes
 *
 * Auth: Set ML_COOKIE in .env for unlisted/private leagues.
 */

const https = require('https');
const http = require('http');

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function get(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const cookie = process.env.ML_COOKIE || '';

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://app.musicleague.com/',
        ...(cookie ? { Cookie: cookie } : {}),
        ...extraHeaders,
      },
    };

    const req = mod.get(url, options, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://app.musicleague.com${res.headers.location}`;
        return get(next, extraHeaders).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body, headers: res.headers }));
    });

    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractLeagueId(url) {
  const match = url.match(/\/l\/([a-f0-9]{32})\//);
  return match ? match[1] : null;
}

function decodeAlpineJson(str) {
  // Alpine.js HTML-encodes " as &#34; and & as \u0026
  return str
    .replace(/&#34;/g, '"')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');
}

// ─── Main Page Parser ─────────────────────────────────────────────────────────

function parseLeaguePage(html, url) {
  const data = { url };
  data.leagueId = extractLeagueId(url);

  // League name from <title>
  const titleMatch = html.match(/<title>Music League \| ([^<]+)<\/title>/);
  if (titleMatch) data.name = titleMatch[1].trim();

  // Stats: rounds, songs/round, players — pattern from actual HTML:
  // <strong class="d-block">10</strong><span class="fw-light">ROUNDS</span>
  const roundsMatch = html.match(/<strong[^>]*>(\d+)<\/strong>\s*<span[^>]*>ROUNDS<\/span>/);
  if (roundsMatch) data.totalRounds = parseInt(roundsMatch[1]);

  const songsMatch = html.match(/<strong[^>]*>(\d+)<\/strong>\s*<span[^>]*>SONG\/ROUND<\/span>/);
  if (songsMatch) data.songsPerRound = parseInt(songsMatch[1]);

  // "7 / 20" players
  const playersMatch = html.match(/<strong[^>]*>(\d+)\s*\/\s*(\d+)<\/strong>\s*<span[^>]*>PLAYERS<\/span>/);
  if (playersMatch) {
    data.currentPlayers = parseInt(playersMatch[1]);
    data.maxPlayers = parseInt(playersMatch[2]);
  }

  // Privacy & speed badges
  data.privacy = html.includes('UNLISTED') ? 'Unlisted'
    : html.includes('PRIVATE') ? 'Private'
    : 'Public';
  if (html.includes('SPEEDY')) data.speed = 'Speedy';

  // Members — embedded in Alpine x-data as HTML-encoded JSON
  // Pattern: x-data="{members: [...]}" (may appear multiple times; grab first)
  // The JSON starts after "members: " and ends before the closing }"
  // We extract by finding the members array boundaries
  const membersMarker = html.indexOf('"members":');
  const altMarker = html.indexOf('members: [');
  const markerIdx = membersMarker !== -1 ? membersMarker : altMarker;

  if (markerIdx !== -1) {
    // Find the start of the JSON array
    const arrayStart = html.indexOf('[', markerIdx);
    if (arrayStart !== -1) {
      // Walk to find matching closing bracket
      let depth = 0;
      let i = arrayStart;
      for (; i < html.length; i++) {
        if (html[i] === '[') depth++;
        else if (html[i] === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
      const rawJson = html.slice(arrayStart, i + 1);
      try {
        const members = JSON.parse(decodeAlpineJson(rawJson));
        data.members = members.map(m => ({
          id: m.user?.id,
          name: m.user?.name,
          isAdmin: m.isAdmin,
          joinedAt: m.created,
        }));
      } catch (e) {
        // Fallback: just count member avatars
        const avatarCount = (html.match(/class="rounded-circle".*?style="height: 36px/g) || []).length;
        if (avatarCount) data.memberAvatarCount = avatarCount;
      }
    }
  }

  return data;
}

// ─── Rounds Fragment Parser ───────────────────────────────────────────────────

function parseRoundsFragment(html) {
  const rounds = [];

  // Rounds page uses hx-get patterns and .league-round-item containers.
  // Each round is linked via /l/{id}/r/{roundId}/
  // We'll split on round URLs and parse each block.

  const roundLinkPattern = /href="(\/l\/[a-f0-9]{32}\/r\/([a-f0-9]{32})\/[^"]*)"/g;
  const seen = new Set();

  // First pass: extract all round URLs to know how many rounds there are
  const roundUrls = [];
  let match;
  while ((match = roundLinkPattern.exec(html)) !== null) {
    const roundId = match[2];
    if (!seen.has(roundId)) {
      seen.add(roundId);
      roundUrls.push({ url: match[1], roundId, idx: match.index });
    }
  }

  // Second pass: for each round URL, extract nearby context
  for (let i = 0; i < roundUrls.length; i++) {
    const { url: roundPath, roundId, idx } = roundUrls[i];
    const nextIdx = roundUrls[i + 1]?.idx ?? html.length;
    const block = html.slice(Math.max(0, idx - 200), nextIdx);

    const round = {
      url: `https://app.musicleague.com${roundPath}`,
      roundId,
    };

    // Round name — text of the anchor tag pointing to the round
    const nameLinkMatch = block.match(new RegExp(`href="${roundPath.replace(/\//g, '\\/')}"[^>]*>([^<]{2,80})<\/a>`));
    if (nameLinkMatch) round.name = nameLinkMatch[1].trim();

    // Theme — often in a secondary text element near the round
    const themeMatch = block.match(/class="[^"]*text-(?:body-secondary|muted|secondary)[^"]*"[^>]*>\s*([^<]{3,100})\s*<\//);
    if (themeMatch) round.theme = themeMatch[1].trim();

    // Status
    if (/submissions?\s+open/i.test(block)) round.status = '📤 Submissions Open';
    else if (/voting\s+open/i.test(block)) round.status = '🗳️ Voting Open';
    else if (/complet/i.test(block)) round.status = '✅ Complete';
    else if (/upcoming/i.test(block)) round.status = '⏳ Upcoming';

    // ISO 8601 dates (used for deadlines)
    const isoDates = [...block.matchAll(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/g)].map(m => m[1]);
    if (isoDates.length >= 2) {
      round.submissionDeadline = isoDates[0];
      round.votingDeadline = isoDates[1];
    } else if (isoDates.length === 1) {
      round.submissionDeadline = isoDates[0];
    }

    // Human-readable dates as fallback
    if (!round.submissionDeadline) {
      const humanDate = block.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:,? \d{4})?(?:,? (?:at )?\d{1,2}:\d{2} ?(?:AM|PM))?/i);
      if (humanDate) round.submissionDeadline = humanDate[0];
    }

    rounds.push(round);
  }

  // If we found no rounds at all, return a minimal object with raw ISO dates
  if (!rounds.length) {
    const allDates = [...html.matchAll(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^"'\s<]*)/g)].map(m => m[1]);
    if (allDates.length) return [{ status: 'Parsed dates only', allDates }];
  }

  return rounds;
}

// ─── Standings Parser ─────────────────────────────────────────────────────────

function parseStandings(html) {
  const standings = [];
  const blocks = html.split(/(?=class="[^"]*league-standing-item)/);

  for (const block of blocks) {
    if (!block.includes('league-standing-item')) continue;

    const entry = {};

    const nameMatch = block.match(/class="[^"]*fw-semibold[^"]*"[^>]*>\s*([^<]{2,60})\s*<\//);
    if (nameMatch) entry.name = nameMatch[1].trim();

    const pointsMatch = block.match(/(\d+)\s*(?:pts?|points?)/i);
    if (pointsMatch) entry.points = parseInt(pointsMatch[1]);

    // Rank number if present
    const rankMatch = block.match(/(?:^|\D)(\d{1,2})(?:\.|:|\)|\s).*?(?:rank|position)/i);
    if (rankMatch) entry.rank = parseInt(rankMatch[1]);

    if (entry.name) standings.push(entry);
  }

  return standings;
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function fetchLeague(url) {
  if (!url.endsWith('/')) url += '/';
  const leagueId = extractLeagueId(url);
  if (!leagueId) throw new Error('Could not extract league ID from URL.');

  const base = `https://app.musicleague.com/l/${leagueId}`;

  // 1. Main league page
  const { statusCode, body: mainHtml } = await get(`${base}/`);

  if (statusCode === 302 || mainHtml.includes('action="/login/"') || mainHtml.includes('/login/?next=')) {
    throw new Error('Login required. Set ML_COOKIE in your .env file with your session cookie.');
  }
  if (statusCode === 404) throw new Error('League not found (404). Check the URL.');
  if (statusCode >= 400) throw new Error(`HTTP ${statusCode} fetching league page.`);

  const data = parseLeaguePage(mainHtml, url);
  if (!data.name) throw new Error('Could not parse league name from page.');

  // 2. Rounds (HTMX fragment) — send HX-Request header to get the fragment
  try {
    const { body: roundsHtml } = await get(`${base}/-/rounds`, {
      'HX-Request': 'true',
      'HX-Current-URL': `${base}/`,
      'HX-Target': 'body',
    });
    data.rounds = parseRoundsFragment(roundsHtml);
    data.activeRound = data.rounds.find(r =>
      r.status && (r.status.includes('Open') || r.status.includes('Upcoming'))
    ) || null;
  } catch (e) {
    data.roundsError = e.message;
  }

  // 3. Standings (HTMX fragment)
  try {
    const { body: standingsHtml } = await get(`${base}/-/standings`, {
      'HX-Request': 'true',
      'HX-Current-URL': `${base}/standings/`,
    });
    data.standings = parseStandings(standingsHtml);
  } catch (e) {
    data.standingsError = e.message;
  }

  return data;
}

async function fetchRounds(url) {
  if (!url.endsWith('/')) url += '/';
  const leagueId = extractLeagueId(url);
  if (!leagueId) throw new Error('Could not extract league ID.');

  const { body } = await get(
    `https://app.musicleague.com/l/${leagueId}/-/rounds`,
    { 'HX-Request': 'true' }
  );
  return parseRoundsFragment(body);
}

module.exports = { fetchLeague, fetchRounds, extractLeagueId };