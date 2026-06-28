'use strict';

/**
 * feed-health.js — RSS feed health tracking and automatic pruning.
 *
 * Purpose:
 *   Track each RSS feed's fetch outcomes across runs, persist the history, and
 *   automatically quarantine ("prune") feeds that fail repeatedly so the
 *   orchestrator stops wasting time on dead URLs. Quarantined feeds are retried
 *   occasionally so a temporarily-down feed can self-heal.
 *
 * Storage:
 *   A single JSON file (feed-health.json) under BROADCAST_DIR. One record per
 *   feed URL: consecutive failures, last status, totals, quarantine state.
 *
 * Policy (configurable):
 *   - A feed is QUARANTINED after `failThreshold` consecutive failures.
 *   - A quarantined feed is retried once every `retryAfterMs` (probation) so it
 *     can recover; a single success clears quarantine immediately.
 *   - Health state is pure data — decisions are deterministic given the record.
 */

const fs   = require('fs');
const path = require('path');

const DEFAULTS = {
  failThreshold: 3,            // consecutive failures before quarantine
  retryAfterMs:  6 * 3600_000, // re-probe a quarantined feed every 6 hours
};

class FeedHealth {
  /**
   * @param {Object} opts { dir, failThreshold, retryAfterMs }
   */
  constructor(opts = {}) {
    this.dir = opts.dir || require('./storage').DATA_DIR;
    this.file = path.join(this.dir, 'feed-health.json');
    this.failThreshold = opts.failThreshold ?? DEFAULTS.failThreshold;
    this.retryAfterMs  = opts.retryAfterMs  ?? DEFAULTS.retryAfterMs;
    this.records = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        this.records = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
      }
    } catch (_) {
      this.records = {};
    }
  }

  _save() {
    try {
      const storage = require('./storage');
      storage.writeJsonAtomic(this.file, this.records);
    } catch (_) { /* non-fatal: health is best-effort */ }
  }

  /**
   * Get (or lazily create) the record for a feed URL.
   * @param {string} url
   * @returns {Object}
   */
  _rec(url) {
    if (!this.records[url]) {
      this.records[url] = {
        url,
        consecutiveFailures: 0,
        totalSuccess: 0,
        totalFailure: 0,
        lastStatus: 'unknown',   // 'ok' | 'fail' | 'unknown'
        lastError: '',
        lastOkAt: null,
        lastTriedAt: null,
        lastItemCount: 0,
        quarantined: false,
        quarantinedAt: null,
      };
    }
    return this.records[url];
  }

  /**
   * Decide whether a feed should be fetched this run.
   * Healthy feeds: always. Quarantined feeds: only when probation elapsed.
   * @param {string} url
   * @param {number} nowMs
   * @returns {boolean}
   */
  shouldFetch(url, nowMs = Date.now()) {
    const r = this.records[url];
    if (!r || !r.quarantined) return true;
    // Probation: allow a retry if enough time has passed since last attempt.
    const since = r.lastTriedAt ? (nowMs - r.lastTriedAt) : Infinity;
    return since >= this.retryAfterMs;
  }

  /**
   * Record a successful fetch. Clears failures and quarantine.
   * @param {string} url
   * @param {number} itemCount
   * @param {number} nowMs
   */
  recordSuccess(url, itemCount = 0, nowMs = Date.now()) {
    const r = this._rec(url);
    r.consecutiveFailures = 0;
    r.totalSuccess += 1;
    r.lastStatus = 'ok';
    r.lastError = '';
    r.lastOkAt = nowMs;
    r.lastTriedAt = nowMs;
    r.lastItemCount = itemCount;
    if (r.quarantined) {
      r.quarantined = false;
      r.quarantinedAt = null;
    }
  }

  /**
   * Record a failed fetch. Quarantines after the failure threshold.
   * @param {string} url
   * @param {string} errMsg
   * @param {number} nowMs
   * @returns {boolean} true if this failure newly quarantined the feed
   */
  recordFailure(url, errMsg = '', nowMs = Date.now()) {
    const r = this._rec(url);
    r.consecutiveFailures += 1;
    r.totalFailure += 1;
    r.lastStatus = 'fail';
    r.lastError = String(errMsg).slice(0, 200);
    r.lastTriedAt = nowMs;

    let newlyQuarantined = false;
    if (!r.quarantined && r.consecutiveFailures >= this.failThreshold) {
      r.quarantined = true;
      r.quarantinedAt = nowMs;
      newlyQuarantined = true;
    }
    return newlyQuarantined;
  }

  /**
   * Persist all pending changes. Call once after a batch of record* calls.
   */
  flush() { this._save(); }

  /**
   * Partition a list of sources into those to fetch now and those skipped
   * (still quarantined and not yet due for probation).
   * @param {Array<{url}>} sources
   * @param {number} nowMs
   * @returns {{ active: Array, skipped: Array }}
   */
  partition(sources, nowMs = Date.now()) {
    const active = [], skipped = [];
    for (const s of sources) {
      if (this.shouldFetch(s.url, nowMs)) active.push(s);
      else skipped.push(s);
    }
    return { active, skipped };
  }

  /**
   * A serialisable health report for the admin endpoint.
   * @returns {Object}
   */
  report() {
    const all = Object.values(this.records);
    const quarantined = all.filter(r => r.quarantined);
    const healthy = all.filter(r => !r.quarantined && r.lastStatus === 'ok');
    return {
      tracked: all.length,
      healthy: healthy.length,
      quarantined: quarantined.length,
      failThreshold: this.failThreshold,
      retryAfterMs: this.retryAfterMs,
      feeds: all
        .slice()
        .sort((a, b) => (b.quarantined - a.quarantined) || (b.totalFailure - a.totalFailure))
        .map(r => ({
          url: r.url,
          status: r.quarantined ? 'quarantined' : r.lastStatus,
          consecutiveFailures: r.consecutiveFailures,
          totalSuccess: r.totalSuccess,
          totalFailure: r.totalFailure,
          lastItemCount: r.lastItemCount,
          lastError: r.lastError,
          lastOkAt: r.lastOkAt,
          lastTriedAt: r.lastTriedAt,
        })),
    };
  }

  /**
   * Manually clear a feed's quarantine and failure count (admin override).
   * @param {string} url
   * @returns {boolean} whether a record existed
   */
  reset(url) {
    const r = this.records[url];
    if (!r) return false;
    r.consecutiveFailures = 0;
    r.quarantined = false;
    r.quarantinedAt = null;
    r.lastStatus = 'unknown';
    r.lastError = '';
    this._save();
    return true;
  }

  /**
   * Manually quarantine a feed (admin override).
   * @param {string} url
   * @param {number} nowMs
   * @returns {boolean}
   */
  quarantine(url, nowMs = Date.now()) {
    const r = this._rec(url);
    r.quarantined = true;
    r.quarantinedAt = nowMs;
    this._save();
    return true;
  }
}

module.exports = { FeedHealth };
