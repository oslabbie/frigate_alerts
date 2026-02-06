const axios = require("axios");
const {
    FRIGATE_API_URL,
    WEBHOOK_URL,
    MEDIA_RETRY_ATTEMPTS,
    MEDIA_RETRY_DELAY_MS,
    getGroupsForCamera,
} = require("./config");

/**
 * Retry an async function with increasing delays
 * @param {Function} fn - async function to retry
 * @param {string} label - description for logging
 * @returns {Promise<Buffer>}
 */
async function downloadWithRetry(fn, label) {
    let lastError;
    for (let attempt = 1; attempt <= MEDIA_RETRY_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e;
            if (attempt < MEDIA_RETRY_ATTEMPTS) {
                const delay = MEDIA_RETRY_DELAY_MS * attempt;
                console.log(`⏳ ${label} attempt ${attempt}/${MEDIA_RETRY_ATTEMPTS} failed, retrying in ${delay / 1000}s...`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}

/**
 * Fetch events from Frigate API
 * @returns {Promise<Array>}
 */
async function fetchEvents() {
    const response = await axios.get(`${FRIGATE_API_URL}/events`);
    return response.data;
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
 * Download media with retry, falling back through video > snapshot > thumbnail
 * @param {Object} event
 * @returns {Promise<{buffer: Buffer, fileName: string}|null>}
 */
async function downloadMedia(event) {
    try {
        const buffer = await downloadWithRetry(() => downloadVideo(event), `Video [${event.id}]`);
        return { buffer, fileName: "video.mp4" };
    } catch (e) {
        console.log("⚠️ Video download failed after retries, trying snapshot...");
    }

    try {
        const buffer = await downloadWithRetry(() => downloadSnapshot(event), `Snapshot [${event.id}]`);
        return { buffer, fileName: "snapshot.jpg" };
    } catch (e) {
        console.log("⚠️ Snapshot download failed after retries, trying thumbnail...");
    }

    try {
        const buffer = await downloadWithRetry(() => downloadThumbnail(event), `Thumbnail [${event.id}]`);
        return { buffer, fileName: "thumbnail.jpg" };
    } catch (e) {
        console.log("⚠️ Thumbnail download failed after retries");
    }

    return null;
}

/**
 * Trigger webhook for an event
 * @param {Object} event
 */
async function triggerWebhook(event) {
    if (!WEBHOOK_URL) return;

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

module.exports = {
    fetchEvents,
    downloadMedia,
    triggerWebhook,
};
