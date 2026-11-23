## Reports and Custom Analytics

Console path: **Console → Overview → Reports** (`/admin/reports`).

### Access and Permissions

- **Built-in operational reports (`reports.read`)**: Available to both **Staff** and **Administrators**. Personal customer columns (such as email addresses) are hidden automatically when the active role is not permitted to view them, and a note appears at the top of the report when columns are redacted.
- **Custom reports (`reports.manage`)**: Available to **Administrators** only. Staff accounts do not see custom report lists, the custom report builder, or `/admin/reports/custom/*` routes.
- **CSV export (`reports.export`)**: Available to **Administrators** only and protected by **fresh MFA step-up**. Exporting a built-in report panel or a saved custom report prompts for password + second-factor verification if the session has not recently stepped up. Exported CSV files use UTF-8 with BOM, CRLF line endings, and spreadsheet formula-injection protection, capped at **100,000 rows** (and the server byte limit).

### Using Built-in Reports

Eight built-in reports cover core portal operations:

1. **Orders** — order volume, status pipeline, cycle time, and fulfilment throughput.
2. **Customers** — new registrations, active customer accounts, and verification posture.
3. **Referrals** — referral attribution, conversion funnel, and reward activity.
4. **Support tickets** — opened/closed volume, backlog by category and priority, and elapsed first-response and resolution times.
5. **Payments & discounts** — collected revenue, invoice aging, discount redemptions, and waived small-total balances (grouped per currency when multiple currencies exist).
6. **Carts** — open carts, checkout conversion, and upsell attachment performance.
7. **Files & recordings** — storage footprint, upload volume, malware-scan outcomes, and retention posture.
8. **Sign-ins & security** — sign-in outcomes, MFA adoption, step-up challenges, and security events.

On any built-in report page:

- Choose a quick UTC range preset (**Last 7 days**, **Last 30 days**, **Last 90 days**, **Last 365 days**) or enter custom **From (UTC)** and **To (UTC)** dates (up to **732 days**), pick a **Time bucket** (`Hour`, `Day`, `Week`, or `Month`), and toggle **Compare with previous period** to display directional and percentage deltas alongside each summary metric.
- Every report panel includes a plain-language summary, an accessible chart (**Bar**, **Line**, or **Donut**), and a **Chart / Table** switch so every figure can be inspected as a keyboard-navigable data table.
- Administrators can select **Export CSV** on any panel to download that panel's full bounded dataset after MFA step-up.

### Building and Managing Custom Reports (Administrators)

Select **New custom report** on `/admin/reports` to open the custom report builder:

1. **Dataset**: Pick one whitelisted operational dataset (such as Orders, Customers, Support tickets, Invoices, Audit events, or Security events). Only non-sensitive, indexed columns approved in the server catalogue are exposed.
2. **Query mode**:
   - **Detail rows**: Choose up to 20 columns to display individual records.
   - **Group & aggregate**: Group by up to 4 dimensions (with optional `Hour`, `Day`, `Week`, or `Month` time buckets on timestamps) and compute up to 6 aggregates (`Count`, `Count distinct`, `Sum`, `Average`, `Minimum`, or `Maximum`).
3. **Typed filters**: Add up to 16 filters using operators matched to each field's data type (`Equals`, `Between`, `Is one of`, `Contains`, `Starts with`, `Is empty`, etc.). Monetary filters are entered as whole integers in minor units (for example, `1250` for `$12.50`).
4. **Sorting, row limit, and presentation**: Add up to 4 sort rules, cap screen rows between `1` and `5,000` (larger result sets show a truncation notice on screen), and choose **Table**, **Bar**, **Line**, or **Pie / donut**.
5. **Preview and save**: Select **Run preview** to inspect live results before saving. Save the definition as **Private** (visible only to you) or **Shared** (runnable and duplicable by every administrator; only you can edit or delete it).

### Sharing, Duplicating, and Execution Limits

- **Shared definitions**: Any administrator can open, run, export CSV from, or **Duplicate** a shared custom report into their own editable copy. Direct edits and deletions are restricted to the report owner and guarded against concurrent overwrites via optimistic version checks.
- **Schema evolution**: If a saved report references a field removed in a later release, it is marked **Needs update** so the owner can update (or another administrator can duplicate and update) the definition before running it.
- **Fair-use protections**: Each administrator or staff member can run one report or export at a time, subject to per-minute execution limits and a server statement timeout so analytical queries never degrade live portal traffic.
