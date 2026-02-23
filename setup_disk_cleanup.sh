#!/bin/bash
# =============================================================================
# setup_disk_cleanup.sh - Install disk_cleanup as a cron job with logrotate
# =============================================================================
# Run with sudo: sudo ./setup_disk_cleanup.sh [OPTIONS]
#
# Options:
#   -d, --dir PATH        Directory to clean up (default: /var/log/recordings)
#   -m, --min-free GB     Minimum free space threshold (default: 10)
#   -t, --target-free GB  Target free space to reach (default: 50)
#   -p, --partition PATH  Partition to monitor (default: /)
#   -i, --install-dir     Where to install the script (default: /usr/local/bin)
#   --uninstall           Remove cron job, logrotate config, and installed script
#   -h, --help            Show this help message
# =============================================================================

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────────────────
CLEANUP_DIR="/var/log/recordings"
MIN_FREE_GB=10
TARGET_FREE_GB=50
PARTITION="/"
INSTALL_DIR="/usr/local/bin"
UNINSTALL=false

LOG_FILE="/var/log/disk_cleanup.log"
LOGROTATE_CONF="/etc/logrotate.d/disk_cleanup"
CRON_FILE="/etc/cron.d/disk_cleanup"
SCRIPT_NAME="disk_cleanup.sh"
SCRIPT_SRC="$(cd "$(dirname "$0")" && pwd)/${SCRIPT_NAME}"

# ── Parse Arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dir)          CLEANUP_DIR="$2";    shift 2 ;;
        -m|--min-free)     MIN_FREE_GB="$2";    shift 2 ;;
        -t|--target-free)  TARGET_FREE_GB="$2"; shift 2 ;;
        -p|--partition)    PARTITION="$2";       shift 2 ;;
        -i|--install-dir)  INSTALL_DIR="$2";    shift 2 ;;
        --uninstall)       UNINSTALL=true;       shift   ;;
        -h|--help)
            grep '^#' "$0" | grep -v '#!/' | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

INSTALLED_SCRIPT="${INSTALL_DIR}/${SCRIPT_NAME}"

# ── Root check ───────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
    echo "Error: This script must be run as root (sudo)."
    exit 1
fi

# ── Uninstall ────────────────────────────────────────────────────────────────
if [[ "$UNINSTALL" == true ]]; then
    echo "Uninstalling disk_cleanup..."
    rm -f "$CRON_FILE"
    rm -f "$LOGROTATE_CONF"
    rm -f "$INSTALLED_SCRIPT"
    echo "  Removed: $CRON_FILE"
    echo "  Removed: $LOGROTATE_CONF"
    echo "  Removed: $INSTALLED_SCRIPT"
    echo "  Log file kept at: $LOG_FILE (remove manually if desired)"
    echo "Uninstall complete."
    exit 0
fi

# ── Validate source script exists ────────────────────────────────────────────
if [[ ! -f "$SCRIPT_SRC" ]]; then
    echo "Error: Cannot find ${SCRIPT_NAME} at ${SCRIPT_SRC}"
    exit 1
fi

echo "Setting up disk_cleanup cron job..."

# ── Install the script ───────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_SRC" "$INSTALLED_SCRIPT"
chmod 755 "$INSTALLED_SCRIPT"
echo "  Installed script to: $INSTALLED_SCRIPT"

# ── Create logrotate config ─────────────────────────────────────────────────
cat > "$LOGROTATE_CONF" <<EOF
${LOG_FILE} {
    size 5M
    rotate 3
    compress
    delaycompress
    missingok
    notifempty
    create 0640 root root
}
EOF
echo "  Created logrotate config: $LOGROTATE_CONF"

# ── Create cron job ──────────────────────────────────────────────────────────
cat > "$CRON_FILE" <<EOF
# Disk cleanup - runs every 10 minutes
*/10 * * * * root ${INSTALLED_SCRIPT} -d ${CLEANUP_DIR} -m ${MIN_FREE_GB} -t ${TARGET_FREE_GB} -p ${PARTITION} -l ${LOG_FILE}
EOF
chmod 644 "$CRON_FILE"
echo "  Created cron job: $CRON_FILE (every 10 minutes)"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "Setup complete!"
echo "  Schedule  : Every 10 minutes"
echo "  Script    : $INSTALLED_SCRIPT"
echo "  Log file  : $LOG_FILE"
echo "  Logrotate : $LOGROTATE_CONF (rotates at 5MB, keeps 3 compressed backups)"
echo "  Cron      : $CRON_FILE"
echo ""
echo "  Cleanup dir  : $CLEANUP_DIR"
echo "  Min free     : ${MIN_FREE_GB} GB"
echo "  Target free  : ${TARGET_FREE_GB} GB"
echo "  Partition    : $PARTITION"
echo ""
echo "To uninstall: sudo $0 --uninstall"
echo "To test now:  sudo ${INSTALLED_SCRIPT} -d ${CLEANUP_DIR} -m ${MIN_FREE_GB} -t ${TARGET_FREE_GB} -p ${PARTITION} -l ${LOG_FILE}"
