#!/bin/bash
# SQLite日次バックアップ
# unified.db + tasks.json を日付付きで保存し、古いバックアップを自動削除
# launchdで毎日3:00に実行

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$REPO_DIR/data"
BACKUP_DIR="$DATA_DIR/backups"
LOG_FILE="$REPO_DIR/logs/backup.log"
TODAY=$(date +%Y-%m-%d)
KEEP_DAYS=14  # 14日分保持

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

mkdir -p "$BACKUP_DIR"

# unified.db のバックアップ（SQLite安全コピー）
DB_FILE="$DATA_DIR/unified.db"
if [ -f "$DB_FILE" ]; then
  BACKUP_FILE="$BACKUP_DIR/unified-${TODAY}.db"
  # sqlite3のbackupコマンドで安全にコピー（書き込み中でも壊れない）
  if command -v sqlite3 &> /dev/null; then
    sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'" 2>> "$LOG_FILE"
  else
    cp "$DB_FILE" "$BACKUP_FILE"
  fi

  if [ -f "$BACKUP_FILE" ]; then
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    log "OK: unified.db backed up ($SIZE) → $BACKUP_FILE"
  else
    log "ERROR: unified.db backup failed"
  fi
else
  log "WARN: unified.db not found at $DB_FILE"
fi

# tasks.json のバックアップ
TASKS_FILE="$DATA_DIR/tasks.json"
if [ -f "$TASKS_FILE" ]; then
  cp "$TASKS_FILE" "$BACKUP_DIR/tasks-${TODAY}.json"
  log "OK: tasks.json backed up"
fi

# チャット履歴のバックアップ
CHAT_FILE="$REPO_DIR/logs/.chat-history.json"
if [ -f "$CHAT_FILE" ]; then
  cp "$CHAT_FILE" "$BACKUP_DIR/chat-history-${TODAY}.json"
  log "OK: chat-history backed up"
fi

# 古いバックアップを削除（KEEP_DAYS日以上前）
DELETED=0
find "$BACKUP_DIR" -type f -mtime +${KEEP_DAYS} -delete 2>/dev/null
DELETED=$(find "$BACKUP_DIR" -type f | wc -l | tr -d ' ')
log "OK: Backup complete. $DELETED files in backup dir. Retention: ${KEEP_DAYS} days"
