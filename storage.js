'use strict';

/**
 * storage.js — Durable storage configuration and helpers.
 *
 * Single source of truth for WHERE the broadcast archive and feed-health state
 * live, plus atomic write helpers so a crash mid-write can never corrupt an
 * existing file.
 *
 * Durability model:
 *   - In production (Railway), set BROADCAST_DIR to a mounted Volume path
 *     (e.g. /data). A Volume survives redeploys and restarts.
 *   - Without a Volume, BROADCAST_DIR points at the container filesystem, which
 *     is EPHEMERAL — wiped on redeploy. The app still runs, but the archive and
 *     quarantine memory reset. `describeStorage()` reports this so it's visible.
 *
 * Atomic writes:
 *   writeFileAtomic() writes to a temp file in the same directory, fsyncs, then
 *   renames over the target. rename() within a filesystem is atomic, so readers
 *   never see a half-written file and an existing file is only replaced once the
 *   new content is fully on disk.
 */

const fs   = require('fs');
const path = require('path');

// Resolve the storage directory once. A Volume mount is detected by the env var
// pointing somewhere outside the app directory (the conventional Railway pattern
// is an absolute path like /data).
const DATA_DIR = process.env.BROADCAST_DIR || path.join(__dirname, 'broadcasts');

// A marker file lets us prove, across restarts, whether storage actually
// persisted (used by the durability self-check).
const PERSIST_MARKER = '.persist-marker.json';

/**
 * Ensure the storage directory exists. Safe to call repeatedly.
 * @returns {string} the resolved directory
 */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

/**
 * Whether the configured directory is writable right now.
 * @returns {boolean}
 */
function isWritable() {
  try {
    ensureDir();
    const probe = path.join(DATA_DIR, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Heuristic: is this directory likely a durable Volume mount, or ephemeral
 * container storage? We treat an absolute path outside the app dir as a Volume.
 * This is a hint for operators, not a guarantee.
 * @returns {boolean}
 */
function looksDurable() {
  const configured = process.env.BROADCAST_DIR;
  if (!configured) return false;                 // default = ephemeral app dir
  const resolved = path.resolve(configured);
  const appDir   = path.resolve(__dirname);
  // Inside the app directory → ephemeral. Outside (e.g. /data) → likely a Volume.
  return !resolved.startsWith(appDir);
}

/**
 * Atomic file write: temp file → fsync → rename over target.
 * @param {string} filePath  — absolute target path
 * @param {string|Buffer} data
 */
function writeFileAtomic(filePath, data) {
  ensureDir();
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);            // force bytes to disk before we rename
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);  // atomic replace
}

/**
 * Convenience JSON writer (atomic).
 * @param {string} filePath
 * @param {*} obj
 */
function writeJsonAtomic(filePath, obj) {
  writeFileAtomic(filePath, JSON.stringify(obj, null, 2));
}

/**
 * Resolve a path within the storage directory.
 * @param {string} name
 * @returns {string}
 */
function pathIn(name) {
  return path.join(DATA_DIR, name);
}

/**
 * Update the persistence marker (records each boot). If the marker already
 * exists from a previous boot, storage persisted across that restart.
 * @returns {{ persistedAcrossRestart: boolean, marker: Object }}
 */
function touchPersistMarker() {
  ensureDir();
  const markerPath = pathIn(PERSIST_MARKER);
  let previous = null;
  try {
    if (fs.existsSync(markerPath)) previous = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (_) { previous = null; }

  const marker = {
    firstSeen: previous?.firstSeen || new Date().toISOString(),
    lastBoot:  new Date().toISOString(),
    boots:     (previous?.boots || 0) + 1,
  };
  try { writeJsonAtomic(markerPath, marker); } catch (_) { /* best effort */ }

  return { persistedAcrossRestart: !!previous, marker };
}

/**
 * A human-readable storage status for the preflight / health endpoints.
 * @returns {Object}
 */
function describeStorage() {
  const writable = isWritable();
  const durable  = looksDurable();
  let bulletinCount = 0;
  let markerBoots = 0;
  try {
    bulletinCount = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('-manifest.json')).length;
  } catch (_) {}
  try {
    const m = JSON.parse(fs.readFileSync(pathIn(PERSIST_MARKER), 'utf8'));
    markerBoots = m.boots || 0;
  } catch (_) {}

  return {
    dir: DATA_DIR,
    configuredVia: process.env.BROADCAST_DIR ? 'BROADCAST_DIR env' : 'default (app directory)',
    writable,
    durable,
    durabilityNote: durable
      ? 'Path looks like a mounted Volume — bulletins and feed-health persist across redeploys.'
      : 'EPHEMERAL: container filesystem. Set BROADCAST_DIR to a Railway Volume mount (e.g. /data) to persist across redeploys.',
    bulletinCount,
    bootsSeen: markerBoots,
  };
}

module.exports = {
  DATA_DIR,
  ensureDir,
  isWritable,
  looksDurable,
  writeFileAtomic,
  writeJsonAtomic,
  pathIn,
  touchPersistMarker,
  describeStorage,
};
