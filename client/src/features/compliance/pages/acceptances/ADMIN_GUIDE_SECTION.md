# Administrator Guide Section — Policy Acceptances & Customer Policies Tab

> **Audience & visibility note**: Console-only (`staff` and `admin` roles holding `policies.acceptances.read`; CSV export and decrypted typed signer names require `admin`). Customers do not see this console area, so no customer Help Centre article applies.

## Reviewing Policy Acceptance Evidence

Open **Billing & compliance -> Policy acceptances** (`/admin/policy-acceptances`) to inspect immutable customer policy acceptance records across registration, order gates, checkout, re-acceptance prompts, and historical imports. Every timestamp is shown in your local time zone alongside its exact `UTC` time so distributed teams and auditors can correlate events unambiguously.

### Log Tab (`/admin/policy-acceptances`)

Use the **Log** tab to search and filter individual acceptance records:

- **Filters**: search by customer name, e-mail, or customer reference; narrow by policy document, exact policy version, accepted UTC date range (**Accepted from** / **Accepted to**), acceptance **Source** (`Registration`, `Order gate`, `Checkout`, `Re-acceptance`, `Imported historical`), **Method** (`Tick box`, `Typed name`), **Version status** (`Current version`, `Superseded`), or **Order reference**.
- **Freshness**: each row indicates whether the accepted version is still the **Current** published version or **Superseded** by a newer version.
- **Evidence detail**: select **View evidence** on any row to open the immutable evidence dialog containing the customer details, linked order reference (when captured at an order gate), salted IP address pseudonym, request correlation ID, full SHA-256 content hash, and the exact policy text accepted at that moment. Typed legal signer names are decrypted only for administrators with policy management permission (`policies.manage`); staff viewers see an `Encrypted` indicator.
- **CSV export (Admin + Step-Up MFA)**: administrators holding `policies.acceptances.export` can select **Export CSV** to download up to 5,000 matching records (with spreadsheet formula characters neutralized). Exporting prompts for fresh password + MFA verification if your session has not recently stepped up, and records an audit event.

### Coverage Tab (`/admin/policy-acceptances/coverage`)

Open **Coverage** (`/admin/policy-acceptances/coverage`) to see, for each active policy that requires acceptance:

- The current version label and publication timestamp.
- How many active customers have accepted the current version versus how many remain outstanding.
- The list of outstanding active customers together with the last version they accepted (or `Never accepted`), linking directly to both the customer profile and the version text.

### Policy Updates Tab (`/admin/policy-acceptances/updates`)

Open **Policy updates** (`/admin/policy-acceptances/updates`) to review the chronological publication log across policies, including each version's publication time, SHA-256 hash prefix, change summary, publishing administrator, and total customers who have accepted that version. Select any version badge or **Open exact text** link to open `/admin/policy-acceptances/versions/:versionId`, which displays the standalone read-only version text with a **Print** action.

### Customer Profile `Policies` Tab

On any customer detail page (`/admin/customers/:customerId`), open the **Policies** tab to view:

1. **Status per policy**: every active policy's requirement state for that customer (`Accepted — Current version`, `Update pending`, `Pending — Not yet accepted`, or `Not required`), with direct links to both the current version text and the customer's accepted version text.
2. **Full acceptance history**: a chronological log of every version the customer has accepted across account prompts and order gates, with **View evidence** and exact version text links on every entry.
