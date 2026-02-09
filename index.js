const {
    config,
    POLL_INTERVAL,
    getCameraSchedule,
    getScheduleForCameraAndGroup,
    shouldAlertAnyGroup,
    isLabelAllowed,
} = require("./config");
const { sendMediaAlertToGroups, sendTextAlertToGroups } = require("./telegram");
const { fetchEvents, getMediaDownloaders, triggerWebhook } = require("./frigate");

let lastEvent;
let lastTimestamp = 0;

/**
 * Fetch and process events from Frigate
 */
async function fetchFrigateEvents() {
    try {
        const events = await fetchEvents();

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

    const message = `🚨 <b>Frigate Alert!</b>
📷 Camera: ${event.camera}
📌 Object: ${event.label}
⏳ Time: ${new Date(event.start_time * 1000).toLocaleString()}
${scheduleInfo}`;

    triggerWebhook(event);

    const send = async () => {
        const downloaders = getMediaDownloaders(event);

        for (const { download, fileName, label } of downloaders) {
            try {
                const buffer = await download();
                const sent = await sendMediaAlertToGroups(event, buffer, message, fileName);
                if (sent) return;
                console.log(`⚠️ ${label} downloaded but Telegram rejected it, trying next...`);
            } catch (e) {
                console.log(`⚠️ ${label} download failed after retries, trying next...`);
            }
        }

        console.error("❌ All media types failed for event:", event.id);
        await sendTextAlertToGroups(event, message + "\n⚠️ (No media available)");
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

// Print startup configuration summary
function printConfigSummary() {
    const { FRIGATE_API_URL, WEBHOOK_URL } = require("./config");

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
