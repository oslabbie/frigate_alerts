#!/bin/bash
# =============================================================================
# disk_cleanup.sh - Automated disk space cleanup script
# =============================================================================
# Monitors disk space and removes oldest files from a target directory
# when free space drops below a threshold.
#
# Usage: ./disk_cleanup.sh [OPTIONS]
# Options:
#   -d, --dir PATH        Directory to clean up (default: /var/log/recordings)
#   -m, --min-free GB     Minimum free space threshold in GB (default: 10)
#   -t, --target-free GB  Target free space to reach in GB (default: 50)
#   -p, --partition PATH  Partition/mount point to monitor (default: /)
#   -n, --dry-run         Simulate deletions without actually deleting
#   -l, --log FILE        Log file path. Omit to print to stdout only.
#                         Pass "none" to suppress all output.
#   -h, --help            Show this help message
# =============================================================================

# ── Default Configuration ────────────────────────────────────────────────────
CLEANUP_DIR="/var/log/recordings"
MIN_FREE_GB=10
TARGET_FREE_GB=50
PARTITION="/"
DRY_RUN=false
LOG_FILE=""        # Empty = stdout only. "none" = silent.
# ─────────────────────────────────────────────────────────────────────────────

# ── Parse Arguments ───────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        -d|--dir)          CLEANUP_DIR="$2";    shift 2 ;;
        -m|--min-free)     MIN_FREE_GB="$2";    shift 2 ;;
        -t|--target-free)  TARGET_FREE_GB="$2"; shift 2 ;;
        -p|--partition)    PARTITION="$2";      shift 2 ;;
        -n|--dry-run)      DRY_RUN=true;        shift   ;;
        -l|--log)          LOG_FILE="$2";       shift 2 ;;
        -h|--help)
            grep '^#' "$0" | grep -v '#!/' | sed 's/^# \?//'
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# ── Logging ───────────────────────────────────────────────────────────────────
log() {
    # If LOG_FILE is "none", suppress everything
    [[ "$LOG_FILE" == "none" ]] && return

    local level="$1"; shift
    local msg="$*"
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local line="[$timestamp] [$level] $msg"

    if [[ -n "$LOG_FILE" ]]; then
        echo "$line" >> "$LOG_FILE"
    else
        echo "$line"
    fi
}

# ── Validation ────────────────────────────────────────────────────────────────
if [[ ! -d "$CLEANUP_DIR" ]]; then
    log "ERROR" "Cleanup directory does not exist: $CLEANUP_DIR"
    exit 1
fi

if [[ ! -d "$PARTITION" ]] && ! df "$PARTITION" &>/dev/null; then
    log "ERROR" "Partition/mount point not found: $PARTITION"
    exit 1
fi

if [[ "$MIN_FREE_GB" -ge "$TARGET_FREE_GB" ]]; then
    log "ERROR" "min-free ($MIN_FREE_GB GB) must be less than target-free ($TARGET_FREE_GB GB)"
    exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
get_free_gb() {
    df --output=avail -BG "$PARTITION" | tail -1 | tr -d 'G '
}

bytes_to_human() {
    local bytes="$1"
    if   [[ $bytes -ge 1073741824 ]]; then echo "$(( bytes / 1073741824 )) GB"
    elif [[ $bytes -ge 1048576    ]]; then echo "$(( bytes / 1048576 )) MB"
    elif [[ $bytes -ge 1024       ]]; then echo "$(( bytes / 1024 )) KB"
    else echo "${bytes} B"
    fi
}

# ── Main ──────────────────────────────────────────────────────────────────────
FREE_GB=$(get_free_gb)

log "INFO" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "INFO" "Disk cleanup check started"
log "INFO" "  Partition   : $PARTITION"
log "INFO" "  Cleanup dir : $CLEANUP_DIR"
log "INFO" "  Free now    : ${FREE_GB} GB"
log "INFO" "  Trigger at  : < ${MIN_FREE_GB} GB"
log "INFO" "  Target      : >= ${TARGET_FREE_GB} GB"
log "INFO" "  Dry run     : $DRY_RUN"

if [[ "$FREE_GB" -ge "$MIN_FREE_GB" ]]; then
    log "INFO" "Disk space is sufficient (${FREE_GB} GB free). No cleanup needed."
    exit 0
fi

log "WARN" "Low disk space detected! ${FREE_GB} GB free — starting cleanup..."

DELETED_COUNT=0
DELETED_BYTES=0

while IFS= read -r -d '' file; do
    FREE_GB=$(get_free_gb)

    if [[ "$FREE_GB" -ge "$TARGET_FREE_GB" ]]; then
        log "INFO" "Target reached: ${FREE_GB} GB free. Stopping cleanup."
        break
    fi

    FILE_SIZE=$(stat --format="%s" "$file" 2>/dev/null || echo 0)
    FILE_SIZE_HUMAN=$(bytes_to_human "$FILE_SIZE")

    if [[ "$DRY_RUN" == true ]]; then
        log "DRY-RUN" "Would delete: $file ($FILE_SIZE_HUMAN)"
    else
        if rm -f "$file"; then
            log "INFO" "Deleted: $file ($FILE_SIZE_HUMAN) | Free: ${FREE_GB} GB"
            DELETED_COUNT=$(( DELETED_COUNT + 1 ))
            DELETED_BYTES=$(( DELETED_BYTES + FILE_SIZE ))
        else
            log "WARN" "Failed to delete: $file"
        fi
    fi

done < <(find "$CLEANUP_DIR" -type f -printf '%T+ %p\0' | sort -z | sed -z 's/^[^ ]* //')

FREE_GB=$(get_free_gb)
DELETED_HUMAN=$(bytes_to_human "$DELETED_BYTES")

if [[ "$DRY_RUN" == true ]]; then
    log "INFO" "Dry run complete. No files were deleted."
else
    log "INFO" "Cleanup complete. Deleted $DELETED_COUNT file(s) ($DELETED_HUMAN). Free space: ${FREE_GB} GB"
    if [[ "$FREE_GB" -lt "$TARGET_FREE_GB" ]]; then
        log "WARN" "Could not reach target of ${TARGET_FREE_GB} GB. Only ${FREE_GB} GB free after cleanup."
        log "WARN" "Consider expanding the cleanup directory or freeing space manually."
    fi
fi

log "INFO" "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"