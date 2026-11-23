# App composition, session and auth/dashboard API

Owner: ui_foundation_engineer. The UI kit is documented in `client/src/ui/README.md`.

## Session (`@/lib/session`)

| Export | Purpose |
| --- | --- |
| `useSession()` | `{ view, me, refresh, query }`. `view.status` is one of `loading`, `anonymous`, `remediation` (has `nextStep`), `full` or `error`. Backed by `identity.me` (key `ME_QUERY_KEY`). |
| `useRefreshSession()` | Re-fetches `identity.me`. Call it after any server call that changes session state (MFA, password, recovery codes). |
| `isUnauthenticated(err)` | `true` when the server says `UNAUTHENTICATED`. |

## Sign-out and client caches (`@/lib/signOut`)

- `useSignOut()` first revokes the session on the server. It then clears the TanStack cache and Cache Storage, drops the staged recovery batch and navigates to `/sign-in`.
- If revocation fails, it still wipes local data and then re-checks `me`. If the session is still live, it shows a danger toast and stays on the page.
- `clearClientCaches()` wipes the client caches only.

## Cache isolation (`@/lib/cacheIsolation`, `app/providers.tsx`)

- `IdentityScope` keys the private cache on `publicId|role|state|nextStep`.
- When that key changes (sign-out, expiry, a cross-tab user swap, a role or state change), the subtree is withheld for one commit. `purgePrivateCache` then removes every non-`me` query and the whole mutation cache.
- Any non-`me` query that fails with `UNAUTHENTICATED` triggers a re-check of `me`.

## Recovery-code hand-off (`@/lib/recoveryBatch`)

- `stageRecoveryBatch({ recoveryCodes, recoverySetId })`, `useRecoveryBatch()` and `clearRecoveryBatch()`.
- Batches are held in module memory only and are never persisted.
- They are cleared on acknowledgment, sign-out and any definitive anonymous state.

## AuthApi (`@/lib/authApi`)

- A typed facade over tRPC for identity, assurance, platform presentation and the maintenance banner.
- In tests, inject it with `<AuthApiProvider api={fakeAuthApi({...})}>` (see `@/ui/testing`).

## Guards (`app/guard.ts`)

`decideRoute(access, path, view)` returns `render`, `loading`, `redirect`, `not-found` or `unavailable`:

| access | anonymous | remediation | full |
| --- | --- | --- | --- |
| public | render | render | entry paths (`/sign-in`, `/register`, `/forgot-password`) redirect home |
| transition | redirect `/sign-in` | render if the path matches `nextStep`, else redirect to it | redirect home |
| customer / staff / admin | redirect `/sign-in?next=` | redirect to the step | render if the role allows it, else `not-found` (no existence leak) |

- `safeNextPath` only accepts same-app absolute paths. It rejects `//…`, `/\…`, control characters, auth or step paths and anything over 512 characters.
- The client guard is a convenience. Every procedure is authorised on the server.

## Routing

- Path routing is used normally. The preview build uses hash routing through `usePreviewLocation`, which splits `#/path?query`.
- Every route passes through `RouteGate`: guard → shell → `ErrorBoundary` → `Suspense` → page → `RouteFocus`.
- `RouteFocus` sets the title to `X · ReadyPackets`, focuses the `h1` and announces the page.
- `IdleTimeout` (full sessions only) warns 2 minutes before 30 minutes of inactivity. These are client-side defaults; the server enforces expiry.

## Shells (`app/shell/*`)

- `CustomerShell` has a top bar, the primary nav at `lg` and above, a menu drawer at `md`, a bottom "Quick navigation" bar below `md`, and the footer.
- `ConsoleShell` has a collapsible navy sidebar (a drawer on mobile) with grouped nav.
- `PublicFrame` wraps the auth and public pages.
- The footer shows the "Ready Packets Consulting LLC" legal line and a link to https://www.readypackets.com (`target=_blank rel="noopener noreferrer"`).
- Slots (`app/slots.tsx`) are lazy and isolated by error boundaries: `NotificationSlot`, `GlobalSearchSlot` and `AnalyticsConsentSlot`. The consent slot is optional; it is found through `import.meta.glob` of `features/integrations/consent.tsx`.

## Dashboard (`features/dashboard`)

- Routes: `/` (customer home) and `/admin` (console overview, staff).
- Widgets come from `WIDGETS` in the registry and are filtered by `area` and role. A `span` of 4, 6, 8 or 12 maps to `lg:col-span-*`, and widgets are full width below `lg`. Each widget has its own error boundary and Suspense.
- `RequiredActions` reads the assurance state and prompts when 3 or fewer recovery codes remain, or when the user has no passkey.

## Auth routes (`features/auth/routes.tsx`)

- Public: `/sign-in`, `/register`, `/forgot-password`, `/reset-password?token=`, `/activate?token=`, `/verify-email[?token=]`.
- Transition: `/mfa`, `/mfa/enrol`, `/mfa/recovery-codes`, `/change-password`.
- Tokens are read once and removed from the URL with `history.replaceState`.
- `previewLink` values are relative app paths and are shown only in the "Preview environment" callout.

## PWA

- **Install**: `PwaInstallEntry.tsx` exports a shared `usePwaInstall()` and controlled `PwaInstallDialog`. Call `prompt()` from a user gesture and open the dialog only for `unavailable`. The native one-shot prompt and Safari instructions are suppressed in installed/standalone mode. The sole persistent preference is a device boolean for install dismissal; it holds no portal or session data.
- **Worker and updates**: `PwaUpdatePrompt.tsx` registers `${BASE_URL}sw.js` in the standard production build only. `src/pwa/sw.ts` precaches only allowlisted public static assets fetched without credentials and refuses private, attachment, redirected or unexpected response types. The dynamic application document, APIs (`/api` and `/trpc`), uploads and downloads do not enter the worker cache. No background sync. Updates are user-driven (`SKIP_WAITING`).
- **Offline and sign-out**: Normal navigations go to the network first. Only eligible same-origin HTML navigations may get the public offline document on network failure. Sign-out clears Cache Storage, including the public precache; a script-free offline response built into the worker still works without re-creating the cache.
