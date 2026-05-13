#!/bin/bash
# M4TR1X security monitor — run once, watch everything
SESSION="m4tr1x-monitor"

tmux kill-session -t $SESSION 2>/dev/null

tmux new-session -d -s $SESSION -x 220 -y 50

# Pane 0 (top-left): PM2 live logs
tmux send-keys -t $SESSION "pm2 logs m4tr1x-node --lines 30 --nocolor 2>&1 | grep --line-buffered -v 'HEARTBEAT\|FEDERATION\|RELAY\|debug'" C-m

# Pane 1 (top-right): active connections on port 8080
tmux split-window -t $SESSION -h
tmux send-keys -t $SESSION "watch -n 3 'echo \"=== CONNECTIONS :8080 ===\"; ss -tnp | grep :8080 | head -20; echo; echo \"=== BANNED IPs ===\"; sudo fail2ban-client status m4tr1x-api 2>/dev/null | grep -A2 \"Banned IP\"; sudo fail2ban-client status sshd 2>/dev/null | grep -A2 \"Banned IP\"'" C-m

# Pane 2 (bottom): errors and suspicious requests only
tmux split-window -t $SESSION -v -p 30
tmux send-keys -t $SESSION "tail -f /home/h8db0y/.pm2/logs/m4tr1x-node-error.log /home/h8db0y/.pm2/logs/m4tr1x-node-out.log 2>/dev/null | grep --line-buffered -E '(4[0-9]{2}|5[0-9]{2}|ERROR|WARN|POST.*upload|DELETE|banned)'" C-m

tmux attach-session -t $SESSION
