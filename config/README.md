# config/

Runtime configuration files read by the daemon at boot.

## channels.json

Maps Discord channels → repos. `allowedUserIds` is the operator list per
channel — only those user IDs can post slash commands.

**Operator availability is a single point of failure.** The `factory` channel
currently lists exactly one operator ID. If that account is offline / rotated
/ compromised, the channel is locked. Add a second operator ID per channel
once a backup operator exists.
