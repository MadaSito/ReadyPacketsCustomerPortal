/**
 * Customer billing profile schema (Increment 08, Decision D4).
 * Owner: compliance_engineer.
 *
 * Security invariants:
 *  - At most ONE saved billing profile per account (`UNIQUE(user_id)`), cascaded on account deletion.
 *  - `details_enc` stores the AES-256-GCM encrypted JSON `BillingDetails` (`shared/billingDetails.ts`)
 *    with AAD bound strictly to the owning user's portable `public_id`
 *    (`customer_billing_profiles.details:<userPublicId>`), preventing cross-row ciphertext substitution.
 *  - Only `country` (ISO 3166-1 alpha-2) and `region` are stored alongside the ciphertext; personal names,
 *    street addresses, postal codes, email addresses, companies, and tax IDs exist strictly inside `details_enc`.
 */
import { char, foreignKey, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
import {
  createdAtColumn,
  idColumn,
  publicIdColumn,
  refColumn,
  updatedAtColumn,
  versionColumn,
} from "../../db/columns.js";
import { users } from "../identity/schema.js";

export const customerBillingProfiles = mysqlTable(
  "customer_billing_profiles",
  {
    id: idColumn(),
    publicId: publicIdColumn(),
    userId: refColumn("user_id").notNull(),
    /** AES-256-GCM encrypted JSON (`BillingDetails`), AAD `customer_billing_profiles.details:<userPublicId>`. */
    detailsEnc: text("details_enc").notNull(),
    country: char("country", { length: 2 }).notNull(),
    region: varchar("region", { length: 64 }),
    version: versionColumn(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (t) => [
    uniqueIndex("cust_billing_prof_user_uq").on(t.userId),
    foreignKey({
      name: "cust_billing_prof_user_fk",
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete("cascade"),
  ],
);

export type CustomerBillingProfileRow = typeof customerBillingProfiles.$inferSelect;
export type NewCustomerBillingProfileRow = typeof customerBillingProfiles.$inferInsert;
