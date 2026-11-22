# Customer maintenance

Use **Console → Maintenance → Customer access** to pause new customer sign-ins, registrations, and customer single sign-on. It starts off and is separate from **Queue admission**, which controls background worker claims. Staff and administrators can still sign in and see the customer maintenance banner in the console.

## Set a window

- **Enable customer maintenance**: Leave **Start (UTC)** blank for an immediate start, or enter a future UTC date and time. Leave **Expected end (UTC)** blank to keep it on until you turn it off. A specified end automatically reopens access at that instant, even if background workers are paused.
- **Public message**: Enter a short plain-text notice, or leave it blank to use the standard notice. The message and expected end are visible to anyone while the window is active. Never include customer details, credentials, or private operational information.
- **Review and save**: Select **Review customer access change**, confirm the change, and complete fresh verification when prompted. A concurrent edit requires you to discard your draft and review the updated settings. Review and save with the enable checkbox cleared to reopen access early.

## End existing sessions

Saving a window does not sign customers out. While the window is active, **End customer sessions now** is a separate action. Type the confirmation and complete fresh verification to end existing customer sessions. Staff and administrators are not signed out. This action does not edit or extend the window.

## Review audit evidence

Filter the Audit Center on `job.customer_maintenance.changed` for configuration changes and `auth.session.ended_all_customers` for the separate Identity bulk action. The configuration event retains state and UTC schedule but does not copy the public message.

To send an optional notice, configure an automation on **Customer maintenance scheduled or changed** (`customer_maintenance.configured`) and select **Maintenance window notice** (`platform.maintenance_window`) and your intended recipients. It runs when an enabled window is saved, not at the scheduled start. It uses a standard summary and portal link, not the configured banner text. There is no automatic customer-wide mailing.

For the copy customers can see, see [Customer help: maintenance](CUSTOMER_MAINTENANCE_HELP.md).
