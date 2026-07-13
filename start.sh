#!/bin/bash
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-YOUR_DEEPSEEK_KEY_HERE}"
cd "$(dirname "$0")"

while true; do
  echo "$(date): Starting Veros..."
  # Clean any corrupted database from previous crash
  rm -f openchart.db openchart.db-shm openchart.db-wal
  node index.js 2>&1 | while read line; do echo "$(date): $line"; done >> server.log
  echo "$(date): Server exited. Restarting in 2 seconds..."
  sleep 2
done
