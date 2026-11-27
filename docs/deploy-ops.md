# Deploy operations: rollback, unit limits, off-box backup (OPS-3, OPS-4, OPS-5)

Nothing here is installed or run by any script in this repo. A person on the server does each step, after the owner agrees.

## Database-aware rollback: `deploy/rollback-db.sh` (OPS-3)

`deploy/release.sh --rollback` flips the code symlink and does not look at the database. If the release you leave already ran migrations, the old code then runs on a newer schema. That is safe only when those migrations are additive.

```
bash deploy/rollback-db.sh                 # dry run (default): reads and logs, changes nothing
bash deploy/rollback-db.sh --target /opt/wasl/releases/<name>
sudo bash deploy/rollback-db.sh --apply    # backup, flip the symlink, restart, health check
```

- It lists the applied migrations (table `d1_migrations` in the local D1 files) that the target release does not have.
- Additive means only: CREATE TABLE, CREATE [UNIQUE] INDEX, ALTER TABLE ... ADD, INSERT [OR IGNORE] INTO. Anything else is refused, and the script prints which migration and which statement. It also refuses when the SQL file of such a migration cannot be found.
- On `--apply` it first writes a checked `.backup` of every database to `/var/backups/wasl/pre-rollback-<time>-<db>.sqlite`. If the new code is unhealthy it puts the old release back.
- It never deletes data and never undoes a migration. The additive schema stays.
- If it refuses: stay on the current release, or ship a fixed release forward. Restoring a backup is a separate, manual decision.
- Limit: it reads SQL text. Read any CREATE UNIQUE INDEX or INSERT migration yourself before `--apply`.

## Hardened systemd unit: `deploy/wasl.service.example` (OPS-4)

Adds memory, CPU, task and file limits, start limits, `Restart=on-failure`, and file-system protection. Sizes assume 2 vCPU and 2 GB RAM (OPS-2 has no measurement) and sit in comments so the owner can change them. `WatchdogSec` is left out because `wrangler dev` does not send systemd watchdog messages. Check with `systemd-analyze security wasl`. Test on staging first.

## Off-box backup: `deploy/offbox-backup.sh` (OPS-5)

Off by default: with `OFFBOX_TARGET` unset it exits 0 and copies nothing. No destination is chosen. That is an owner decision.

Supported destination forms: `ssh:user@host:/folder` (rsync over ssh), `s3://bucket/prefix` (AWS CLI), `rclone:remote:path`. It copies the newest backup of each database and the newest 3 signed audit exports, reads each file back and checks size and sha256, and keeps the local copy. It never prints the destination or any key. Credentials go in `/etc/wasl/offbox.env` (mode 600). Examples: `deploy/offbox-backup.service.example` and `deploy/offbox-backup.timer.example` (disabled). It does not delete anything on the destination; set a retention rule there.

## Tests

`bash tests/deploy-scripts.test.sh` checks that every `deploy/*.sh` parses, that `rollback-db.sh` refuses non-additive migrations (in dry run, on a fake release folder), and that `offbox-backup.sh` is off by default.
