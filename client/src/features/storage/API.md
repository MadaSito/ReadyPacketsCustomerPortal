# Storage Connections & SharePoint Order Sync Client Feature (`client/src/features/storage`)

Owner: `siem_engineer` (Increment 03, Package E)

## Routes & Console Navigation
- **Storage connections**: `/admin/storage` (`group: "Integrations"`, `order: 63`, `access: "admin"`, `capability: "storage.manage"`).
- **Add / Edit connection wizard**: `/admin/storage/new` and `/admin/storage/:publicId/edit` (`capability: "storage.manage"`).
- **SharePoint order sync**: `/admin/sharepoint-sync` (`group: "Integrations"`, `order: 64`, `access: "admin"`, `capability: "storage.manage"`). Uses sibling path `/admin/sharepoint-sync` (not `/admin/storage/sharepoint`) so `ConsoleShell` prefix active state highlights each entry independently.

## Consumed Server Procedures & Endpoints
- `trpc.storage.connections.{list,get,create,update,test}` (`server/modules/storage/router.ts`)
- `trpc.storage.assignments.{list,set}` (`order_files` up to 8, `backups` up to 8, `order_data` max 1)
- `trpc.integrations.admin.egress.{presets,setPreset}` (`server/modules/integrations/router.ts`)
- `trpc.sharepoint.admin.{discoverSite,listDrives,resolveOneDrive,listFolders}` (`server/modules/sharepoint/router.ts`)
- `trpc.sharepoint.admin.orderSync.{get,listLists,createList,update,test,backfill,resyncAll,status}` (`server/modules/sharepoint/router.ts`)
- Raw OAuth HTTP routes (`server/modules/storage/oauth/http.ts`):
  - `GET /api/storage/oauth/redirect-uri/:provider`
  - `POST /api/storage/oauth/start`
  - `POST /api/storage/oauth/disconnect`
  - `POST /api/storage/oauth/finish` (`{ attemptHandle }` parsed once from `?oauth=finish#oauth-attempt=<43-char-handle>` after pre-refreshing `GET /api/csrf`, with immediate `history.replaceState` URL cleanup).
