# Project Memory

Last update: April 3, 2026

## Current Situation
- The inter-account WordPress migration flow is implemented and deployable.
- On o2switch, Softaculous API returns:
  - `off_backup_restore: La fonctionnalité Sauvegarde/Restauration a été désactivée par l'administrateur`
- Because of this provider-side restriction, the official Softaculous backup/restore path is blocked.

## What Was Done
- Added migration controls in `/admin/migrations`:
  - Stop running attempt
  - Delete one attempt
  - Clear history (with running-safety checks)
- Hardened fallback copy pipeline:
  - Better upload compatibility strategies
  - Transfer timeouts and retries
  - Regular heartbeat logs to avoid silent stalls

## Pending External Dependency
- Open ticket with o2switch to enable Softaculous Backup/Restore at WHM/cPanel level.
- Do not consider cross-account migration "done" until provider confirms activation and a full end-to-end migration completes.

## Resume Checklist (when returning to this project)
1. Confirm o2switch support reply says Backup/Restore is enabled.
2. Redeploy latest `main` on Railway.
3. Run a fresh migration test to a new target subdomain.
4. Validate final status is `completed` and target site is functional.
