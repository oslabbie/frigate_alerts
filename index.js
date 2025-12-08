require("dotenv").config();
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

// Load configuration
const CONFIG_PATH = process.env.CONFIG_PATH || "./config.json";
let config;

try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    console.log("✅ Configuration loaded from", CONFIG_PATH);
} catch (error) {
    console.error("❌ Failed to load config file:", error.message);
    console.log(
        "📝 Please create a config.json file based on config.example.json"
    );
    process.exit(1);
}

// Configuration with fallbacks to environment variables for backwards compatibility
const TELEGRAM_BOT_TOKEN =
    config.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
const FRIGATE_API_URL = config.frigate_api_url || process.env.API_URL;
const POLL_INTERVAL = (config.poll_interval_seconds || 10) * 1000;
const WEBHOOK_URL = config.webhook_url || process.env.WEBHOOK_TRIGGER;

// Validate required configuration
if (!TELEGRAM_BOT_TOKEN) {
    console.error("❌ Missing telegram_bot_token in config");
    process.exit(1);
}

if (!FRIGATE_API_URL) {
    console.error("❌ Missing frigate_api_url in config");
    process.exit(1);
}

if (!config.groups || Object.keys(config.groups).length === 0) {
    console.error("❌ No groups defined in config");
    process.exit(1);
}

/**
 * Get the list of group names assigned to a camera
 * @param {string} cameraName
 * @returns {Array<string>}
 */
function getGroupNamesForCamera(cameraName) {
    const cameraConfig = config.cameras?.[cameraName];
    return (
        cameraConfig?.groups ||
        config.default_groups ||
        Object.keys(config.groups)
    );
}

/**
 * Get enabled groups that should receive alerts for a camera
 * @param {string} cameraName
 * @returns {Array<{name: string, chat_id: string}>}
 */
function getGroupsForCamera(cameraName) {
    const groupNames = getGroupNamesForCamera(cameraName);

    return groupNames
        .filter((name) => config.groups[name]?.enabled !== false)
        .map((name) => ({
            name,
            chat_id: config.groups[name]?.chat_id,
        }))
        .filter((g) => g.chat_id);
}

/**
 * Check if the current time is within a schedule
 * @param {string} startTime
 * @param {string} endTime
 * @returns {boolean}
 */
function isWithinSchedule(startTime, endTime) {
    const now = new Date();
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const [endHour, endMinute] = endTime.split(":").map(Number);

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    if (startMinutes <= endMinutes) {
        return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    } else {
        // Timeframe crosses midnight
        return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
    }
}

/**
 * Get schedule for a specific camera + group combination
 * Priority: camera.group_schedules.X > camera.schedule > group.schedule > default_schedule
 * @param {string} cameraName
 * @param {string} groupName
 * @returns {{start_time: string, end_time: string, always_send: boolean}}
 */
function getScheduleForCameraAndGroup(cameraName, groupName) {
    const cameraConfig = config.cameras?.[cameraName];
    const groupConfig = config.groups?.[groupName];
    const defaultSchedule = config.default_schedule || {
        start_time: "00:00",
        end_time: "23:59",
        always_send: false,
    };

    // Check for camera-specific group schedule (most specific)
    const cameraGroupConfig = cameraConfig?.group_schedules?.[groupName];
    if (
        cameraGroupConfig?.schedule ||
        cameraGroupConfig?.always_send !== undefined
    ) {
        return {
            start_time:
                cameraGroupConfig?.schedule?.start_time ||
                cameraConfig?.schedule?.start_time ||
                groupConfig?.schedule?.start_time ||
                defaultSchedule.start_time,
            end_time:
                cameraGroupConfig?.schedule?.end_time ||
                cameraConfig?.schedule?.end_time ||
                groupConfig?.schedule?.end_time ||
                defaultSchedule.end_time,
            always_send:
                cameraGroupConfig?.always_send ??
                cameraConfig?.always_send ??
                groupConfig?.always_send ??
                defaultSchedule.always_send ??
                false,
        };
    }

    // Check for camera schedule
    if (cameraConfig?.schedule || cameraConfig?.always_send !== undefined) {
        return {
            start_time:
                cameraConfig?.schedule?.start_time ||
                groupConfig?.schedule?.start_time ||
                defaultSchedule.start_time,
            end_time:
                cameraConfig?.schedule?.end_time ||
                groupConfig?.schedule?.end_time ||
                defaultSchedule.end_time,
            always_send:
                cameraConfig?.always_send ??
                groupConfig?.always_send ??
                defaultSchedule.always_send ??
                false,
        };
    }

    // Check for group schedule
    if (groupConfig?.schedule || groupConfig?.always_send !== undefined) {
        return {
            start_time:
                groupConfig?.schedule?.start_time || defaultSchedule.start_time,
            end_time:
                groupConfig?.schedule?.end_time || defaultSchedule.end_time,
            always_send:
                groupConfig?.always_send ??
                defaultSchedule.always_send ??
                false,
        };
    }

    // Fall back to default schedule
    return {
        start_time: defaultSchedule.start_time,
        end_time: defaultSchedule.end_time,
        always_send: defaultSchedule.always_send ?? false,
    };
}

/**
 * Check if a group should receive an alert for an event
 * @param {string} cameraName
 * @param {string} groupName
 * @returns {boolean}
 */
function shouldAlertGroup(cameraName, groupName) {
    const schedule = getScheduleForCameraAndGroup(cameraName, groupName);

    if (schedule.always_send) {
        return true;
    }

    return isWithinSchedule(schedule.start_time, schedule.end_time);
}

/**
 * Get groups that should receive an alert for this event (respecting schedules and always_send)
 * @param {Object} event
 * @returns {Array<{name: string, chat_id: string, schedule: object}>}
 */
function getGroupsToAlert(event) {
    const allGroups = getGroupsForCamera(event.camera);

    return allGroups
        .filter((group) => shouldAlertGroup(event.camera, group.name))
        .map((group) => ({
            ...group,
            schedule: getScheduleForCameraAndGroup(event.camera, group.name),
        }));
}

/**
 * Get schedule configuration for a camera (for display purposes)
 * @param {string} cameraName
 * @returns {{start_time: string, end_time: string, always_send: boolean}}
 */
function getCameraSchedule(cameraName) {
    const cameraConfig = config.cameras?.[cameraName];
    const defaultSchedule = config.default_schedule || {
        start_time: "00:00",
        end_time: "23:59",
    };

    return {
        start_time:
            cameraConfig?.schedule?.start_time || defaultSchedule.start_time,
        end_time: cameraConfig?.schedule?.end_time || defaultSchedule.end_time,
        always_send:
            cameraConfig?.always_send ?? defaultSchedule.always_send ?? false,
    };
}

/**
 * Get allowed labels for a camera (if configured)
 * @param {string} cameraName
 * @returns {Array<string>|null} null means all labels allowed
 */
function getAllowedLabels(cameraName) {
    return config.cameras?.[cameraName]?.labels || null;
}

/**
 * Check if any group should receive alerts for this event
 * @param {Object} event
 * @returns {boolean}
 */
function shouldAlertAnyGroup(event) {
    const groupsToAlert = getGroupsToAlert(event);
    return groupsToAlert.length > 0;
}

/**
 * Check if an event's label is allowed for the camera
 * @param {Object} event
 * @returns {boolean}
 */
function isLabelAllowed(event) {
    const allowedLabels = getAllowedLabels(event.camera);
    if (!allowedLabels) return true; // No filter = all labels allowed
    return allowedLabels.includes(event.label);
}

/**
 * Send a message to a specific Telegram chat
 * @param {string} chatId
 * @param {string} message
 */
async function sendToTelegram(chatId, message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: chatId,
            text: message || "",
            parse_mode: "HTML",
        });
        console.log(`✅ Message sent to chat ${chatId}`);
    } catch (error) {
        console.error(
            `❌ Failed to send message to ${chatId}:`,
            error.response?.data || error.message
        );
    }
}

/**
 * Send media to a specific Telegram chat
 * @param {string} chatId
 * @param {Buffer} buffer
 * @param {string} caption
 * @param {string} fileName
 * @returns {boolean}
 */
async function sendMediaToTelegram(chatId, buffer, caption, fileName) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("document", buffer, { filename: fileName });
    if (caption) form.append("caption", caption);
    form.append("parse_mode", "HTML");

    try {
        await axios.post(url, form, { headers: form.getHeaders() });
        console.log(`✅ Media sent to chat ${chatId}`);
        return true;
    } catch (error) {
        console.error(
            `❌ Failed to send media to ${chatId}:`,
            error.response?.data || error.message
        );
        return false;
    }
}

/**
 * Send alert to all configured groups for a camera
 * @param {Object} event
 * @param {Buffer|null} mediaBuffer
 * @param {string} message
 * @param {string} fileName
 */
async function sendAlertToGroups(event, mediaBuffer, message, fileName) {
    const groups = getGroupsToAlert(event);

    if (groups.length === 0) {
        console.log(`⚠️ No groups configured for camera: ${event.camera}`);
        return;
    }

    console.log(
        `📤 Sending alert to ${groups.length} group(s): ${groups
            .map((g) => g.name)
            .join(", ")}`
    );

    const sendPromises = groups.map(async (group) => {
        if (mediaBuffer) {
            const sent = await sendMediaToTelegram(
                group.chat_id,
                mediaBuffer,
                message,
                fileName
            );
            if (!sent) {
                await sendToTelegram(
                    group.chat_id,
                    message + "\n⚠️ (Media failed to send)"
                );
            }
        } else {
            await sendToTelegram(group.chat_id, message);
        }
    });

    await Promise.all(sendPromises);
}

let lastEvent;
let lastTimestamp = 0;

/**
 * Fetch and process events from Frigate
 */
async function fetchFrigateEvents() {
    try {
        const response = await axios.get(`${FRIGATE_API_URL}/events`);
        const events = response.data;

        if (events.length > 0) {
            await new Promise((r) => setTimeout(r, 5000));

            for (const event of events) {
                if (!lastEvent || event.id === lastEvent.id) break;
                if (!isLabelAllowed(event)) {
                    console.log(
                        `🏷️ Event ${event.id} label "${event.label}" not in allowed list for ${event.camera}`
                    );
                    continue;
                }
                if (!shouldAlertAnyGroup(event)) {
                    console.log(
                        `⏰ Event ${event.id} outside schedule for ${event.camera} (no groups to alert)`
                    );
                    continue;
                }
                if (event.start_time < lastTimestamp) continue;

                processEvent(event);
            }

            lastEvent = events[0];
            lastTimestamp = Date.now() / 1000 - 10 * 60;
        }
    } catch (error) {
        console.error(
            "❌ Error fetching events:",
            error.response?.data || error.message
        );
    }
}

/**
 * Process a single Frigate event
 * @param {Object} event
 */
async function processEvent(event) {
    const schedule = getCameraSchedule(event.camera);
    const scheduleInfo = schedule.always_send
        ? "🔔 Always Send"
        : `⏰ ${schedule.start_time} - ${schedule.end_time}`;

    let message = `🚨 <b>Frigate Alert!</b>
📷 Camera: ${event.camera}
📌 Object: ${event.label}
⏳ Time: ${new Date(event.start_time * 1000).toLocaleString()}
${scheduleInfo}`;

    if (WEBHOOK_URL) triggerWebhook(event);

    const send = async () => {
        try {
            const videoRes = await downloadVideo(event);
            await sendAlertToGroups(event, videoRes, message, "video.mp4");
            return;
        } catch (e) {
            console.log("⚠️ Video download failed, trying snapshot...");
        }

        try {
            const snapshotRes = await downloadSnapshot(event);
            await sendAlertToGroups(
                event,
                snapshotRes,
                message,
                "snapshot.jpg"
            );
            return;
        } catch (e) {
            console.log("⚠️ Snapshot download failed, trying thumbnail...");
        }

        try {
            const thumbnailRes = await downloadThumbnail(event);
            await sendAlertToGroups(
                event,
                thumbnailRes,
                message,
                "thumbnail.jpg"
            );
            return;
        } catch (e) {
            console.log("⚠️ Thumbnail download failed");
        }

        console.error("❌ Failed to send any media for event:", event.id);
        message = `${message}\n⚠️ (No media available)`;
        await sendAlertToGroups(event, null, message, null);
    };

    if (event.has_clip && !event.end_time) {
        setTimeout(async () => {
            event.end_time = event.start_time + 5;
            send();
        }, 7000);
    } else {
        send();
    }
}

/**
 * Download video clip for an event
 * @param {Object} event
 * @returns {Promise<Buffer>}
 */
async function downloadVideo(event) {
    if (!event.end_time) {
        await new Promise((r) => {
            setTimeout(() => {
                event.end_time = event.start_time + 17;
                r();
            }, 20000);
        });
    }
    const url = `${FRIGATE_API_URL}/${event.camera}/start/${event.start_time}/end/${event.end_time}/clip.mp4`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
}

/**
 * Download snapshot for an event
 * @param {Object} event
 * @returns {Promise<Buffer>}
 */
async function downloadSnapshot(event) {
    const url = `${FRIGATE_API_URL}/events/${event.id}/snapshot.jpg`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
}

/**
 * Download thumbnail for an event
 * @param {Object} event
 * @returns {Promise<Buffer>}
 */
async function downloadThumbnail(event) {
    const url = `${FRIGATE_API_URL}/events/${event.id}/thumbnail.jpg`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
}

/**
 * Trigger webhook for an event
 * @param {Object} event
 */
async function triggerWebhook(event) {
    const payload = {
        event_id: event.id,
        camera: event.camera,
        label: event.label,
        start_time: event.start_time,
        end_time: event.end_time,
        groups: getGroupsForCamera(event.camera).map((g) => g.name),
    };

    try {
        await axios.post(WEBHOOK_URL, payload);
        console.log("✅ Webhook triggered successfully");
    } catch (error) {
        console.error("❌ Error triggering webhook:", error.message);
    }
}

// Print startup configuration summary
function printConfigSummary() {
    console.log("\n📋 Configuration Summary:");
    console.log(`   Frigate API: ${FRIGATE_API_URL}`);
    console.log(`   Poll Interval: ${POLL_INTERVAL / 1000}s`);
    console.log(`   Webhook: ${WEBHOOK_URL || "Not configured"}`);

    const defaultSchedule = config.default_schedule || {
        start_time: "00:00",
        end_time: "23:59",
    };
    console.log(
        `   Default Schedule: ${defaultSchedule.start_time} - ${defaultSchedule.end_time}`
    );

    console.log("\n👥 Groups:");
    for (const [name, group] of Object.entries(config.groups)) {
        const status = group.enabled !== false ? "✅" : "❌";
        const alwaysSend = group.always_send ? " [ALWAYS SEND]" : "";
        const schedule = group.schedule
            ? ` (${group.schedule.start_time} - ${group.schedule.end_time})`
            : " (uses default schedule)";
        console.log(
            `   ${status} ${name}: ${group.chat_id}${alwaysSend}${schedule}`
        );
        if (group.description) {
            console.log(`      ${group.description}`);
        }
    }

    console.log("\n📹 Camera Configurations:");
    console.log(
        `   Default Groups: ${(config.default_groups || ["all"]).join(", ")}`
    );

    if (config.cameras && Object.keys(config.cameras).length > 0) {
        for (const [name, cam] of Object.entries(config.cameras)) {
            const schedule = getCameraSchedule(name);
            const groupNames = cam.groups ||
                config.default_groups || ["default"];
            const labels = cam.labels ? cam.labels.join(", ") : "all";
            const alwaysSend = schedule.always_send ? " [ALWAYS SEND]" : "";
            console.log(`   📷 ${name}:`);
            console.log(
                `      Camera Schedule: ${schedule.start_time} - ${schedule.end_time}${alwaysSend}`
            );
            console.log(`      Labels: ${labels}`);
            console.log(`      Groups:`);

            for (const groupName of groupNames) {
                const effectiveSchedule = getScheduleForCameraAndGroup(
                    name,
                    groupName
                );
                const groupAlwaysSend = effectiveSchedule.always_send
                    ? " [ALWAYS SEND]"
                    : "";
                const hasOverride = cam.group_schedules?.[groupName];
                const overrideIndicator = hasOverride ? " *" : "";
                console.log(
                    `         - ${groupName}: ${effectiveSchedule.start_time} - ${effectiveSchedule.end_time}${groupAlwaysSend}${overrideIndicator}`
                );
            }
        }
        console.log("      (* = camera-specific group schedule override)");
    } else {
        console.log("   No camera-specific configurations (using defaults)");
    }
    console.log("");
}

// Start the service
printConfigSummary();
setInterval(fetchFrigateEvents, POLL_INTERVAL);
console.log("🚀 Frigate event listener started...\n");
