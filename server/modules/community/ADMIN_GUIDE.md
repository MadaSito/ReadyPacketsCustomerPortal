## Community forum

The community forum lets signed-in customers ask questions and help each other. It is switched off on new installations. While it is off, community pages and navigation are hidden for everyone and the server refuses every community request.

### Who can do what

| Role | Capability | Can |
| --- | --- | --- |
| Customer | — | Read, choose a display name, start topics, reply, edit own posts within the edit window, mark posts helpful, report posts, follow topics |
| Staff | `community.moderate` | Everything above, plus the review queue, reports, hide/remove posts, lock/pin/move topics, suspend members from posting, the moderation log. Staff posts are never rate-limited or held. |
| Administrator | `community.manage` | Switch the forum on or off, change posting rules and word lists, add, archive and reorder categories |

Settings changes require a fresh sign-in confirmation (step-up). Every change is recorded in the audit log (`community.*` events) and moderation actions also appear in **Console → Community moderation → Moderation log**.

### Switching it on

1. Open **Console → Community settings** (`/admin/community/settings`).
2. Add at least one category. The web address uses lower-case letters, numbers and hyphens, for example `billing-questions`.
3. Review the posting rules, then turn on **Community forum switched on**.

Switching off hides everything again immediately; content is kept.

### Posting rules

| Rule | Default | Effect |
| --- | --- | --- |
| Edit window | 30 minutes | Authors can edit their own post for this long. 0 disables editing. |
| Posts per hour per member | 20 | Applies to all customers. |
| New member period | 7 days | Accounts younger than this get the stricter limits below. |
| Posts per day for new members | 5 | Further posts are refused until the next day. |
| First posts held for review | 2 | A new member's first posts wait in the review queue. |
| Reports before a post is hidden | 3 | Distinct members. The post is hidden until a moderator decides. Staff posts are never hidden automatically. |
| Blocked words | none | Posts containing them are refused. Whole words or phrases, not case-sensitive, up to 200 entries of 40 characters. |
| Words that hold a post | none | Posts containing them wait for review. |

Always on: an identical post from the same member within 10 minutes is refused, and new members' posts with more than 3 links are held. An edit that breaks these rules is held again.

### Moderating

**Console → Community moderation** (`/admin/community`) has three tabs:

- **Review queue**: held and hidden posts. Approve, hide, show again or remove (removal asks for confirmation). Suspend a member from posting for 1, 7 or 30 days, or until lifted. A reason is required.
- **Reports**: open member reports. Hide the post (marks the report handled) or dismiss.
- **Moderation log**: every moderation action, with the moderator and reason.

### Categories

Archiving a category keeps it readable but refuses new topics, replies and edits. Use **Move up** and **Move down** to change the order members see. **Staff posts only** suits announcement categories.

### Privacy and safety

- Members post under a display name. Display names that look like e-mail addresses, contain long numbers or use reserved words such as "Support" or "Admin" are refused.
- Only `https://` links are made clickable, and they carry `rel="noopener noreferrer nofollow ugc"`. Community pages are marked `noindex` so search engines do not index member content.
- Reply notifications contain a link only, never post text.

### Automations and SIEM

Two staff-only triggers are available in Automations: **Community topic created** and **Community post reported**. All `community.*` audit events flow to the audit centre and any configured SIEM or syslog export like other events.
