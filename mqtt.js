const mqtt = require("mqtt");

let client;

/**
 * Connect to MQTT broker and subscribe to Frigate events
 * @param {Object} mqttConfig - MQTT connection config
 * @param {Function} onEvent - callback for incoming event payloads
 * @returns {mqtt.MqttClient}
 */
function connect(mqttConfig, onEvent) {
    const options = {};
    if (mqttConfig.username) options.username = mqttConfig.username;
    if (mqttConfig.password) options.password = mqttConfig.password;

    client = mqtt.connect(mqttConfig.host, options);
    const prefix = mqttConfig.topic_prefix || "frigate";
    const source = mqttConfig.source || "events";
    const topic = `${prefix}/${source}`;

    client.on("connect", () => {
        console.log(`✅ Connected to MQTT broker at ${mqttConfig.host}`);
        client.subscribe(topic, (err) => {
            if (err) {
                console.error(`❌ Failed to subscribe to ${topic}:`, err.message);
            } else {
                console.log(`📡 Subscribed to ${topic}`);
            }
        });
    });

    client.on("message", (msgTopic, message) => {
        try {
            const payload = JSON.parse(message.toString());
            // Second argument is additive - existing callbacks ignore it.
            onEvent(payload, msgTopic);
        } catch (e) {
            console.error("❌ Failed to parse MQTT message:", e.message);
        }
    });

    client.on("error", (err) => {
        console.error("❌ MQTT error:", err.message);
    });

    client.on("reconnect", () => {
        console.log("🔄 Reconnecting to MQTT broker...");
    });

    client.on("close", () => {
        console.log("⚠️ MQTT connection closed");
    });

    client.on("offline", () => {
        console.log("⚠️ MQTT client offline");
    });

    return client;
}

/**
 * Disconnect from MQTT broker
 */
function disconnect() {
    if (client) {
        client.end();
        client = null;
    }
}

module.exports = { connect, disconnect };
