'use strict';

/**
 * rss-sources.js — Fetch and parse RSS/Atom feeds into story-shaped objects.
 *
 * Output matches the "video" contract the news engine already consumes, so RSS
 * stories and YouTube stories flow through the SAME dedup + ranking pipeline.
 *
 * Each parsed item becomes:
 *   {
 *     videoId:     'rss:<hash>'      // synthetic stable id (no real video)
 *     title:       headline
 *     channelName: source name
 *     channelId:   'rss:<sourceSlug>'
 *     publishedMs, published
 *     lines:       [{ text, offset, duration }]   // synthesised from the
 *                  item description so the engine can build a synopsis
 *     sourceType:  'rss'
 *     link:        article URL
 *   }
 *
 * No API key. Parsing is regex-based (no XML dependency) to keep the footprint
 * small and Railway-friendly; it tolerates both RSS 2.0 <item> and Atom <entry>.
 */

const fetch = require('node-fetch');

/**
 * FNV-1a 32-bit hash → stable synthetic id for an article.
 * @param {string} str
 * @returns {string}
 */
function hashId(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/** Strip HTML tags and collapse whitespace from a description blob. */
function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Pull the first matching capture group, or '' . */
function first(re, str) {
  const m = str.match(re);
  return m ? m[1] : '';
}

/**
 * Synthesise transcript-like lines from article text so the engine's synopsis
 * and keyword extraction work uniformly across RSS and YouTube.
 * @param {string} text
 * @returns {Array<{text,offset,duration}>}
 */
function textToLines(text) {
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  return sentences.slice(0, 8).map((s, i) => ({
    text: s.trim(),
    offset: i * 4000,
    duration: 3800,
  }));
}

/**
 * Parse a feed body (RSS 2.0 or Atom) into raw items.
 * @param {string} xml
 * @returns {Array<{title,desc,link,date}>}
 */
function parseFeed(xml) {
  const items = [];

  // RSS 2.0 <item>…</item>
  const rssItems = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)];
  for (const [, body] of rssItems) {
    items.push({
      title: stripHtml(first(/<title[^>]*>([\s\S]*?)<\/title>/i, body)),
      desc:  stripHtml(first(/<description[^>]*>([\s\S]*?)<\/description>/i, body)
                    || first(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i, body)),
      link:  decodeEntities(first(/<link[^>]*>([\s\S]*?)<\/link>/i, body)).trim(),
      date:  first(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i, body)
          || first(/<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i, body),
    });
  }

  // Atom <entry>…</entry>
  if (items.length === 0) {
    const atomItems = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)];
    for (const [, body] of atomItems) {
      const link = first(/<link[^>]*href="([^"]+)"[^>]*\/?>/i, body);
      items.push({
        title: stripHtml(first(/<title[^>]*>([\s\S]*?)<\/title>/i, body)),
        desc:  stripHtml(first(/<summary[^>]*>([\s\S]*?)<\/summary>/i, body)
                      || first(/<content[^>]*>([\s\S]*?)<\/content>/i, body)),
        link:  decodeEntities(link).trim(),
        date:  first(/<updated[^>]*>([\s\S]*?)<\/updated>/i, body)
            || first(/<published[^>]*>([\s\S]*?)<\/published>/i, body),
      });
    }
  }

  return items.filter(it => it.title);
}

/**
 * Fetch a single RSS source and return story-shaped objects within a window.
 *
 * @param {Object} source  — { name, url, category, authority }
 * @param {Object} opts     — { nowMs, windowMs, maxItems }
 * @returns {Promise<Array>} story-shaped items
 */
async function fetchRssSource(source, opts = {}) {
  const nowMs    = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? 3_600_000;
  const maxItems = opts.maxItems ?? 5;

  const res = await fetch(source.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; EDGXNewsBot/1.0)',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
    timeout: 12_000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const xml = await res.text();
  const rawItems = parseFeed(xml);
  if (rawItems.length === 0) throw new Error('No items parsed from feed');

  const sourceSlug = source.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stories = [];

  for (const it of rawItems) {
    const publishedMs = it.date ? Date.parse(it.date) : 0;

    // Window filter: keep items inside the lookback window. Items with no
    // parseable date are kept (many feeds omit precise timestamps).
    if (nowMs && publishedMs && (nowMs - publishedMs) > windowMs) continue;

    const articleText = it.desc || it.title;

    stories.push({
      videoId:     `rss:${hashId(source.url + it.title)}`,
      title:       it.title,
      channelName: source.name,
      channelId:   `rss:${sourceSlug}`,
      publishedMs,
      published:   publishedMs
        ? new Date(publishedMs).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : '',
      lines:       textToLines(articleText),
      sourceType:  'rss',
      category:    source.category,
      authority:   source.authority,
      link:        it.link,
    });

    if (stories.length >= maxItems) break;
  }

  return stories;
}

/**
 * Fetch many RSS sources concurrently (bounded), tolerating individual failures.
 * Optionally integrates a FeedHealth tracker: quarantined feeds are skipped, and
 * each outcome is recorded so dead feeds auto-prune over successive runs.
 *
 * @param {Array} sources
 * @param {Object} opts { nowMs, windowMs, maxItems, concurrency, log, health }
 * @returns {Promise<{ stories: Array, ok: number, failed: number, skipped: number }>}
 */
async function fetchAllRss(sources, opts = {}) {
  const concurrency = opts.concurrency ?? 6;
  const log = opts.log || (() => {});
  const health = opts.health || null;
  const nowMs = opts.nowMs ?? Date.now();

  // Skip feeds still in quarantine (not yet due for a probation retry).
  let toFetch = sources;
  let skipped = 0;
  if (health) {
    const part = health.partition(sources, nowMs);
    toFetch = part.active;
    skipped = part.skipped.length;
    if (skipped) log(`  rss: skipping ${skipped} quarantined feed(s)`);
  }

  const stories = [];
  let ok = 0, failed = 0;

  let cursor = 0;
  async function worker() {
    while (cursor < toFetch.length) {
      const idx = cursor++;
      const src = toFetch[idx];
      try {
        const items = await fetchRssSource(src, opts);
        stories.push(...items);
        ok++;
        if (health) health.recordSuccess(src.url, items.length, nowMs);
        log(`  rss ok: ${src.name} (${items.length})`);
      } catch (err) {
        failed++;
        if (health) {
          const newlyQuarantined = health.recordFailure(src.url, err.message, nowMs);
          log(`  rss fail: ${src.name} (${err.message})${newlyQuarantined ? ' → QUARANTINED' : ''}`);
        } else {
          log(`  rss fail: ${src.name} (${err.message})`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, toFetch.length) }, worker));
  if (health) health.flush();

  return { stories, ok, failed, skipped };
}

module.exports = { fetchRssSource, fetchAllRss, parseFeed, textToLines };
