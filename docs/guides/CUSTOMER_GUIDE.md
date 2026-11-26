# Customer guide — ReadyPackets portal

How to use the customer portal at `https://my.readypackets.com`. This guide is written from the routes in
`client/src/features/**/routes.tsx` and the module contracts in `server/modules/*/API.md` at the time of writing.
Anything that exists on the server but has no screen yet is marked **Not available yet**.

> Status legend: **Available** — a routed screen exists. **Not available yet** — the server supports it, but there is
> no page in the current build. **Disabled in this release** — deliberately switched off.

## Contents

- [Create your account](#create-your-account)
- [Confirm your email](#confirm-your-email)
- [Sign in and two-step verification](#sign-in-and-two-step-verification)
- [Set up an authenticator app](#set-up-an-authenticator-app)
- [Recovery codes](#recovery-codes)
- [Passkeys](#passkeys)
- [Forgot your password](#forgot-your-password)
- [Your account and sessions](#your-account-and-sessions)
- [Home](#home)
- [Orders](#orders)
- [Files](#files)
- [Sharing an order](#sharing-an-order)
- [Messages, support, policies and invoices](#messages-support-policies-and-invoices)
- [Notifications and search](#notifications-and-search)
- [Install the portal as an app](#install-the-portal-as-an-app)
- [Privacy and analytics](#privacy-and-analytics)

## Create your account

**Available** — `/register` ("Create your account").

1. Open **Create an account** from the sign-in page.
2. Enter your full name, email address and a password. The password length rules are shown on the form
   (`identity.passwordPolicy`).
3. Submit. You always see "Check your email", whether or not the address already has an account. This is
   deliberate, so the portal never reveals who is registered.
4. If the address already has an account, the email you receive contains a sign-in link instead of a new
   confirmation link.

The register page notes that you will confirm the current versions of the portal's policies after signing in. The
policy acceptance screens are still in progress; see [below](#messages-support-policies-and-invoices).

If your account was created for you by ReadyPackets, you receive an invitation instead. Open the link to reach
`/activate` ("Activate your account") and choose your password. Invitation links expire after 72 hours.

## Confirm your email

**Available** — `/verify-email` ("Confirm your email").

Open the link in the confirmation email. It is single-use and expires after 24 hours. When you are signed in, the
page offers **Send a new link**; you can request one at most once every 60 seconds.

## Sign in and two-step verification

**Available** — `/sign-in`, `/mfa`, `/mfa/enrol`, `/mfa/recovery-codes`, `/change-password`.

1. Enter your email and password on `/sign-in`. A wrong email or password always gives the same message.
2. Every account must use two-step verification. The portal then takes you to whichever step is still needed:
   - **Set up two-step verification** (`/mfa/enrol`) the first time.
   - **Two-step verification** (`/mfa`) on later sign-ins. Enter a 6-digit authenticator code, use a passkey (offered
     only if you have registered one) or enter a recovery code.
   - **Set a new password** (`/change-password`) if an administrator issued you a temporary password.
3. Until those steps are complete you cannot open the rest of the portal.

Repeated wrong authenticator codes are limited. From the tenth consecutive failure the app is paused for a period that
doubles each time (30 seconds up to 1 hour). After 50 failures the authenticator app stays blocked until you replace
it using another method (passkey or recovery code) or ReadyPackets resets your two-step verification. You receive an
in-app notification when this happens. A correct code resets the count.

Sessions end after a period of inactivity. You see a warning 2 minutes before you are signed out, and another
before the session's absolute end time, which cannot be extended.

Some sensitive actions, such as adding a passkey or replacing recovery codes, ask you to **verify it's you** again
with your password and a second factor.

## Set up an authenticator app

**Available** — `/mfa/enrol` during first sign-in, and **Account security** (`/account/security`) afterwards.

1. Open your authenticator app, such as Microsoft Authenticator, Google Authenticator, 1Password or Authy.
2. Scan the QR code, or choose **Copy setup key** and enter the key manually.
3. Enter the 6-digit code shown by the app.
4. The QR code and setup key work for 10 minutes and are tied to the current sign-in. If they expire, or if you sign in again and start over, the page shows a new QR code. Remove the earlier ReadyPackets entry from your authenticator app and scan the new one.

On **Account security** you can also remove the authenticator app. This is allowed only if you have at least one
passkey, so you never lose all strong sign-in methods.

## Recovery codes

**Available** — `/mfa/recovery-codes` and **Account security** → **Recovery codes**.

- After your first authenticator is set up you receive 10 recovery codes. Each code works once.
- Copy them or download them as a text file and store them offline. You must confirm that you saved them before you
  continue.
- The portal never shows the same codes again. If you lose them, choose **Replace your recovery codes** on
  **Account security**; the old codes stop working immediately.
- The page shows how many unused codes you have left.

## Passkeys

**Available** — **Account security** → **Passkeys**.

A passkey uses your device PIN, biometrics or a security key. In this release a passkey is a second factor: you still
sign in with your password first.

- **Add**: choose **Register a passkey**, verify it's you, follow your browser's prompt, then name the passkey. You can
  register up to 10.
- **Rename** or **Remove**: use the buttons next to each passkey. You cannot remove your last passkey unless an
  authenticator app is also set up.

## Forgot your password

**Available** — `/forgot-password` ("Reset your password") and `/reset-password` ("Choose a new password").

1. Enter your email. You always see the same confirmation message.
2. If the account exists, an email with a reset link is sent. It expires after 30 minutes and works once.
3. Choose a new password. Every session on every device is signed out, and you sign in again.

## Your account and sessions

- **Your account** (`/account`) — **Available**. Change your full name, change your password (other sessions are
  signed out) and see your account details.
- **Account security** (`/account/security`) — **Available**. Authenticator app, passkeys and recovery codes.
- **Sessions** (`/account/sessions`) — **Available**. See where you are signed in (browser summary, created, last seen
  and expiry). Sign out a single session or **Sign out others**.

You cannot change your own email address or customer reference in the portal; contact ReadyPackets.

## Home

**Available** — `/`. Shows required actions, a greeting, a short first-order guide and your recent orders.

On a phone, the tab bar at the bottom has **Home**, **Orders**, **New order**, **Messages** and **More**.

## Orders

**Available** — `/orders`, `/orders/new`, `/orders/:orderId`.

Orders organised into phases guide you through each step; see [Working through your order's phases](./ORDER_PHASES_HELP.md).

- **List**: `/orders` lists every order you own or that is shared with you, with its status. Invitations to
  orders other people shared with you appear here too, where you accept or decline them.
- **New order**: `/orders/new` is a step-by-step form. Choose products from the catalog, enter a project name and an
  optional **Note for ReadyPackets**, review the summary and submit. If the catalog is empty you see "Nothing is
  available to order yet".
- **Order detail** has these tabs:
  - **Overview** — summary and items.
  - **Activity** — status history.
  - **Notes** — add a note. Notes you add are visible to you and ReadyPackets staff.
  - **Sharing** — see [Sharing an order](#sharing-an-order).
  - **Files** — see [Files](#files).
- **Discount codes and cart suggestions** (when your portal has them switched on): see
  [Using a discount code](./DISCOUNT_CODES_HELP.md) and [Suggestions in your cart](./CART_SUGGESTIONS_HELP.md). The
  discount code field is in your cart once it has an item, and at checkout.
- **ReadyPackets staff viewing the portal**: staff and administrators cannot place orders or use a cart as themselves.
  They place orders for a customer from the console, and the order then appears in that customer's portal. They switch
  portals with **Admin portal** or **Staff portal**. Customers do not see this switch. See
  [Admin guide — Placing an order for a customer](./ADMIN_GUIDE.md#placing-an-order-for-a-customer) and
  [Switching between the admin and customer portals](./ADMIN_GUIDE.md#switching-between-the-admin-and-customer-portals).
- Orders may be **locked** (for example, on legal hold or after an import). A lock blocks changes but not reading.
- Whether you can move an order to another status depends on its workflow; the order shows only the actions allowed
  for you.

## Files

**Available** — the **Files** tab on each order.

- **Upload**: choose files or drag them into the drop zone. The tab shows the size and type rules for that order
  before you upload; the server checks them again.
- **Versions**: **Upload a new version** keeps earlier versions. Tick **Include previous versions** to see them.
- **Download**: each download uses a single-use ticket that expires in 60 seconds, so download links cannot be
  copied and reused.
- Files staff mark as internal are not shown to you.

## Sharing an order

**Available** — the **Sharing** tab on an order you own.

1. Enter the person's email and choose **Viewer** (read only) or **Contributor**.
2. They accept or decline the invitation on their **Orders** page after signing in to their own account. The email on their account must be verified
   and must match the invitation.
3. To stop sharing, choose **Revoke access**.

## Messages, support, policies and invoices

The server supports these today. Their customer screens are **in progress**: the pages and routes below exist in the
working tree but were **not yet committed** when this guide was written, so they may not be in your build. If an
item is missing from the portal menu, it has not landed yet.

| Area | Planned screen (uncommitted) | Server capability (from `API.md`) |
| --- | --- | --- |
| Order messages | **Messages** (`/messages`) and a **Messages** tab on each order | Threads per order, unread counts, attachments |
| Support tickets | **Support** (`/support`, `/support/new`, `/support/:ticketId`) | Open, reply to, close and reopen your own tickets |
| Policies | **Policies** (`/policies`), public **Legal Policies** (`/legal`), and a required-policies notice on Home; required policies must be accepted before **New order** | View published policies; accept the exact required version |
| Order intake | **Intake** tab on each order | Save a draft, submit, and see the review result |
| Invoices | **Invoices** (`/invoices`, `/invoices/:invoiceId`) and an **Invoices** tab on each order | Issued, paid and void invoices with payment history; each invoice and receipt shows its **Order** and **Project**, also in the PDF and e-mail |
| Notifications and search | **Notifications** (`/notifications`), **Search** (`/search`) | See below |
| Online card payment | — | **Disabled in this release**; staff record offline payments |


### Paying online

- **Placing the order.** When card payment is available, placing an order takes you to Stripe's secure payment page at `checkout.stripe.com`.
- **If the payment page cannot open,** your order and invoice are still saved. You see "Your order … is placed, but we could not open the secure payment page".
  - When card payment is available, **Pay now** is offered there, on the payment status page and on the invoice.
  - Or pay by invoice using the instructions on it.
  - Do not place the order again.
- **If you leave the payment page,** the status page says whether your order is waiting for payment or whether a payment is being confirmed. If it is waiting for payment and card payment is available, **Pay now** is offered. If an earlier payment session may still be open, the page warns you not to pay twice.
- **More help.** See [Online payment](../../server/modules/payments/HELP_ARTICLE.md).

## Notifications and search

**Available** — the bell and search box in the page header.

- The bell shows your unread notifications. Security notifications cannot be turned off.
- Search finds your orders and related items (2–64 characters).
- Email preferences per category exist on the server; there is no settings screen for them yet.

## Install the portal as an app

**Available** — the portal is a Progressive Web App (PWA) named "ReadyPackets".

- **Desktop (Chrome or Edge)**: choose the install icon in the address bar, or the browser menu → **Install
  ReadyPackets**.
- **Android (Chrome)**: menu → **Add to Home screen** or **Install app**.
- **iPhone or iPad (Safari)**: **Share** → **Add to Home Screen**.

The installed app always loads live data. Without a connection it shows an offline page; it does not keep your orders
or files offline.

**"ReadyPackets was updated on the server".** You see this when ReadyPackets has been updated but your open tab still runs the previous version.
- **Reload** switches to the new version. You stay signed in, but anything you typed on that page and did not save is lost.
- **Later** keeps the previous version until you move to another page. The message then appears again.
- The portal never reloads by itself.

These flows have not yet been checked in real browsers or on physical devices.

## Privacy and analytics

- Analytics (Microsoft Clarity and PostHog) are off by default. If ReadyPackets turns them on, they run only on the
  public privacy and terms pages and only after you accept the consent banner. They never run on sign-in, account,
  order, file, message, invoice or administration pages.
- The footer links to **Privacy** (`/privacy`) and **Terms** (`/terms`). No routes exist for those paths yet, so they
  currently show "Page not found". (A separate **Legal Policies** page at `/legal` is in progress.)
- The portal is not indexed by search engines (`robots.txt` disallows all paths).
