'use strict';

/**
 * broadcast.js — EDGX hourly news broadcast script generator
 *
 * Purpose:
 *   Turn the top-ranked deduplicated stories into a professional two-anchor
 *   news script (Jane + Brandon), formatted with intro, per-story segments,
 *   debate/discussion beats, hand-offs, and an outro.
 *
 * Script generation:
 *   Uses Groq (llama-3.3-70b-versatile) to write natural, conversational,
 *   debating two-way dialogue. The model is constrained to the supplied story
 *   facts only — it is explicitly instructed NOT to invent facts, figures, or
 *   sources beyond what each story provides. Output is strict JSON we parse
 *   into ordered dialogue turns.
 *
 * Anchors:
 *   Jane    — female anchor (lead). Voice: ELEVENLABS_VOICE_JANE
 *   Brandon — male anchor (analysis/debate). Voice: ELEVENLABS_VOICE_BRANDON
 *
 * Requires env: GROQ_API_KEY
 */

const fetch = require('node-fetch');

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Broadcast duration mandate ──────────────────────────────────────────────
// Every broadcast MUST run 6-7 minutes. We enforce this by estimating spoken
// duration from the script word count and regenerating/expanding until the
// floor is cleared. Estimation uses a broadcast-anchor speaking rate plus the
// inter-turn gaps actually inserted during stitching.
const MIN_BROADCAST_SECONDS = 360; // 6:00 hard floor (mandate)
const MAX_BROADCAST_SECONDS = 420; // 7:00 target ceiling
const WORDS_PER_MINUTE      = 150; // measured news-anchor delivery (Jane/Brandon)
const GAP_SECONDS_PER_TURN  = 0.35; // average inter-turn silence added by tts.js

/**
 * Estimate spoken duration of a script in seconds.
 * Combines speech time (word count ÷ WPM) with the inter-turn gaps that the
 * stitcher inserts between every turn.
 * @param {Object} script  — validated script { segments }
 * @returns {{ seconds: number, words: number, turns: number }}
 */
function estimateDuration(script) {
  let words = 0, turns = 0;
  for (const seg of script.segments || []) {
    for (const t of seg.turns || []) {
      words += countWords(t.text);
      turns += 1;
    }
  }
  const speechSeconds = (words / WORDS_PER_MINUTE) * 60;
  const gapSeconds    = Math.max(0, turns - 1) * GAP_SECONDS_PER_TURN;
  return { seconds: Math.round(speechSeconds + gapSeconds), words, turns };
}

/**
 * Count words in a string.
 * @param {string} s
 * @returns {number}
 */
function countWords(s) {
  if (!s) return 0;
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Given a target word count and current stories, compute how many words each
 * story segment should carry to reach the duration floor. Used to instruct the
 * model precisely rather than vaguely asking for "longer".
 * @param {number} targetSeconds
 * @param {number} introOutroWords  — rough fixed overhead
 * @param {number} storyCount
 * @returns {number} words per story
 */
function wordsPerStoryForTarget(targetSeconds, introOutroWords, storyCount) {
  const totalWords = Math.ceil((targetSeconds / 60) * WORDS_PER_MINUTE);
  const storyWords = Math.max(0, totalWords - introOutroWords);
  return Math.ceil(storyWords / Math.max(1, storyCount));
}

/**
 * Build the system prompt that defines the broadcast format and guardrails.
 * @returns {string}
 */
function buildSystemPrompt() {
  return [
    'You are the head scriptwriter for "EDGX News", a professional hourly financial-news broadcast.',
    'You write a tight, natural, two-anchor script for a top-of-the-hour bulletin.',
    '',
    'ANCHORS:',
    '- JANE: female lead anchor. Warm, authoritative, drives the running order.',
    '- BRANDON: male co-anchor. Analytical, asks sharp follow-ups, offers counterpoints, adds market context.',
    '',
    'STYLE REQUIREMENTS:',
    '- Genuine two-way conversation: they react to each other, build on each other\'s points, debate, respectfully disagree, and highlight what matters.',
    '- Conversational rhythm with natural turn-taking. Vary turn length: mix punchy one-line reactions with fuller 2-3 sentence points. Avoid every turn being the same length.',
    '- Professional broadcast register — credible, not sensational. No catchphrases, no filler, no studio sound directions.',
    '',
    'DIALOGUE DEPTH (IMPORTANT — make each story a real discussion, not a quick mention):',
    '- Each STORY segment MUST have 6 to 9 turns of dialogue, alternating between Jane and Brandon, so the topic is genuinely explored.',
    '- Work through each story in distinct beats: (1) Jane sets it up with the key fact, (2) Brandon adds analysis or context, (3) a genuine back-and-forth where they take DIFFERENT angles — e.g. one weighs the data, the other the human or market impact; one near-term, the other long-term, (4) at least one moment of pushback or "yes, but…", (5) they surface what it means for the audience, (6) a clean hand-off to the next story.',
    '- Give the two anchors COMPLEMENTARY perspectives on each story so the debate has real texture — they should not simply agree and move on.',
    '- Reference the specific facts and sources from the brief as they discuss; the richness must come from genuinely examining the supplied facts, not from padding or repetition.',
    '',
    'STRICT FACTUAL GUARDRAILS (CRITICAL):',
    '- Use ONLY the facts contained in the provided story briefs. Do NOT invent numbers, prices, quotes, dates, or named people not present in the brief.',
    '- If the brief lacks a figure, speak qualitatively ("rose sharply") rather than fabricating a number.',
    '- You may attribute coverage to the listed sources for each story. Do not invent sources.',
    '- Do not state opinions as fact; frame debate as the anchors\' analysis.',
    '- Depth must never become fabrication: a longer discussion means examining the SAME facts from more angles, never adding invented detail.',
    '',
    'OUTPUT FORMAT:',
    'Return ONLY valid JSON, no markdown, no preamble. Schema:',
    '{',
    '  "segments": [',
    '    { "type": "intro",  "turns": [ { "speaker": "JANE"|"BRANDON", "text": "..." } ] },',
    '    { "type": "story", "storyIndex": 0, "headline": "...", "turns": [ ... ] },',
    '    { "type": "outro", "turns": [ ... ] }',
    '  ]',
    '}',
    'Every turn.speaker MUST be exactly "JANE" or "BRANDON". Each story segment needs 6-9 turns.',
    `DURATION MANDATE: the full broadcast MUST run between 6 and 7 minutes of spoken audio. At a ${WORDS_PER_MINUTE}-words-per-minute anchor pace that is roughly ${Math.ceil(MIN_BROADCAST_SECONDS/60*WORDS_PER_MINUTE)}-${Math.ceil(MAX_BROADCAST_SECONDS/60*WORDS_PER_MINUTE)} words total. This is a hard requirement — never deliver less than 6 minutes. Reach the length through genuine, substantive discussion of the briefed facts, never filler or repetition.`,
  ].join('\n');
}

/**
 * Build the user prompt carrying the story briefs and broadcast metadata.
 * @param {Array} stories  — top ranked stories
 * @param {Object} meta    — { hourLabel, dateLabel }
 * @returns {string}
 */
function buildUserPrompt(stories, meta, opts = {}) {
  const briefs = stories.map((s, i) => {
    return [
      `STORY ${i + 1}:`,
      `  Headline: ${s.headline}`,
      `  Covered by: ${s.sources.join(', ')}${s.sources.length > 1 ? ` (${s.sources.length} sources corroborating)` : ''}`,
      `  Key terms: ${s.keywords.slice(0, 8).join(', ')}`,
      `  Brief: ${s.synopsis || '(no transcript synopsis available)'}`,
    ].join('\n');
  }).join('\n\n');

  const targetWords = Math.ceil((MAX_BROADCAST_SECONDS / 60) * WORDS_PER_MINUTE);
  const perStory = wordsPerStoryForTarget(MAX_BROADCAST_SECONDS, 120, stories.length);

  return [
    `This is the EDGX News bulletin for ${meta.hourLabel} on ${meta.dateLabel}.`,
    `There are ${stories.length} top stories from the past hour, already ranked by importance and deduplicated across sources.`,
    '',
    briefs,
    '',
    'Write the full broadcast script:',
    '1. INTRO: Jane opens with the EDGX News greeting, the time, and a one-line teaser of the top stories. Brandon adds a welcoming line.',
    '2. STORY SEGMENTS in the given order (most important first). Each story must be a RICH discussion of 6-9 alternating turns: setup, analysis, a genuine multi-exchange debate where Jane and Brandon take different angles on the same facts, at least one "yes, but…" pushback, what it means for the audience, then a hand-off. Do not let any story be a quick two-line mention.',
    '3. OUTRO: a quick recap, sign-off with both names, and a note that EDGX News returns at the top of the next hour.',
    '',
    `LENGTH TARGET: aim for about ${targetWords} words total (~${perStory} words per story) so the broadcast runs a full 6 to 7 minutes. Never come in under 6 minutes. Reach the length only through substantive discussion of the briefed facts.`,
    'Return ONLY the JSON object.',
  ].join('\n');
}

/**
 * Call Groq to generate the broadcast script.
 * @param {Array} stories
 * @param {Object} meta { hourLabel, dateLabel }
 * @param {Object} opts { apiKey }
 * @returns {Promise<Object>} parsed script { segments: [...] }
 */
async function generateScript(stories, meta, opts = {}) {
  const apiKey = opts.apiKey || process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set. Cannot generate broadcast script.');
  if (!stories || stories.length === 0) throw new Error('No stories supplied to script generator.');

  const log = opts.log || (() => {});
  const maxAttempts = opts.maxAttempts ?? 4; // initial + up to 3 expansion passes

  // First attempt.
  let best = await generateScriptAttempt(stories, meta, { apiKey });
  best.duration = estimateDuration(best);
  log(`[script] attempt 1: ${best.duration.seconds}s, ${best.duration.words} words, ${best.duration.turns} turns`);

  // Enforcement loop: regenerate/expand until the 6-minute floor is met.
  // Each pass feeds the current draft back and asks the model to EXPAND the
  // existing discussion (more angles on the same facts) to hit the target —
  // never to invent facts. We keep the longest valid draft as a safety net.
  let attempt = 1;
  while (best.duration.seconds < MIN_BROADCAST_SECONDS && attempt < maxAttempts) {
    attempt += 1;
    const deficitSec = MIN_BROADCAST_SECONDS - best.duration.seconds;
    try {
      const expanded = await generateScriptAttempt(stories, meta, {
        apiKey,
        expandFrom: best,
        deficitSeconds: deficitSec,
      });
      expanded.duration = estimateDuration(expanded);
      log(`[script] attempt ${attempt}: ${expanded.duration.seconds}s, ${expanded.duration.words} words (need ${MIN_BROADCAST_SECONDS}s)`);
      // Keep whichever is longer (closer to / past the floor).
      if (expanded.duration.seconds > best.duration.seconds) best = expanded;
    } catch (err) {
      log(`[script] attempt ${attempt} failed: ${err.message}`);
      break; // transient API issue — stop expanding, keep best so far
    }
  }

  // Annotate whether the mandate was met. The orchestrator can decide policy;
  // by default we surface this rather than silently shipping a short bulletin.
  best.meetsDurationMandate = best.duration.seconds >= MIN_BROADCAST_SECONDS;
  best.durationMandate = { minSeconds: MIN_BROADCAST_SECONDS, maxSeconds: MAX_BROADCAST_SECONDS };
  if (!best.meetsDurationMandate) {
    log(`[script] WARNING: best draft ${best.duration.seconds}s is under the ${MIN_BROADCAST_SECONDS}s mandate after ${attempt} attempts.`);
  }

  return best;
}

/**
 * Pick the richer of two validated scripts.
 * @param {Object} a @param {Object} b
 * @returns {Object}
 */
function pickRicherScript(a, b) {
  const aThin = a.depth?.thinStoryCount ?? 99;
  const bThin = b.depth?.thinStoryCount ?? 99;
  if (bThin !== aThin) return bThin < aThin ? b : a;
  const aTurns = (a.depth?.storyTurnCounts || []).reduce((x, y) => x + y, 0);
  const bTurns = (b.depth?.storyTurnCounts || []).reduce((x, y) => x + y, 0);
  return bTurns > aTurns ? b : a;
}

/**
 * Single generation attempt against Groq.
 * @param {Array} stories
 * @param {Object} meta
 * @param {Object} opts { apiKey, expandFrom, deficitSeconds }
 * @returns {Promise<Object>} validated script
 */
async function generateScriptAttempt(stories, meta, opts = {}) {
  const apiKey = opts.apiKey;

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user',   content: buildUserPrompt(stories, meta) },
  ];

  // Expansion pass: feed the prior draft back and ask the model to LENGTHEN it
  // to meet the duration floor by deepening discussion of the same facts.
  if (opts.expandFrom && opts.expandFrom.segments) {
    const cur = estimateDuration(opts.expandFrom);
    const targetWords = Math.ceil((MAX_BROADCAST_SECONDS / 60) * WORDS_PER_MINUTE);
    const needWords = Math.max(60, targetWords - cur.words);
    messages.push({
      role: 'assistant',
      content: JSON.stringify({ segments: opts.expandFrom.segments }),
    });
    messages.push({
      role: 'user',
      content: [
        `That draft runs about ${cur.seconds} seconds — under the 6-minute (${MIN_BROADCAST_SECONDS}s) mandate.`,
        `Expand it by roughly ${needWords} more words so the full broadcast runs 6 to 7 minutes.`,
        'Add depth to the EXISTING stories: more exchanges, additional angles, sharper debate, clearer "what it means" beats — keep every existing turn and lengthen the discussion.',
        'CRITICAL: do not invent any new facts, numbers, names, or sources. Expand only by examining the already-briefed facts more thoroughly. No filler or repetition.',
        'Return the COMPLETE expanded script as ONLY the JSON object.',
      ].join(' '),
    });
  }

  const body = {
    model: GROQ_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 6000,
    response_format: { type: 'json_object' },
  };

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeout: 30_000,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Groq API error ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned an empty script.');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse Groq script JSON: ${err.message}`);
  }

  return validateAndNormalizeScript(parsed, stories);
}

/**
 * Validate the model output and normalise it into a guaranteed-safe structure.
 * Drops malformed turns, enforces speaker names, and guarantees ordering.
 * @param {Object} parsed
 * @param {Array} stories
 * @returns {Object} { segments }
 */
function validateAndNormalizeScript(parsed, stories) {
  if (!parsed || !Array.isArray(parsed.segments)) {
    throw new Error('Script JSON missing "segments" array.');
  }

  const segments = [];
  for (const seg of parsed.segments) {
    if (!seg || !Array.isArray(seg.turns)) continue;
    const turns = seg.turns
      .filter(t => t && typeof t.text === 'string' && t.text.trim())
      .map(t => ({
        speaker: t.speaker === 'BRANDON' ? 'BRANDON' : 'JANE', // default to JANE if malformed
        text: t.text.trim(),
      }));
    if (turns.length === 0) continue;

    const type = ['intro', 'story', 'outro'].includes(seg.type) ? seg.type : 'story';
    const out = { type, turns };
    if (type === 'story') {
      out.storyIndex = Number.isInteger(seg.storyIndex) ? seg.storyIndex : segments.filter(s => s.type === 'story').length;
      out.headline = typeof seg.headline === 'string' ? seg.headline : (stories[out.storyIndex]?.headline || '');
    }
    segments.push(out);
  }

  if (segments.length === 0) throw new Error('Script contained no usable segments after validation.');

  // Depth report: flag story segments that came back too thin so the caller
  // can decide whether to regenerate. We do NOT fabricate turns to pad — depth
  // must come from the model genuinely examining the facts, not synthetic filler.
  const MIN_STORY_TURNS = 6;
  const storySegments = segments.filter(s => s.type === 'story');
  const thinStories = storySegments.filter(s => s.turns.length < MIN_STORY_TURNS);
  const depth = {
    storyCount: storySegments.length,
    minStoryTurns: MIN_STORY_TURNS,
    thinStoryCount: thinStories.length,
    storyTurnCounts: storySegments.map(s => s.turns.length),
    isRich: thinStories.length === 0,
  };

  return { segments, depth };
}

/**
 * Flatten a script into an ordered list of speech turns for TTS.
 * @param {Object} script
 * @returns {Array<{ speaker, text, segmentType, headline? }>}
 */
function flattenTurns(script) {
  const turns = [];
  for (const seg of script.segments) {
    for (const t of seg.turns) {
      turns.push({
        speaker: t.speaker,
        text: t.text,
        segmentType: seg.type,
        headline: seg.headline,
      });
    }
  }
  return turns;
}

/**
 * Render a script to a clean, human-readable transcript string.
 * @param {Object} script
 * @param {Object} meta
 * @returns {string}
 */
function renderScriptText(script, meta) {
  const lines = [];
  lines.push(`EDGX NEWS — ${meta.hourLabel}, ${meta.dateLabel}`);
  lines.push('='.repeat(52));
  lines.push('');

  for (const seg of script.segments) {
    if (seg.type === 'intro') lines.push('[ OPENING ]');
    else if (seg.type === 'outro') lines.push('[ SIGN-OFF ]');
    else lines.push(`[ STORY ${(seg.storyIndex ?? 0) + 1}: ${seg.headline} ]`);
    lines.push('');
    for (const t of seg.turns) {
      lines.push(`${t.speaker}:  ${t.text}`);
      lines.push('');
    }
    lines.push('-'.repeat(52));
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  generateScript,
  flattenTurns,
  renderScriptText,
  validateAndNormalizeScript,
  estimateDuration,
  MIN_BROADCAST_SECONDS,
  MAX_BROADCAST_SECONDS,
  GROQ_MODEL,
};
