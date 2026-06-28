'use strict';

/**
 * speech-engines.js — Three proprietary broadcast-production engines.
 *
 *   1. ProsodyEngine™   — punctuation normalisation + SSML-style modulation
 *                         (emphasis, pauses, pacing, pitch) per speaker.
 *   2. DialogueWeave™   — restructures a story's turns into a genuine two-
 *                         perspective debate with cadence + reactive hand-offs.
 *   3. VoiceDirector™   — maps segment/emotional register → ElevenLabs
 *                         voice_settings dynamically, per anchor.
 *
 * Determinism guarantee:
 *   Pure functions of their inputs. No Math.random(), no Date.now(), no I/O.
 *   Identical input → byte-identical output.
 *
 * These engines sit BETWEEN script generation (Groq) and TTS (ElevenLabs):
 *     script → DialogueWeave → ProsodyEngine → VoiceDirector → tts.renderTurn
 */

// ════════════════════════════════════════════════════════════════════════
//  Shared anchor profiles
// ════════════════════════════════════════════════════════════════════════

/**
 * Per-anchor delivery profiles. These bias prosody and voice direction so the
 * two anchors sound distinct and complementary.
 *   - JANE: lead anchor — measured, authoritative, slightly warmer.
 *   - BRANDON: analyst — crisper, more dynamic, leans into emphasis on debate.
 */
const ANCHOR_PROFILE = {
  JANE: {
    basePauseMs:    180,   // baseline inter-clause pause
    emphasisRate:   0.85,  // relative likelihood of emphasising salient words
    sentenceDrawl:  1.0,   // pacing multiplier
    pitchBias:      0,     // semitone bias (kept neutral; ElevenLabs has no pitch param, used for SSML-capable engines)
  },
  BRANDON: {
    basePauseMs:    140,
    emphasisRate:   1.0,
    sentenceDrawl:  0.95,
    pitchBias:      -1,
  },
};

// Domain-salient terms that should receive vocal emphasis when present.
const EMPHASIS_LEXICON = new Set([
  'surged','plunged','soared','collapsed','record','historic','unexpected','sharply',
  'breaking','warned','rejected','rejects','unprecedented','crucial','critical',
  'billion','trillion','percent','rate','rates','inflation','recession','rally','selloff',
  'cut','hike','steady','unchanged','default','sanctions','tariff','crisis','breakthrough',
  'highest','lowest','first','never','surge','plunge','spike','crash','rebound',
]);

// ════════════════════════════════════════════════════════════════════════
//  Engine 1 — ProsodyEngine™
// ════════════════════════════════════════════════════════════════════════

/**
 * Normalise punctuation for clean, broadcast-correct delivery, then annotate
 * the text with lightweight SSML so capable TTS engines deliver correct rhythm.
 *
 * Two outputs are produced for each turn:
 *   - speakText: punctuation-normalised plain text (always safe for ElevenLabs,
 *     which honours commas/periods/dashes for natural pacing).
 *   - ssml: an SSML <speak> string with <emphasis>, <break>, and prosody hints
 *     for engines that accept SSML. ElevenLabs uses the normalised text; the
 *     SSML is provided for portability and for the on-screen "direction" view.
 *
 * @param {string} rawText
 * @param {string} speaker  'JANE' | 'BRANDON'
 * @returns {{ speakText: string, ssml: string, marks: Object }}
 */
function applyProsody(rawText, speaker) {
  const profile = ANCHOR_PROFILE[speaker] || ANCHOR_PROFILE.JANE;

  // ── Punctuation normalisation ──────────────────────────────────────────
  let t = String(rawText).trim();

  // Standardise quotes and dashes.
  t = t
    .replace(/[\u2018\u2019]/g, "'")        // curly single quotes → '
    .replace(/[\u201C\u201D]/g, '"')        // curly double quotes → "
    .replace(/\s*--\s*/g, ' \u2014 ')        // double hyphen → em dash
    .replace(/\s*-\s+/g, ' \u2014 ')         // spaced hyphen → em dash
    .replace(/\s+/g, ' ')                     // collapse whitespace
    .replace(/\s+([,.;:!?])/g, '$1')          // no space before punctuation
    .replace(/([,.;:!?])(?=[^\s"'\)\]])/g, '$1 '); // ensure space after punctuation

  // Expand a few common abbreviations for clearer TTS pronunciation.
  t = t
    .replace(/\bU\.S\.\b/g, 'U S')
    .replace(/\bU\.K\.\b/g, 'U K')
    .replace(/\bFed\b/g, 'Fed')               // keep as-is (proper noun)
    .replace(/\bvs\.?\s/gi, 'versus ')
    .replace(/\bapprox\.?\s/gi, 'approximately ')
    .replace(/\bpct\b/gi, 'percent')
    .replace(/%/g, ' percent');

  // Ensure terminal punctuation so the sentence lands properly.
  if (!/[.!?]"?$/.test(t)) t += '.';

  // ── SSML annotation (emphasis + breaks) ────────────────────────────────
  const words = t.split(/(\s+)/); // keep whitespace tokens
  let emphasised = 0;
  const ssmlWords = words.map(tok => {
    if (/^\s+$/.test(tok)) return tok;
    const bare = tok.replace(/[^A-Za-z]/g, '').toLowerCase();
    if (bare && EMPHASIS_LEXICON.has(bare)) {
      emphasised++;
      return `<emphasis level="moderate">${tok}</emphasis>`;
    }
    return tok;
  });

  // Insert breaks after sentence-internal punctuation for cadence.
  let ssmlBody = ssmlWords.join('');
  const clausePause = Math.round(profile.basePauseMs);
  const sentencePause = Math.round(profile.basePauseMs * 2.2);
  ssmlBody = ssmlBody
    .replace(/([,;:])\s/g, `$1<break time="${clausePause}ms"/> `)
    .replace(/([.!?])(\s|$)/g, `$1<break time="${sentencePause}ms"/>$2`)
    .replace(/\u2014/g, `<break time="${clausePause}ms"/>\u2014`);

  const rate = profile.sentenceDrawl === 1 ? 'medium' : (profile.sentenceDrawl < 1 ? 'fast' : 'slow');
  const ssml = `<speak><prosody rate="${rate}">${ssmlBody}</prosody></speak>`;

  return {
    speakText: t,
    ssml,
    marks: { emphasised, clausePause, sentencePause, rate },
  };
}

// ════════════════════════════════════════════════════════════════════════
//  Engine 2 — DialogueWeave™
// ════════════════════════════════════════════════════════════════════════

/**
 * Stance assignment for the two anchors on a given story. Deterministically
 * chosen from the story's signature so the same story always yields the same
 * framing, while different stories vary.
 *
 * Stances are complementary lenses, NOT fabricated facts — they shape HOW the
 * anchors discuss the supplied facts (data-led vs. context/skeptic, etc.).
 */
const STANCE_PAIRS = [
  { jane: 'data-led',     brandon: 'skeptical'   },
  { jane: 'market-impact',brandon: 'human-impact' },
  { jane: 'what-happened',brandon: 'what-it-means' },
  { jane: 'optimistic',   brandon: 'cautious'    },
  { jane: 'near-term',    brandon: 'long-term'   },
];

/**
 * Pick a stance pair deterministically from a story headline.
 * @param {string} headline
 * @returns {{ jane, brandon }}
 */
function pickStance(headline) {
  let h = 0;
  const s = String(headline);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return STANCE_PAIRS[h % STANCE_PAIRS.length];
}

/**
 * Analyse a story segment's turns and annotate them as a structured debate.
 *
 * This does NOT invent dialogue (the words come from Groq); it CLASSIFIES and
 * ORDERS the existing turns into debate roles, marks reactive beats, and tags
 * cadence so downstream prosody/voice direction can modulate correctly.
 *
 * Each annotated turn gains:
 *   - role:    'setup' | 'analysis' | 'counterpoint' | 'rebuttal' | 'handoff'
 *   - stance:  the lens this speaker is carrying for the story
 *   - beat:    'open' | 'develop' | 'tension' | 'resolve'
 *   - reactive:true if it directly responds to the previous turn
 *
 * @param {Object} segment  — a 'story' segment { turns, headline, storyIndex }
 * @returns {Object} annotated segment
 */
function weaveStory(segment) {
  const stance = pickStance(segment.headline || '');
  const turns = segment.turns || [];
  const n = turns.length;

  const annotated = turns.map((turn, i) => {
    const isJane = turn.speaker === 'JANE';
    const speakerStance = isJane ? stance.jane : stance.brandon;

    // Role inference from position within the segment.
    let role;
    if (i === 0) role = 'setup';
    else if (i === n - 1 && n > 2) role = 'handoff';
    else if (i % 2 === 1) role = 'analysis';
    else role = 'counterpoint';

    // Rebuttal: a counterpoint that follows an analysis is a rebuttal.
    if (role === 'counterpoint' && i >= 2) role = 'rebuttal';

    // Beat mapping across the segment arc.
    let beat;
    const frac = n > 1 ? i / (n - 1) : 0;
    if (frac === 0) beat = 'open';
    else if (frac < 0.5) beat = 'develop';
    else if (frac < 1) beat = 'tension';
    else beat = 'resolve';

    // Reactive: any turn after the first that switches speaker reacts.
    const reactive = i > 0 && turns[i - 1].speaker !== turn.speaker;

    return {
      ...turn,
      role,
      stance: speakerStance,
      beat,
      reactive,
    };
  });

  return { ...segment, stance, turns: annotated };
}

/**
 * Apply DialogueWeave to a full script (only 'story' segments are restructured;
 * intro/outro keep simpler annotation).
 * @param {Object} script
 * @returns {Object} annotated script
 */
function weaveScript(script) {
  const segments = (script.segments || []).map(seg => {
    if (seg.type === 'story') return weaveStory(seg);
    // intro/outro: light annotation
    const turns = (seg.turns || []).map((t, i) => ({
      ...t,
      role: seg.type === 'intro' ? (i === 0 ? 'open' : 'greet') : 'signoff',
      beat: seg.type === 'intro' ? 'open' : 'resolve',
      reactive: i > 0,
      stance: null,
    }));
    return { ...seg, turns };
  });
  return { ...script, segments };
}

// ════════════════════════════════════════════════════════════════════════
//  Engine 3 — VoiceDirector™
// ════════════════════════════════════════════════════════════════════════

/**
 * Base ElevenLabs voice_settings per anchor. Direction nudges these per beat.
 */
const VOICE_BASE = {
  JANE:    { stability: 0.50, similarity_boost: 0.78, style: 0.30 },
  BRANDON: { stability: 0.45, similarity_boost: 0.75, style: 0.38 },
};

/**
 * Beat → delivery adjustment. Higher style = more expressive; lower stability =
 * more dynamic/variable. Tension beats get more energy; resolves settle down.
 */
const BEAT_DIRECTION = {
  open:    { stability: +0.05, style: -0.05 }, // composed, clear
  greet:   { stability: +0.03, style: +0.02 },
  develop: { stability:  0.00, style: +0.03 },
  tension: { stability: -0.08, style: +0.12 }, // leaning into debate
  resolve: { stability: +0.06, style: -0.04 }, // calm landing
  signoff: { stability: +0.05, style: -0.02 },
};

/**
 * Role → micro-adjustment, layered on top of beat direction.
 */
const ROLE_DIRECTION = {
  setup:        { style: +0.02 },
  analysis:     { style: +0.04 },
  counterpoint: { stability: -0.04, style: +0.06 },
  rebuttal:     { stability: -0.06, style: +0.08 },
  handoff:      { stability: +0.03, style: -0.02 },
  open:         {},
  greet:        {},
  signoff:      {},
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Compute ElevenLabs voice_settings for a single annotated turn.
 *
 * @param {Object} turn  — annotated turn (speaker, role, beat, reactive)
 * @returns {{ voiceSettings: Object, direction: string }}
 */
function directTurn(turn) {
  const base = VOICE_BASE[turn.speaker] || VOICE_BASE.JANE;
  const beat = BEAT_DIRECTION[turn.beat] || {};
  const role = ROLE_DIRECTION[turn.role] || {};

  const stability = clamp(
    base.stability + (beat.stability || 0) + (role.stability || 0), 0.15, 0.9);
  const style = clamp(
    base.style + (beat.style || 0) + (role.style || 0), 0.0, 0.9);
  // Reactive turns get a slight similarity nudge for conversational continuity.
  const similarity = clamp(
    base.similarity_boost + (turn.reactive ? 0.02 : 0), 0.5, 0.95);

  const voiceSettings = {
    stability: round2(stability),
    similarity_boost: round2(similarity),
    style: round2(style),
    use_speaker_boost: true,
  };

  const direction =
    `${turn.speaker} · ${turn.beat}/${turn.role}` +
    (turn.reactive ? ' · reactive' : '') +
    ` · stab ${voiceSettings.stability} style ${voiceSettings.style}`;

  return { voiceSettings, direction };
}

function round2(v) { return Math.round(v * 100) / 100; }

// ════════════════════════════════════════════════════════════════════════
//  Orchestrating entry point
// ════════════════════════════════════════════════════════════════════════

/**
 * Run all three engines over a script, producing a "production script" whose
 * turns are fully annotated and ready for TTS with per-turn voice settings and
 * prosody-normalised text.
 *
 * @param {Object} script  — validated Groq script { segments }
 * @returns {Object} production script
 */
function produceScript(script) {
  const woven = weaveScript(script);

  const segments = woven.segments.map(seg => {
    const turns = seg.turns.map(turn => {
      const prosody = applyProsody(turn.text, turn.speaker);
      const { voiceSettings, direction } = directTurn(turn);
      return {
        ...turn,
        speakText:     prosody.speakText,
        ssml:          prosody.ssml,
        prosodyMarks:  prosody.marks,
        voiceSettings,
        direction,
      };
    });
    return { ...seg, turns };
  });

  return { ...woven, segments, produced: true };
}

/**
 * Flatten a produced script into TTS-ready turns carrying their own voice
 * settings and prosody-normalised text.
 * @param {Object} produced
 * @returns {Array<{ speaker, text, speakText, voiceSettings, segmentType, headline }>}
 */
function flattenProduced(produced) {
  const out = [];
  for (const seg of produced.segments) {
    for (const t of seg.turns) {
      out.push({
        speaker:       t.speaker,
        text:          t.text,
        speakText:     t.speakText,
        ssml:          t.ssml,
        voiceSettings: t.voiceSettings,
        direction:     t.direction,
        segmentType:   seg.type,
        headline:      seg.headline,
      });
    }
  }
  return out;
}

module.exports = {
  produceScript,
  flattenProduced,
  applyProsody,
  weaveScript,
  weaveStory,
  directTurn,
  pickStance,
  ANCHOR_PROFILE,
  VOICE_BASE,
};
