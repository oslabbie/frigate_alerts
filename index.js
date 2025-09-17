require("dotenv").config();
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FRIGATE_API_URL = process.env.API_URL; // Change if needed
const ALERT_START_TIME = process.env.ALERT_START_TIME;
const ALERT_END_TIME = process.env.ALERT_END_TIME;

// Function to send a message to Telegram
const sendToTelegram = async (message) => {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message || "",
            parse_mode: "HTML",
        });
        console.log("✅ Message sent to Telegram");
    } catch (error) {
        console.error(
            "❌ Failed to send message:",
            error.response?.data || error.message
        );
    }
};

// Download a URL to a temporary file and return its path
async function downloadToTempFile(url, suggestedName) {
    const ext = path.extname(suggestedName || "");
    const base = path.basename(suggestedName || `media_${Date.now()}`);
    const tmpDir = path.join(os.tmpdir(), "cctv_telegram");
    await fsp.mkdir(tmpDir, { recursive: true });
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sanitized = base.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const tmpPath = path.join(
        tmpDir,
        `${sanitized.replace(ext, "")}-${unique}${ext}`
    );

    const response = await axios.get(url, { responseType: "stream" });
    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpPath);
        response.data.pipe(ws);
        ws.on("finish", resolve);
        ws.on("error", reject);
    });
    return tmpPath;
}

// Send media located at filePath to Telegram, then delete the file
async function sendMediaFileToTelegram(buffer, caption, fileName) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
    const form = new FormData();
    form.append("chat_id", TELEGRAM_CHAT_ID);
    form.append("document", buffer, { filename: fileName });
    if (caption) form.append("caption", caption);
    form.append("parse_mode", "HTML");

    try {
        await axios.post(url, form, { headers: form.getHeaders() });
        console.log("✅ Media sent to Telegram");
        return true;
    } catch (error) {
        console.error(
            "❌ Failed to send media:",
            error.response?.data || error.message
        );
        return false;
    }
}

// Function to check if the current time is within the alert timeframe
const isWithinAlertTimeframe = (event) => {
    const now = new Date();
    const _startTime =
        process.env[event.camera + "_START_TIME"] || ALERT_START_TIME;
    const _endTime = process.env[event.camera + "_END_TIME"] || ALERT_END_TIME;

    const [startHour, startMinute] = _startTime.split(":").map(Number);
    const [endHour, endMinute] = _endTime.split(":").map(Number);

    // Minutes since midnight for now, start, and end
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    if (startMinutes <= endMinutes) {
        // Timeframe does not cross midnight
        return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    } else {
        // Timeframe crosses midnight
        return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
    }
};

let lastEvent;
let lastTimestamp = 0;

// Function to fetch events from Frigate
const fetchFrigateEvents = async () => {
    try {
        const response = await axios.get(`${FRIGATE_API_URL}/events`);
        const events = response.data;

        if (events.length > 0) {
            await new Promise((r) => setTimeout(r, 5000)); // Wait 5 seconds to ensure clips are ready
            for (const event of events) {
                if (!lastEvent || event.id === lastEvent.id) break;
                if (!isWithinAlertTimeframe(event)) continue;
                if (event.start_time < lastTimestamp) continue;
                processEvent(event);
            }
            lastEvent = events[0];
            lastTimestamp = Date.now() / 1000 - 10 * 60; // 10 minutes ago
        }
    } catch (error) {
        console.error(
            "❌ Error fetching events:",
            error.response?.data || error.message
        );
    }
};

async function processEvent(event) {
    let message = `🚨 <b>Frigate Alert!</b>
📷 Camera: ${event.camera}
📌 Object: ${event.label}
⏳ Time: ${new Date(event.start_time * 1000).toLocaleString()}`;

    const send = async () => {
        const videoRes = await downloadVideo(event);
        const sentVideo = await sendMediaFileToTelegram(
            videoRes,
            message,
            "video.mp4"
        );
        if (sentVideo) return;

        // Fallback to snapshot if video send failed
        const snapshotRes = await downloadSnapshot(event);
        const photoSent = await sendMediaFileToTelegram(
            snapshotRes,
            message,
            "snapshot.jpg"
        );

        if (photoSent) return;
        const thumbnailRes = await downloadThumbnail(event);
        const thumbnailSent = await sendMediaFileToTelegram(
            thumbnailRes,
            message,
            "thumbnail.jpg"
        );

        if (thumbnailSent) return;
        console.error("❌ Failed to send any media for event:", event.id);
        message = `${message}\n⚠️ (No media available)`;
        sendToTelegram(message);
    };

    if (event.has_clip && !event.end_time) {
        setTimeout(async () => {
            event.end_time = event.start_time + 5; // Temporary end time
            send();
        }, 7000);
    } else {
        send();
    }
}

async function downloadVideo(event) {
    if (!event.end_time)
        await new Promise(
            (r) =>
                setTimeout(() => {
                    event.end_time = event.start_time + 17;
                    r();
                }),
            20000
        );
    const url = `${FRIGATE_API_URL}/${event.camera}/start/${event.start_time}/end/${event.end_time}/clip.mp4`;
    const snapshotResponse = await axios.get(url, {
        responseType: "arraybuffer",
    });
    const buffer = Buffer.from(snapshotResponse.data, "binary");
    return buffer;
}

async function downloadSnapshot(event) {
    const url = `${FRIGATE_API_URL}/events/${event.id}/snapshot.jpg`;
    const snapshotResponse = await axios.get(url, {
        responseType: "arraybuffer",
    });
    const buffer = Buffer.from(snapshotResponse.data, "binary");
    return buffer;
}

async function downloadThumbnail(event) {
    const url = `${FRIGATE_API_URL}/events/${event.id}/thumbnail.jpg`;
    const snapshotResponse = await axios.get(url, {
        responseType: "arraybuffer",
    });
    const buffer = Buffer.from(snapshotResponse.data, "binary");
    return buffer;
}

// Poll Frigate every 10 seconds
setInterval(fetchFrigateEvents, 10000);

console.log("🚀 Frigate event listener started...");
