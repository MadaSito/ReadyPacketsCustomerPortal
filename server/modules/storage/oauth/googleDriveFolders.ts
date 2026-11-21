import { eq } from "drizzle-orm";
import type { Services } from "../../../container.js";
import type { ReserveDriveFolder } from "../adapters/googleDrive.js";
import { StorageAdapterError } from "../contracts.js";
import { storageGoogleDriveFolders as folders } from "./schema.js";

export function reserveGoogleDriveFolder({ db, crypto }: Pick<Services, "db" | "crypto">): ReserveDriveFolder {
  return async (key, generate) => {
    const locator = crypto.blindIndex(key, "storage-google-drive-folder");
    const aad = `storage_google_drive_folders.provider_id_enc:${locator}`;
    const read = async () => {
      const [row] = await db.select().from(folders).where(eq(folders.locator, locator)).limit(1);
      return row ? crypto.decrypt(row.providerIdEnc, aad) : undefined;
    };
    const existing = await read();
    if (existing) return existing;
    // ID generation can race, but no remote folder is created until all workers agree on the
    // durable winner. Do not hold a SQL transaction while calling Google.
    const generated = await generate();
    await db.insert(folders).values({ locator, providerIdEnc: crypto.encrypt(generated, aad) })
      .onDuplicateKeyUpdate({ set: { locator } });
    const winner = await read();
    if (!winner) throw new StorageAdapterError("PROVIDER_UNAVAILABLE", true);
    return winner;
  };
}
