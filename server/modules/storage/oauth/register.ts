import { lte } from "drizzle-orm";
import type { Services } from "../../../container.js";
import { dropboxAdapter } from "../adapters/dropbox.js";
import { googleDriveAdapter } from "../adapters/googleDrive.js";
import { reserveGoogleDriveFolder } from "./googleDriveFolders.js";
import { providerRequest, type StorageOAuthProvider } from "./provider.js";
import { storageOAuthAttempts } from "./schema.js";

export function requestForOAuthProvider(services: Services, provider: StorageOAuthProvider) {
  return providerRequest(services.integrations.egress, provider === "dropbox" ? "storage_dropbox" : "storage_gdrive");
}

export function registerStorageOAuthAdapters(services: Services): void {
  services.storageConnections.registerAdapter("dropbox", dropboxAdapter(requestForOAuthProvider(services, "dropbox")));
  services.storageConnections.registerAdapter("google_drive", googleDriveAdapter(requestForOAuthProvider(services, "google_drive"),
    reserveGoogleDriveFolder(services)));
  const prune = "storage.oauth.prune";
  services.jobs.register(prune, async (job) => {
    await services.db.transaction(async (tx) => {
      job.signal.throwIfAborted();
      await job.assertStillOwned(tx);
      await tx.delete(storageOAuthAttempts).where(lte(storageOAuthAttempts.expiresAt, services.clock.now())).limit(100);
    });
    return { outcome: "completed" };
  }, { retrySafe: true });
  services.jobs.registerSchedule({ name: prune, type: prune, everyMs: 60_000 });
}
