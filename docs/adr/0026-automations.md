# 0026 — Automations: curated triggers, registered actions, recorded runs

Status: Accepted (2026-11-21)

## Context
The owner asked for an events / automation centre built by a wizard or on a canvas.

## Decision
- An automation has one trigger from a curated catalogue of events (or manual / schedule), optional
  condition groups (field, operator, value — no expressions, no code) and ordered actions from a registry.
- The audit recorder offers an in-transaction tap. When an enabled automation listens to an event, a job
  is enqueued in the same transaction; evaluation and actions run in the worker, never in the request.
- Actions: send an e-mail template, in-app notification, create a support ticket, call a webhook through
  the egress policy, sync an order to SharePoint, copy order files to a storage connection. No action can
  change an order's status, a permission or a setting.
- Events produced by an automation never trigger automations. Runs are rate-limited, recorded with
  per-action results and retried with backoff. A failing automation never fails the business transaction.

## Consequences
Automations cannot express arbitrary logic. New triggers and actions are added in code by the owning module.
