const fs = require("fs");
const path = require("path");

const SNOOZE_FILE = path.join(__dirname, "snooze.json");
let snoozeState = {};

function loadSnooze() {
    try {
        if (fs.existsSync(SNOOZE_FILE)) {
            const data = JSON.parse(fs.readFileSync(SNOOZE_FILE, "utf8"));
            const now = Date.now();
            for (const [k, v] of Object.entries(data)) {
                if (v.until > now) snoozeState[k] = v;
            }
        }
    } catch (e) {
        snoozeState = {};
    }
}

function saveSnooze() {
    try {
        fs.writeFileSync(SNOOZE_FILE, JSON.stringify(snoozeState, null, 2));
    } catch (e) {
        console.error("❌ Failed to save snooze state:", e.message);
    }
}

function isSnoozeActive(target) {
    const s = snoozeState[target];
    return !!(s && Date.now() < s.until);
}

/**
 * Snooze a target for a number of minutes
 * @param {string} target - "global", "camera:<name>", or "group:<name>"
 * @param {number} minutes
 */
function setSnoozeFor(target, minutes) {
    const until = Date.now() + minutes * 60 * 1000;
    snoozeState[target] = {
        until,
        created: Date.now(),
        description: `${minutes} minute${minutes !== 1 ? "s" : ""}`,
    };
    saveSnooze();
}

/**
 * Snooze a target until a specific datetime
 * @param {string} target
 * @param {string} isoDatetime - ISO 8601 datetime string
 */
function setSnoozeUntil(target, isoDatetime) {
    const until = new Date(isoDatetime).getTime();
    if (isNaN(until)) throw new Error("Invalid datetime: " + isoDatetime);
    snoozeState[target] = {
        until,
        created: Date.now(),
        description: `until ${new Date(until).toLocaleString()}`,
    };
    saveSnooze();
}

/**
 * Clear snooze for a target, or all snoozes if target is omitted
 * @param {string|undefined} target
 */
function clearSnooze(target) {
    if (target) {
        delete snoozeState[target];
    } else {
        snoozeState = {};
    }
    saveSnooze();
}

function formatRemaining(ms) {
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
}

/**
 * Get all currently active snoozes with remaining time info
 */
function getSnoozeState() {
    const now = Date.now();
    const result = {};
    for (const [target, data] of Object.entries(snoozeState)) {
        if (now < data.until) {
            result[target] = {
                ...data,
                remaining_ms: data.until - now,
                remaining_display: formatRemaining(data.until - now),
                until_display: new Date(data.until).toLocaleString(),
            };
        }
    }
    return result;
}

/**
 * Check if alerts should be suppressed for a given camera/group
 * @param {string} camera - camera name
 * @param {string|null} group - group name (optional)
 * @returns {boolean}
 */
function shouldSnooze(camera, group) {
    if (isSnoozeActive("global")) return true;
    if (camera && isSnoozeActive(`camera:${camera}`)) return true;
    if (group && isSnoozeActive(`group:${group}`)) return true;
    return false;
}

// Clean up expired snoozes periodically
setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(snoozeState)) {
        if (now >= v.until) {
            delete snoozeState[k];
            changed = true;
        }
    }
    if (changed) saveSnooze();
}, 60000);

loadSnooze();

module.exports = {
    setSnoozeFor,
    setSnoozeUntil,
    clearSnooze,
    getSnoozeState,
    shouldSnooze,
    isSnoozeActive,
};
