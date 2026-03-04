# Frigate Telegram Integration

Send Frigate NVR alerts to multiple Telegram groups with real-time MQTT event detection, per-camera scheduling, and label filtering.

## Features

- 📡 **Real-Time MQTT** - Instant event detection via Frigate's MQTT feed (no polling)
- 📱 **Multiple Telegram Groups** - Send alerts to different groups based on camera
- ⏰ **Per-Camera Scheduling** - Set different alert windows for each camera
- 🔔 **Always Send Option** - Bypass schedule for critical cameras
- 🏷️ **Label Filtering** - Only alert on specific object types per camera
- 📹 **Media Attachments** - Sends video clips, snapshots, or thumbnails
- 🔗 **Webhook Support** - Trigger external webhooks on events
- 🔄 **Startup Catch-Up** - Checks for missed events on restart via the HTTP API

## Prerequisites

- **Node.js** (v16+)
- **Frigate NVR** with MQTT enabled
- **MQTT Broker** (e.g., Mosquitto) — Frigate must be configured to publish to it
- **Telegram Bot** — create one via [@BotFather](https://t.me/BotFather)

## Installation

```bash
npm install
```

Or use the install script on Linux which also installs Mosquitto and sets up a systemd service:

```bash
sudo ./install
```

### Frigate MQTT Setup

Frigate must have MQTT enabled and pointing to your broker. Add this to your Frigate `config.yml`:

```yaml
mqtt:
  enabled: true
  host: 127.0.0.1
  port: 1883
```

**Docker networking note:** If Frigate runs in Docker, use `network_mode: host` in your `docker-compose.yml` so that `127.0.0.1` refers to the host machine:

```yaml
services:
  frigate:
    # ... your existing config ...
    network_mode: host
```

Without `network_mode: host`, you must use the host's actual IP address (e.g., `192.168.1.x`) instead of `127.0.0.1` in Frigate's MQTT config, since `127.0.0.1` inside the container points to the container itself.

## Configuration

Create a `config.json` file (see `config.example.json` for reference):

```json
{
  "frigate_api_url": "http://frigate:5000/api",
  "telegram_bot_token": "YOUR_BOT_TOKEN",
  "webhook_url": null,

  "mqtt": {
    "host": "mqtt://localhost",
    "topic_prefix": "frigate",
    "username": null,
    "password": null
  },

  "media_ready_delay_seconds": 5,

  "default_schedule": {
    "start_time": "00:00",
    "end_time": "23:59",
    "always_send": false
  },

  "groups": {
    "family": {
      "chat_id": "-123456789",
      "enabled": true,
      "description": "Family alerts"
    },
    "security": {
      "chat_id": "-987654321",
      "enabled": true,
      "description": "Security team"
    }
  },

  "default_groups": ["family"],

  "cameras": {
    "front_door": {
      "schedule": {
        "start_time": "18:00",
        "end_time": "06:00"
      },
      "always_send": false,
      "groups": ["family", "security"],
      "labels": ["person", "car"]
    },
    "backyard": {
      "always_send": true,
      "groups": ["security"]
    }
  }
}
```

### Configuration Options

#### Root Level
| Option | Type | Description |
|--------|------|-------------|
| `frigate_api_url` | string | Frigate API URL (used for media downloads and startup catch-up) |
| `telegram_bot_token` | string | Telegram bot token |
| `webhook_url` | string | Optional webhook URL to trigger on events |
| `media_ready_delay_seconds` | number | Seconds to wait after event ends before fetching clip (default: 5) |
| `default_schedule` | object | Default schedule for unconfigured cameras |
| `default_groups` | array | Default groups for unconfigured cameras |

#### MQTT
| Option | Type | Description |
|--------|------|-------------|
| `mqtt.host` | string | MQTT broker URL (e.g., `mqtt://localhost` or `mqtt://192.168.1.10`) |
| `mqtt.topic_prefix` | string | Frigate's MQTT topic prefix (default: `frigate`) |
| `mqtt.username` | string | Optional MQTT username |
| `mqtt.password` | string | Optional MQTT password |

#### Groups
Define your Telegram groups/chats:

```json
"groups": {
  "group_name": {
    "chat_id": "-123456789",
    "enabled": true,
    "description": "Optional description"
  }
}
```

- `chat_id`: Telegram chat ID (use `-` prefix for groups)
- `enabled`: Set to `false` to disable a group without removing it
- `description`: Optional human-readable description

#### Cameras
Configure per-camera settings:

```json
"cameras": {
  "camera_name": {
    "schedule": {
      "start_time": "18:00",
      "end_time": "06:00"
    },
    "always_send": false,
    "groups": ["family", "security"],
    "labels": ["person", "car"]
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `schedule.start_time` | string | Start of alert window (HH:MM) |
| `schedule.end_time` | string | End of alert window (HH:MM) |
| `always_send` | boolean | If `true`, ignores schedule and always sends |
| `groups` | array | Which groups receive alerts from this camera |
| `labels` | array | Only alert on these object types (omit for all) |

**Note:** Schedule times support crossing midnight (e.g., 18:00 to 06:00).

### Environment Variable Fallback

For backwards compatibility, you can also use environment variables:

```bash
TELEGRAM_BOT_TOKEN="..."
API_URL="http://frigate:5000/api"
MQTT_HOST="mqtt://localhost"
MQTT_USERNAME="..."
MQTT_PASSWORD="..."
CONFIG_PATH="./config.json"  # Custom config file path
```

## How It Works

The service uses a **hybrid MQTT + HTTP API** approach:

1. **MQTT for event detection** — Subscribes to `frigate/events` for real-time push notifications. Frigate publishes `"new"`, `"update"`, and `"end"` messages as objects are tracked.
2. **HTTP API for media** — Downloads video clips, snapshots, and thumbnails from the Frigate REST API once an event is complete.
3. **Startup catch-up** — On launch, queries the API for events from the last 5 minutes to cover any downtime.

### Event Lifecycle

```
Frigate detects object
  └─ MQTT "new" → event tracked, 60s safety timeout started
       └─ MQTT "end" → timeout cleared, wait for clip to finalize
            └─ Download media (video → snapshot → thumbnail)
                 └─ Send to Telegram groups
```

- **Short events** (person walks by): `"end"` fires within seconds, clip is fetched with full video
- **Long events** (lingering object): if `"end"` doesn't arrive within 60 seconds, the alert is sent with whatever media is available

## Running

```bash
# Development
node index.js

# Production (with PM2)
pm2 start index.js --name frigate-alerts
```

## Installing as a Service (Linux)

The included `install` script makes it easy to set up Frigate Alerts as a systemd service:

```bash
# Install and start the service
sudo ./install

# Check service status
./install status

# View live logs
./install logs
```

### Available Commands

| Command | Description |
|---------|-------------|
| `./install` | Install and start as a systemd service |
| `./install status` | Show service status |
| `./install start` | Start the service |
| `./install stop` | Stop the service |
| `./install restart` | Restart the service |
| `./install enable` | Enable service (start on boot) |
| `./install disable` | Disable service (won't start on boot) |
| `./install logs` | View live service logs |
| `./install uninstall` | Remove the service |

**Note:** Most commands require `sudo` as they interact with systemd.

## Example Use Cases

### 1. Different Groups for Different Areas
```json
{
  "cameras": {
    "front_door": { "groups": ["family", "security"] },
    "kids_room": { "groups": ["family"] },
    "warehouse": { "groups": ["security"] }
  }
}
```

### 2. Night-Only Alerts with Always-On Critical Camera
```json
{
  "default_schedule": {
    "start_time": "22:00",
    "end_time": "06:00"
  },
  "cameras": {
    "safe_room": { "always_send": true }
  }
}
```

### 3. Person-Only Detection
```json
{
  "cameras": {
    "driveway": {
      "labels": ["person"],
      "groups": ["security"]
    }
  }
}
```

## Startup Output

When the service starts, it prints a configuration summary:

```
✅ Configuration loaded from ./config.json

📋 Configuration Summary:
   Frigate API: http://frigate:5000/api
   MQTT Broker: mqtt://localhost
   MQTT Topic: frigate/events
   Media Ready Delay: 5s
   Webhook: Not configured

👥 Groups:
   ✅ family: -123456789 (Family alerts)
   ✅ security: -987654321 (Security team)

📹 Camera Configurations:
   Default Schedule: 00:00 - 23:59
   Default Groups: family
   📷 front_door:
      Schedule: 18:00 - 06:00
      Groups: family, security
      Labels: person, car
   📷 backyard:
      Schedule: 00:00 - 23:59 [ALWAYS SEND]
      Groups: security
      Labels: all

🔍 Checking for missed events...
   No recent events found
✅ Connected to MQTT broker at mqtt://localhost
📡 Subscribed to frigate/events
🚀 Frigate event listener started (MQTT mode)
```
