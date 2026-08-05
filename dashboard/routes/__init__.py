"""Blueprints. Each one owns a slice of the URL space and nothing else."""

from . import (audit, backups, files, machines, schedules, shares, snapshots,
               system, tasks)

BLUEPRINTS = (system.bp, machines.bp, files.bp, snapshots.bp, tasks.bp,
              schedules.bp, backups.bp, shares.bp, audit.bp)
