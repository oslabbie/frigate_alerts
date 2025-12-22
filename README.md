# Frigate Telegram Integration

Send Frigate NVR alerts to multiple Telegram groups with per-camera scheduling and label filtering.

## Features

- 📱 **Multiple Telegram Groups** - Send alerts to different groups based on camera
- ⏰ **Per-Camera Scheduling** - Set different alert windows for each camera
- 🔔 **Always Send Option** - Bypass schedule for critical cameras
- 🏷️ **Label Filtering** - Only alert on specific object types per camera
- 📹 **Media Attachments** - Sends video clips, snapshots, or thumbnails
- 🔗 **Webhook Support** - Trigger external webhooks on events

## Installation

```bash
npm install
```

## Configuration

Create a `config.json` file (see `config.example.json` for reference):

```json
{
  "frigate_api_url": "http://frigate:5000/api",
  "telegram_bot_token": "YOUR_BOT_TOKEN",
  "poll_interval_seconds": 10,
  "webhook_url": null,

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
| `frigate_api_url` | string | Frigate API URL |
| `telegram_bot_token` | string | Telegram bot token |
| `poll_interval_seconds` | number | How often to check for events (default: 10) |
| `webhook_url` | string | Optional webhook URL to trigger on events |
| `default_schedule` | object | Default schedule for unconfigured cameras |
| `default_groups` | array | Default groups for unconfigured cameras |

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

For backwards compatibility, you can still use environment variables:

```bash
TELEGRAM_BOT_TOKEN="..."
API_URL="http://frigate:5000/api"
CONFIG_PATH="./config.json"  # Custom config file path
```

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
   Poll Interval: 10s
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

🚀 Frigate event listener started...
```
