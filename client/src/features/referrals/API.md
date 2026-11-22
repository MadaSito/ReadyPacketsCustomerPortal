# Client Feature API — Referrals (`client/src/features/referrals`)

## Exported Feature Descriptor (`./routes`)
```ts
export const referralsFeature: FeatureRoutes;
```
- **Customer route**: `/account/referrals` (`access: "customer"`, title `"Referrals"`)
- **Customer navigation**: `group: "Account"`, `order: 210`, `enabledBy: "referrals"`
- **Console route**: `/admin/referrals` (`access: "staff"`, `capability: "referrals.read_all"`, title `"Referrals"`)
- **Console navigation**: `group: "Operations"`, `order: 28`, `capability: "referrals.read_all"`
- **Registration capture wrapper**: `routeWrappers` entry on `/register` (`order: 50`, `RegisterReferralCapture`) that captures `?ref=<CODE>` into the first-party `/api/referrals/hold` cookie (`30d` TTL).

## Exported Registration Hold Helpers (`./routes` & `./api`)
- `holdReferralCodeFirstParty(rawCode: string): Promise<void>` — validates 10-char unambiguous format and `POST`s `/api/referrals/hold` via `sessionFetch`.
- `fetchHeldReferralCodeFirstParty(): Promise<string | null>` — reads held code from `GET /api/referrals/hold` (or in-memory fallback).
- `clearHeldReferralCodeFirstParty(): Promise<void>` — clears the first-party hold cookie via `DELETE /api/referrals/hold` after registration completes.
- `getInMemoryHeldReferralCode(): string | null` — synchronous tab-session fallback.
