#!/bin/bash
# M4TR1X node backup — ledger + Tor keys
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$HOME/m4tr1x-backup-$DATE.tar.gz"

sudo tar czf "$BACKUP_FILE" \
  /var/lib/m4tr1x/ \
  /var/lib/tor/m4tr1x/ \
  "$HOME/m4tr1x-node/.env"

sudo chown $USER:$USER "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

echo "Backup: $BACKUP_FILE"
echo "Sposta su USB cifrata. NON lasciare su questa macchina."
ls -lah "$BACKUP_FILE"
