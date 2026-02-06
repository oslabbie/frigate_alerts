const axios = require("axios");
const FormData = require("form-data");
const { TELEGRAM_BOT_TOKEN, getGroupsToAlert } = require("./config");

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

module.exports = {
    sendToTelegram,
    sendMediaToTelegram,
    sendAlertToGroups,
};
