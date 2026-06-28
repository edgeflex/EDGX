'use strict';

/**
 * news-engine.js — EDGX News story extraction, dedup, and ranking
 *
 * Purpose:
 *   From a set of recent channel videos + their transcripts, extract candidate
 *   "stories", deduplicate them across three independent layers, rank them, and
 *   return the top N for the hourly broadcast.
 *
 * Pipeline:
 *   1. extractStories()  — turn each transcript into candidate story objects
 *   2. dedupeStories()   — three-layer dedup (hash → token-set → semantic shingle)
 *   3. rankStories()     — score by recency, source authority, and corroboration
 *   4. selectTopStories() — orchestrates the above, returns top N
 *
 * Determinism:
 *   Pure functions of their inputs (transcript text + provided timestamps).
 *   No Math.random(), no Date.now() inside scoring — "now" is passed in.
 *
 * Input contract:
 *   videos: Array<{
 *     videoId, title, published (string), channelName, channelId,
 *     publishedMs (number, epoch ms),
 *     lines: Array<{ text, offset, duration }>   // transcript
 *   }>
 */

// ─── Shared text utilities (kept local to avoid cross-module coupling) ───────

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','when','at','by','for',
  'with','about','against','between','into','through','during','before','after',
  'above','below','to','from','up','down','in','out','on','off','over','under',
  'again','further','is','are','was','were','be','been','being','have','has',
  'had','having','do','does','did','doing','i','you','he','she','it','we','they',
  'me','him','her','us','them','my','your','his','its','our','their','this','that',
  'these','those','am','of','as','so','than','too','very','can','will','just',
  'not','no','nor','only','own','same','such','what','which','who','whom','why',
  'how','all','any','both','each','few','more','most','other','some','here','there',
  'said','says','say','new','now','also','one','two','get','got','going','today',
]);

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
}

function contentTokens(text) {
  return tokenize(text).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Deterministic FNV-1a 32-bit hash of a normalised string.
 * Used for the layer-1 exact-dedup key.
 * @param {string} str
 * @returns {string} hex hash
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/**
 * Normalise a headline/sentence for hashing: lowercase, strip punctuation,
 * collapse whitespace, drop stopwords, sort tokens. Two headlines that say
 * the same thing in a different order collapse to the same key.
 * @param {string} text
 * @returns {string}
 */
function normaliseForHash(text) {
  return contentTokens(text).sort().join(' ');
}

// ─── Step 1: Story extraction ────────────────────────────────────────────────

/**
 * Convert a video + transcript into candidate story objects.
 *
 * Heuristic: a channel's most recent video usually leads with its top story.
 * We use the video title as the primary headline, and mine the opening portion
 * of the transcript for a one-paragraph synopsis and salient keywords.
 *
 * @param {Array} videos
 * @returns {Array<Story>}
 *
 * Story = {
 *   id, headline, channelName, channelId, videoId, publishedMs,
 *   synopsis, keywords (string[]), tokenSet (Set), shingles (Set),
 *   hashKey, sources (string[])
 * }
 */
function extractStories(videos) {
  const stories = [];

  for (const v of videos) {
    if (!v || !v.title) continue;

    // Headline = the video title (cleaned of common channel boilerplate)
    const headline = cleanHeadline(v.title);

    // Synopsis: first ~45 seconds of transcript text, or first 6 lines.
    const synopsis = buildSynopsis(v.lines || []);

    // Keywords: top content terms from title + opening transcript
    const corpus = headline + ' ' + synopsis;
    const keywords = topTerms(corpus, 8);

    const tokenSet = new Set(contentTokens(corpus));
    const shingles = buildShingles(corpus, 3);
    const entities = extractEntities(corpus);
    const hashKey  = fnv1a(normaliseForHash(headline));

    stories.push({
      id:          `${v.channelId}:${v.videoId}`,
      headline,
      channelName: v.channelName || 'Unknown source',
      channelId:   v.channelId,
      videoId:     v.videoId,
      publishedMs: v.publishedMs || 0,
      published:   v.published || '',
      synopsis,
      keywords,
      tokenSet,
      shingles,
      entities,
      hashKey,
      sources:     [v.channelName || 'Unknown source'],
      sourceType:  v.sourceType || 'youtube',
      authority:   typeof v.authority === 'number' ? v.authority : null,
      sourceAuthorities: [typeof v.authority === 'number'
        ? v.authority
        : (SOURCE_AUTHORITY[v.channelName] || 1.0)],
      link:        v.link || (v.videoId && !String(v.videoId).startsWith('rss:')
                     ? `https://www.youtube.com/watch?v=${v.videoId}` : (v.link || '')),
    });
  }

  return stories;
}

/**
 * Remove common channel boilerplate / decoration from a video title.
 * @param {string} title
 * @returns {string}
 */
function cleanHeadline(title) {
  return title
    .replace(/\s*[|\-–—]\s*(Bloomberg|CNBC|Reuters|Yahoo Finance|BBC News|Sky News).*$/i, '')
    .replace(/\s*\(.*?(live|full|interview|clip|highlights).*?\)\s*/i, ' ')
    .replace(/^\s*(LIVE|BREAKING|WATCH)[:\s]+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a short synopsis from the opening of a transcript.
 * Takes lines until ~45s of content or 6 lines, whichever comes first.
 * @param {Array} lines
 * @returns {string}
 */
function buildSynopsis(lines) {
  if (!lines.length) return '';
  const out = [];
  const startOffset = lines[0].offset || 0;
  for (const l of lines) {
    out.push(l.text.trim());
    const elapsed = (l.offset || 0) - startOffset;
    if (out.length >= 6 || elapsed > 45000) break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Top-frequency content terms in a text.
 * @param {string} text
 * @param {number} n
 * @returns {string[]}
 */
function topTerms(text, n) {
  const tf = new Map();
  for (const t of contentTokens(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([t]) => t);
}

/**
 * Build a set of word-level n-gram shingles for semantic similarity.
 * @param {string} text
 * @param {number} k  — shingle size
 * @returns {Set<string>}
 */
function buildShingles(text, k) {
  const toks = contentTokens(text);
  const set = new Set();
  for (let i = 0; i + k <= toks.length; i++) {
    set.add(toks.slice(i, i + k).join(' '));
  }
  return set;
}

/**
 * Extract a compact "entity set" — the distinctive nouns/proper-noun-like
 * tokens that identify WHAT a story is about, independent of phrasing.
 *
 * Two headlines about the same event ("Fed holds rates" / "central bank keeps
 * rates unchanged") share entities like rates/inflation even when their full
 * token sets diverge. We boost known domain entities so they anchor matching.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function extractEntities(text) {
  const toks = contentTokens(text);
  const ent = new Set();
  for (const t of toks) {
    if (DOMAIN_ENTITIES.has(t)) ent.add(canonicalEntity(t));
  }
  return ent;
}

/**
 * Domain entity lexicon with canonical grouping. Synonyms map to one canonical
 * token so "fed", "federal", "powell" all anchor to the same concept cluster.
 * Static, hand-curated — not generated.
 */
const ENTITY_CANON = {
  // Monetary policy
  fed:'fed', federal:'fed', reserve:'fed', powell:'fed', fomc:'fed', central:'fed', ecb:'ecb', lagarde:'ecb',
  rates:'rates', rate:'rates', interest:'rates', basis:'rates', hike:'rates', cut:'rates',
  inflation:'inflation', cpi:'inflation', prices:'inflation', price:'inflation', disinflation:'inflation',
  // Crypto
  bitcoin:'bitcoin', btc:'bitcoin', etf:'etf', ethereum:'ethereum', eth:'ethereum',
  crypto:'crypto', cryptocurrency:'crypto', altcoin:'crypto', altcoins:'crypto', resistance:'resistance',
  inflows:'inflows', inflow:'inflows', outflows:'outflows',
  // Markets
  stocks:'stocks', stock:'stocks', equities:'stocks', nasdaq:'stocks', dow:'stocks', sp:'stocks',
  yields:'yields', yield:'yields', bond:'yields', bonds:'yields', treasury:'yields', treasuries:'yields',
  earnings:'earnings', revenue:'earnings', profit:'earnings',
  // Politics
  congress:'congress', senate:'congress', house:'congress', shutdown:'shutdown', funding:'shutdown',
  election:'election', vote:'election', ballot:'election', campaign:'election',
  tariff:'tariff', tariffs:'tariff', trade:'tariff', sanctions:'sanctions',
};
const DOMAIN_ENTITIES = new Set(Object.keys(ENTITY_CANON));
function canonicalEntity(t) { return ENTITY_CANON[t] || t; }

// ─── Step 2: Three-layer deduplication ───────────────────────────────────────

/**
 * Jaccard similarity between two sets.
 * @param {Set} a @param {Set} b
 * @returns {number} 0–1
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Count of shared elements between two sets.
 * @param {Set} a @param {Set} b
 * @returns {number}
 */
function countShared(a, b) {
  let n = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) n++;
  return n;
}

/**
 * Deduplicate stories across three independent layers:
 *   Layer 1 — exact hash key (normalised, order-independent headline hash)
 *   Layer 2 — token-set Jaccard ≥ tokenThreshold
 *   Layer 3 — shingle (3-gram) Jaccard ≥ shingleThreshold (semantic near-dup)
 *
 * When two stories are judged duplicates, they are MERGED: the survivor keeps
 * the earliest publish time, and accumulates the other's source name (this
 * corroboration count later boosts ranking).
 *
 * @param {Array<Story>} stories
 * @param {Object} opts
 * @returns {Array<Story>} deduplicated, source-merged
 */
function dedupeStories(stories, opts = {}) {
  const tokenThreshold   = opts.tokenThreshold   ?? 0.45;
  const shingleThreshold = opts.shingleThreshold ?? 0.25;
  const entityThreshold  = opts.entityThreshold  ?? 0.60;

  const survivors = [];
  const seenHashes = new Map(); // hashKey → survivor index

  for (const story of stories) {
    // ── Layer 1: exact normalised-hash match ──
    if (seenHashes.has(story.hashKey)) {
      mergeInto(survivors[seenHashes.get(story.hashKey)], story);
      continue;
    }

    // ── Layers 2–4: similarity against existing survivors ──
    let duplicateOf = -1;
    for (let i = 0; i < survivors.length; i++) {
      const s = survivors[i];

      // Layer 2: token-set Jaccard (lexical overlap)
      if (jaccard(story.tokenSet, s.tokenSet) >= tokenThreshold) { duplicateOf = i; break; }

      // Layer 3: shingle Jaccard (phrase-level near-duplicate)
      if (jaccard(story.shingles, s.shingles) >= shingleThreshold) { duplicateOf = i; break; }

      // Layer 4: entity overlap (same event, different phrasing).
      // Requires a minimum shared-entity mass so unrelated stories that happen
      // to share one entity (e.g. both mention "rates") are NOT merged.
      const entSim = jaccard(story.entities, s.entities);
      const sharedEntities = countShared(story.entities, s.entities);
      if (entSim >= entityThreshold && sharedEntities >= 2) { duplicateOf = i; break; }
    }

    if (duplicateOf >= 0) {
      mergeInto(survivors[duplicateOf], story);
    } else {
      seenHashes.set(story.hashKey, survivors.length);
      survivors.push(story);
    }
  }

  return survivors;
}

/**
 * Merge a duplicate story into a survivor: keep earliest publish time,
 * union the source names (corroboration), union keywords.
 * @param {Story} survivor @param {Story} dup
 */
function mergeInto(survivor, dup) {
  if (dup.publishedMs && (!survivor.publishedMs || dup.publishedMs < survivor.publishedMs)) {
    survivor.publishedMs = dup.publishedMs;
    survivor.published = dup.published;
  }
  for (const src of dup.sources) {
    if (!survivor.sources.includes(src)) survivor.sources.push(src);
  }
  for (const kw of dup.keywords) {
    if (!survivor.keywords.includes(kw)) survivor.keywords.push(kw);
  }
  for (const e of dup.entities) survivor.entities.add(e);

  // Accumulate authority weights from the merged-in source for ranking.
  if (Array.isArray(dup.sourceAuthorities)) {
    survivor.sourceAuthorities.push(...dup.sourceAuthorities);
  }
  // If the survivor lacks an article link but the duplicate has one, keep it.
  if (!survivor.link && dup.link) survivor.link = dup.link;
  // Track that a story is corroborated across source types (video + RSS).
  if (dup.sourceType && dup.sourceType !== survivor.sourceType) {
    survivor.mixedSources = true;
  }
}

// ─── Step 3: Ranking ─────────────────────────────────────────────────────────

/**
 * Source authority weights. Higher = more authoritative institutional source.
 * Editorial weighting by institutional reputation — not an endorsement.
 * Unknown sources default to 1.0.
 */
const SOURCE_AUTHORITY = {
  'Bloomberg Television': 1.6, 'Bloomberg Originals': 1.5, 'Bloomberg Podcasts': 1.4,
  'CNBC Television': 1.5, 'CNBC': 1.5, 'CNBC International': 1.4,
  'Reuters': 1.6, 'Associated Press': 1.6, 'Financial Times': 1.5,
  'The Wall Street Journal': 1.5, 'The Economist': 1.4, 'Yahoo Finance': 1.3,
  'BBC News': 1.4, 'PBS NewsHour': 1.4, 'C-SPAN': 1.3,
  'Federal Reserve': 1.7, 'St. Louis Fed': 1.4, 'New York Fed': 1.4,
  'European Central Bank': 1.5, 'Bank of England': 1.5, 'International Monetary Fund': 1.5,
  'Coin Bureau': 1.3, 'Bankless': 1.2, 'CoinDesk': 1.3, 'Cointelegraph': 1.2,
};

/**
 * Rank deduplicated stories. Score combines:
 *   - Recency      : newer within the window scores higher (linear decay)
 *   - Authority    : max source-authority weight among corroborating sources
 *   - Corroboration: log-scaled count of distinct sources covering the story
 *   - Substance    : keyword richness (caps to avoid keyword-stuffing)
 *
 * @param {Array<Story>} stories
 * @param {Object} opts { nowMs, windowMs }
 * @returns {Array<Story>} sorted desc by score, each annotated with .score and .scoreBreakdown
 */
function rankStories(stories, opts = {}) {
  const nowMs    = opts.nowMs    ?? 0;
  const windowMs = opts.windowMs ?? 3_600_000; // 1 hour default

  const scored = stories.map(s => {
    // Recency: 1.0 at now, decaying to ~0.2 at window edge (and floored)
    let recency = 0.5;
    if (nowMs && s.publishedMs) {
      const ageMs = Math.max(0, nowMs - s.publishedMs);
      recency = Math.max(0.15, 1 - (ageMs / windowMs) * 0.85);
    }

    // Authority: best authority among corroborating sources.
    // RSS stories carry their own per-source authority; YouTube stories use the
    // SOURCE_AUTHORITY lookup. Merged stories track each source's authority.
    const authorityValues = (s.sourceAuthorities && s.sourceAuthorities.length)
      ? s.sourceAuthorities
      : [typeof s.authority === 'number' ? s.authority : (SOURCE_AUTHORITY[s.channelName] || 1.0)];
    const authority = Math.max(...authorityValues);

    // Corroboration: more independent sources → higher confidence
    const corroboration = 1 + Math.log2(s.sources.length + 1) - 1; // sources=1 → ~0.585+? keep simple
    const corrobFactor = 1 + Math.log2(s.sources.length); // sources=1 →1, =2 →2, =4 →3

    // Substance: keyword richness, capped
    const substance = Math.min(1, s.keywords.length / 8);

    const score =
      recency * 3.0 +
      (authority - 1) * 2.0 +
      (corrobFactor - 1) * 1.5 +
      substance * 1.0;

    return {
      ...s,
      score: Math.round(score * 1000) / 1000,
      scoreBreakdown: {
        recency: Math.round(recency * 100) / 100,
        authority,
        sources: s.sources.length,
        substance: Math.round(substance * 100) / 100,
      },
    };
  });

  return scored.sort((a, b) =>
    b.score - a.score ||
    b.publishedMs - a.publishedMs ||
    a.headline.localeCompare(b.headline)
  );
}

// ─── Step 4: Orchestration ───────────────────────────────────────────────────

/**
 * Full pipeline: extract → dedupe → rank → take top N.
 * @param {Array} videos
 * @param {Object} opts { nowMs, windowMs, topN }
 * @returns {{ topStories: Array<Story>, totalCandidates, afterDedup }}
 */
function selectTopStories(videos, opts = {}) {
  const topN = opts.topN ?? 3;

  const candidates = extractStories(videos);
  const deduped    = dedupeStories(candidates, opts);
  const ranked     = rankStories(deduped, opts);

  return {
    topStories:     ranked.slice(0, topN),
    totalCandidates: candidates.length,
    afterDedup:     deduped.length,
  };
}

module.exports = {
  selectTopStories,
  extractStories,
  dedupeStories,
  rankStories,
  // exported for testing
  _internal: { fnv1a, normaliseForHash, jaccard, buildShingles, cleanHeadline },
};
