const axios = require("axios");
const FormData = require("form-data");
const {
    TELEGRAM_BOT_TOKEN,
    MEDIA_RETRY_ATTEMPTS,
    MEDIA_RETRY_DELAY_MS,
    getGroupsToAlert,
} = require("./config");

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
 * Send media to a specific Telegram chat with retries
 * @param {string} chatId
 * @param {Buffer} buffer
 * @param {string} caption
 * @param {string} fileName
 * @returns {boolean}
 */
async function sendMediaToTelegram(chatId, buffer, caption, fileName) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;

    for (let attempt = 1; attempt <= MEDIA_RETRY_ATTEMPTS; attempt++) {
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
            const errMsg = error.response?.data?.description || error.message;
            if (attempt < MEDIA_RETRY_ATTEMPTS) {
                const delay = MEDIA_RETRY_DELAY_MS * attempt;
                console.log(`⏳ Telegram send to ${chatId} attempt ${attempt}/${MEDIA_RETRY_ATTEMPTS} failed (${errMsg}), retrying in ${delay / 1000}s...`);
                await new Promise((r) => setTimeout(r, delay));
            } else {
                console.error(`❌ Failed to send media to ${chatId} after ${MEDIA_RETRY_ATTEMPTS} attempts: ${errMsg}`);
            }
        }
    }
    return false;
}

/**
 * Send alert with media to all configured groups for a camera
 * @param {Object} event
 * @param {Buffer} mediaBuffer
 * @param {string} message
 * @param {string} fileName
 * @returns {boolean} true if media was sent to all groups successfully
 */
async function sendMediaAlertToGroups(event, mediaBuffer, message, fileName) {
    const groups = getGroupsToAlert(event);

    if (groups.length === 0) {
        console.log(`⚠️ No groups configured for camera: ${event.camera}`);
        return false;
    }

    console.log(
        `📤 Sending media alert to ${groups.length} group(s): ${groups
            .map((g) => g.name)
            .join(", ")}`
    );

    const results = await Promise.all(
        groups.map((group) =>
            sendMediaToTelegram(group.chat_id, mediaBuffer, message, fileName)
        )
    );

    return results.every(Boolean);
}

/**
 * Send text-only alert to all configured groups for a camera
 * @param {Object} event
 * @param {string} message
 */
async function sendTextAlertToGroups(event, message) {
    const groups = getGroupsToAlert(event);

    if (groups.length === 0) return;

    console.log(
        `📤 Sending text alert to ${groups.length} group(s): ${groups
            .map((g) => g.name)
            .join(", ")}`
    );

    await Promise.all(
        groups.map((group) => sendToTelegram(group.chat_id, message))
    );
}

module.exports = {
    sendMediaAlertToGroups,
    sendTextAlertToGroups,
};
