# Workflow export and import (administrators)

Use this to copy order workflows between installations, for example from a test portal to production. Owner: orders module.

## Turning it on

- It is on by default from increment 06. The switch **Workflow export and import** is on the **Workflows** page (`/admin/workflows`), next to the export and import buttons (`orders.workflow_transfer.enabled`, env `ORDER_WORKFLOW_TRANSFER_ENABLED`). Turning it off asks you to confirm, and every change is recorded as `workflow.transfer_setting_changed`. An installation that had already turned it off stays off.
- Only administrators can use it:
  - exporting needs `workflows.export`;
  - previewing and importing need `workflows.import` and a fresh step-up (MFA).
- Customers and staff never see it.

## Exporting

1. Choose all workflows or up to 50 named ones.
2. Download the `.json` package. Each workflow carries its published version and layout. A workflow that was never published is exported as its draft and marked "unpublished".

The package contains no customers, orders, users or local ids. Policy gates name the policy by its slug, so they can be matched on the other side. The file has a SHA-256 integrity digest; if anyone edits it, it can no longer be imported.

## Importing

1. **Upload the package.** The preview shows:
   - the source and its date;
   - every workflow, with any problems found;
   - whether a workflow with the same key already exists;
   - how each policy is matched.
2. **Fix blocking problems at the source and export again.** These are a changed file (digest mismatch), duplicate keys and more than 50 workflows. There is no "import anyway".
3. **Choose an action for every workflow:**
   - **Create** adds a new workflow under a free key (for example `intake_2`).
   - **Draft** adds a draft to the existing workflow with the same key. If that workflow already has a draft, publish or discard it first.
   - **Skip** leaves the workflow out. A workflow with problems, such as markup in its name or an invalid definition, can only be skipped.
4. **Resolve each policy that was not matched automatically.** Map it to a published policy for all users or customers, or remove those gates.
5. **Import.**

Nothing is published by an import. Review each draft in the workflow designer and publish it there. Orders in progress keep their existing workflow version.

## Records

Exports, previews and imports are written to the audit log as `workflow.exported`, `workflow.import_previewed` and `workflow.imported`. Each entry records the package digest and counts. Submitting the same import twice does not create anything twice.

## Limits

- Up to 50 workflows and 2 MiB per package.
- Nesting depth is capped at 24.
- Exports use format version 2 (customer tasks). Imports accept versions 1 and 2.
