# Policy notices and session enforcement

Notices and enforcement are independent. An active, published policy that requires acceptance can send notices while session enforcement remains off. The grace period is enforced on the server; a browser countdown does not grant access or extend it.

## Policy notices

- **Delay**: Set hours for future publications on the policy detail page. The default is 24 hours; 0 queues immediately. Changing that preference does not move an existing notice. Use Change time or Cancel notice on the scheduled version instead.
- **Immediate send**: A user with `policies.notices.send` must confirm the current recipient count and complete step-up if needed. A changed count or revision requires new review. Scheduled and immediate sends only select active recipients in the policy audience who have not accepted that exact version at selection time.
- **Reminders**: An authorized operator can send to remaining non-acceptors only after 24 hours. An original mail or a reminder has one outbox key and one in-app notification key per recipient and round; retrying a dispatch chunk does not duplicate it.
- **Progress**: Queued, Sent and Failed are mail-outbox counts for the current dispatch or reminder round. Sent means the provider accepted the message, not that it reached the mailbox. Accepted reflects recorded policy acceptance by the current audience. If a dispatch job fails before it can finish queueing, inspect the batch job's reason in Jobs and correlate it with `policy.notice.*` events. The notice's mail counters do not replace the Jobs failure view.

## Session enforcement

- **Configuration**: Session enforcement defaults to off. Enabling it for an active, effective, required policy or shortening grace requires confirmation of the affected count. The deadline is the latest of publication, effectiveness and enforcement enablement, plus the configured grace hours. A custom warning may use `{policy}`, `{deadline}`, and `{timeLeft}`.
- **Users**: During grace, the portal provides a warning and exact-version review. Declining signs the user out. After deadline, pre-deadline sessions cannot continue normal portal use; the worker sweeps affected existing sessions. A new sign-in follows the normal identity steps, then the user can review and accept the blocking policy or sign out. Acceptance is tied to the published version and content hash.
- **Admin revocation**: Use End sessions now in acceptance coverage or the customer's Policies tab. It checks pending enforcement and requires `sessions.revoke_any` plus step-up. The durable audit records `policy.enforcement.session_ended` with its trigger and session count; it does not include signature text or session tokens.
- **Host emergency override**: Work through [Break-glass operations](../../../docs/operations/BREAK_GLASS.md). Set the flag consistently on web and worker instances; it does not restore revoked sessions or disable separate order/checkout acceptance gates.
