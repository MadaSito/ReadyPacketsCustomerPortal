# Customer Referral Programme — Administrator Guide

## Overview
The ReadyPackets customer referral programme allows existing customers to share a personal 10-character referral link and earn account credits when a referred customer registers and completes their first paid invoice in full.

For operational safety, the referral programme **ships disabled by default**. Customer navigation entries (`/account/referrals`), registration attribution, and referral e-mail invitations remain inactive until an administrator enables the programme in **Console -> Operations -> Referrals -> Programme settings**.

## Access & Permissions
- **Staff (`referrals.read_all`)**: Read-only access to referral metrics, attributed/qualified referrals, and the append-only reward ledger. Staff cannot change settings, approve or reject referrals, record credits, or export referral records.
- **Administrators (`referrals.manage` + recent MFA step-up)**: Full access to configure programme rules, approve or override rewards, reject ineligible referrals, record applied credits, and export bounded CSV/JSON reports. Every privileged action re-validates the administrator session in the portal database transaction and writes a durable audit event.

## Configuring the Programme
1. Sign in to the Console as an administrator, complete MFA step-up if prompted, and open **Operations -> Referrals**.
2. Select the **Programme settings** tab:
   - **Enable customer referral programme**: Controls the `feature.referrals` flag across customer navigation, registration attribution, and invoice qualification.
   - **Require manual administrator approval**: Recommended and enabled by default. Qualified referrals wait in `Pending approval` until an administrator approves or rejects them. When turned off, same-currency qualified referrals approve automatically upon first paid invoice.
   - **Reward calculation mode**:
     - **Fixed credit**: Awards a fixed integer minor-unit credit in the programme currency (for example, `$25.00 USD`).
     - **Percentage with cap**: Awards a percentage of the referred customer's net pre-tax first invoice, capped at the configured maximum reward amount.
   - **Invitation anti-abuse limits**: Bounds how many referral e-mails a customer may send per 24 hours and how many invitations a single recipient address may receive across all customers within the cooldown window.
3. Activate **Save programme settings**. Changes take effect immediately and record `referrals.settings_updated` in the audit log.

## Reviewing Qualified Referrals & Recording Credits
1. When a referred customer registers with `?ref=<CODE>` (or within 30 days of visiting a referral link on the same browser) and pays their first invoice in full, the referral moves from `Attributed` to `Pending approval` (or `Approved` if automatic approval is enabled and the invoice currency matches the programme currency).
2. If the qualifying invoice currency differs from the configured programme currency, the row displays a **Currency mismatch** warning badge and always requires manual administrator review so no exchange rate is fabricated.
3. On the **Referrals** tab:
   - Choose **Approve** to confirm (or override) the reward amount and record an immutable `reward_approved` entry in the **Reward ledger**.
   - Choose **Reject** and enter a mandatory reason to decline self-referrals, test accounts, or ineligible orders (`referrals.rejected`).
   - Once an approved credit has been posted to the customer's billing account or fulfilled manually, choose **Mark credited**, select `Account credit` or `Manual payout`, and enter the billing credit note or payout reference (`credit_applied` ledger entry + `referrals.credited` audit event).

## Exporting Reports
Administrators can export up to 2,000 matching rows as **CSV** or **JSON** from the page header. Exports omit customer e-mail addresses and legal names for data minimization, neutralize leading spreadsheet formula characters (`=`, `+`, `-`, `@`, tab, carriage return), and record `referrals.exported` in the audit log.
