/**
 * Sign-in presentation: public read model + validated image uploads. Owner: platform engineer.
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { AuditUnavailableError, DomainError, notFound, validation } from "../../core/errors.js";
import { getRequestContext } from "../../core/requestContext.js";
import type { AuditEmitter, Clock, Db, ObjectStorage, SettingsStore, Tx } from "../../core/types.js";
import type { ActorGuard } from "./actorGuard.js";
import type { PublicPresentation, PublicSlide } from "./index.js";
import { validateImage, MAX_IMAGE_BYTES } from "./imageValidation.js";
import { platformPresentationImages, platformSettings } from "./schema.js";
import {
  BRAND_IMAGE_ALLOWLIST,
  PRESENTATION_ANNOUNCEMENT,
  PRESENTATION_SLIDES,
  PRESENTATION_SLIDESHOW,
  PRESENTATION_SUPPORT_TEXT,
  ULID_PATTERN,
  type Slide,
} from "./settings.js";
import { readSetting } from "./settingsRegistry.js";

export const PRESENTATION_IMAGE_ROUTE = "/api/platform/presentation/images";
export const MAX_UPLOADED_IMAGES = 50;

export interface PresentationDeps {
  db: Db;
  clock: Clock;
  audit: AuditEmitter;
  settings: SettingsStore;
  storage: ObjectStorage;
}

export interface PresentationImageSummary {
  id: string;
  source: "brand" | "upload";
  path: string;
  width: number;
  height: number;
  byteSize?: number;
  createdAt?: Date;
}

export function createPresentationService(deps: PresentationDeps) {
  const { db, clock, audit, settings, storage } = deps;

  /** With `tx` the rows are share-locked so a concurrent delete waits for the referencing write. */
  async function activeUploads(ids: readonly string[], tx?: Tx): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const query = (tx ?? db)
      .select({ publicId: platformPresentationImages.publicId })
      .from(platformPresentationImages)
      .where(and(inArray(platformPresentationImages.publicId, [...new Set(ids)].sort()), isNull(platformPresentationImages.deletedAt)));
    const rows = tx ? await query.for("share") : await query;
    return new Set(rows.map((row) => row.publicId));
  }

  function imagePath(image: NonNullable<Slide["image"]>): string {
    return image.source === "brand" ? BRAND_IMAGE_ALLOWLIST[image.id].path : `${PRESENTATION_IMAGE_ROUTE}/${image.id}`;
  }

  /** Extra validation for the slides setting: every uploaded image must exist. */
  async function assertSlidesReferenceKnownImages(slides: Slide[], tx?: Tx): Promise<void> {
    const uploads = slides.flatMap((slide) => (slide.image?.source === "upload" ? [slide.image.id] : []));
    const known = await activeUploads(uploads, tx);
    if (uploads.some((id) => !known.has(id))) {
      throw validation("UNKNOWN_IMAGE", "One of the selected images is no longer available.");
    }
  }

  async function publicPresentation(): Promise<PublicPresentation & { slideshow: { autoAdvance: boolean; intervalSeconds: number } }> {
    const [slides, slideshow, supportText, announcement] = await Promise.all([
      readSetting(settings, PRESENTATION_SLIDES),
      readSetting(settings, PRESENTATION_SLIDESHOW),
      readSetting(settings, PRESENTATION_SUPPORT_TEXT),
      readSetting(settings, PRESENTATION_ANNOUNCEMENT),
    ]);
    const known = await activeUploads(slides.flatMap((s) => (s.image?.source === "upload" ? [s.image.id] : [])));
    const out: PublicSlide[] = slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      body: slide.body,
      // An image that was removed after publication is silently dropped, never replaced by a remote URL.
      image:
        slide.image && (slide.image.source === "brand" || known.has(slide.image.id))
          ? { id: slide.image.id, alt: slide.image.alt, url: imagePath(slide.image) }
          : null,
    }));
    return {
      slides: out,
      slideshow,
      supportText,
      announcement: announcement.enabled ? { text: announcement.text, tone: announcement.tone } : null,
    };
  }

  async function listImages(): Promise<PresentationImageSummary[]> {
    const brand = Object.entries(BRAND_IMAGE_ALLOWLIST).map(([id, value]) => ({
      id,
      source: "brand" as const,
      path: value.path,
      width: value.width,
      height: value.height,
    }));
    const uploads = await db
      .select()
      .from(platformPresentationImages)
      .where(isNull(platformPresentationImages.deletedAt))
      .orderBy(desc(platformPresentationImages.id))
      .limit(MAX_UPLOADED_IMAGES);
    return [
      ...brand,
      ...uploads.map((row) => ({
        id: row.publicId,
        source: "upload" as const,
        path: `${PRESENTATION_IMAGE_ROUTE}/${row.publicId}`,
        width: row.width,
        height: row.height,
        byteSize: row.byteSize,
        createdAt: row.createdAt,
      })),
    ];
  }

  /** Caller must have verified admin + fresh step-up. Bytes are validated and metadata-stripped first. */
  async function uploadImage(bytes: Buffer, guard: ActorGuard): Promise<PresentationImageSummary> {
    if (bytes.length > MAX_IMAGE_BYTES) throw validation("IMAGE_TOO_LARGE", "Images must be 2 MB or smaller.");
    const result = validateImage(bytes);
    if (!result.ok) {
      await audit.record({
        category: "file",
        eventName: "platform.presentation.image.refused",
        action: "upload",
        outcome: "refused",
        severity: "WARN",
        reasonCode: `IMAGE_${result.reason}`,
        resource: { type: "presentation_image" },
      });
      throw validation(`IMAGE_${result.reason}`, "Please upload a PNG, JPEG or WebP image between 16 and 4096 pixels on each side, up to 2 MB.");
    }
    const sha256 = createHash("sha256").update(result.bytes).digest("hex");
    const key = storage.newKey("files");
    // Storage I/O happens BEFORE the transaction (never hold a connection/locks across it).
    await storage.put(key, result.bytes, { maxBytes: MAX_IMAGE_BYTES });
    const actorUserId = getRequestContext()?.actor?.userId ?? null;
    try {
      const publicId = await db.transaction(async (tx) => {
        await guard(tx);
        // Quota admission under lock: the slides setting row is the singleton admission lock shared with
        // slides updates and deletes (lock order: actor → slides row → image rows).
        await lockSlidesRow(tx);
        const active = await tx
          .select({ id: platformPresentationImages.id })
          .from(platformPresentationImages)
          .where(isNull(platformPresentationImages.deletedAt))
          .limit(MAX_UPLOADED_IMAGES + 1);
        if (active.length >= MAX_UPLOADED_IMAGES) throw validation("IMAGE_LIMIT_REACHED", "Remove an unused image before uploading another.");
        const [inserted] = await tx
          .insert(platformPresentationImages)
          .values({
            storageKey: key,
            mimeType: result.mime,
            byteSize: result.bytes.length,
            sha256,
            width: result.width,
            height: result.height,
            uploadedByUserId: actorUserId,
            createdAt: clock.now(),
          })
          .$returningId();
        const [row] = await tx
          .select({ publicId: platformPresentationImages.publicId })
          .from(platformPresentationImages)
          .where(eq(platformPresentationImages.id, inserted!.id));
        await audit.record(
          {
            category: "file",
            eventName: "platform.presentation.image.uploaded",
            action: "upload",
            outcome: "completed",
            resource: { type: "presentation_image", publicId: row!.publicId },
            safeCounts: { bytes: result.bytes.length, width: result.width, height: result.height },
            attributes: { mime_type: result.mime },
          },
          tx,
        );
        return row!.publicId;
      });
      return {
        id: publicId,
        source: "upload",
        path: `${PRESENTATION_IMAGE_ROUTE}/${publicId}`,
        width: result.width,
        height: result.height,
        byteSize: result.bytes.length,
        createdAt: clock.now(),
      };
    } catch (error) {
      // Delete the staged object ONLY when the transaction definitely rolled back: the error was raised by
      // our own code inside the callback (guard, quota, audit refusal) before COMMIT was attempted. Any
      // other database error may be an ambiguous COMMIT outcome — leave the object (an unreferenced object
      // is harmless and private; a referenced-but-missing one would break the slideshow).
      if (error instanceof DomainError || error instanceof AuditUnavailableError) await storage.delete(key).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Singleton admission lock shared by uploads, deletes and slides updates. The row is materialised
   * (version 0, no value ⇒ default in effect) so FOR UPDATE takes a real record lock, not a gap lock.
   */
  async function lockSlidesRow(tx: Tx): Promise<void> {
    await tx
      .insert(platformSettings)
      .ignore()
      .values({ settingKey: PRESENTATION_SLIDES.key, kind: "value", valueJson: null, version: 0, createdAt: clock.now(), updatedAt: clock.now() });
    await tx.select({ id: platformSettings.id }).from(platformSettings).where(eq(platformSettings.settingKey, PRESENTATION_SLIDES.key)).for("update");
  }

  async function deleteImage(publicId: string, guard: ActorGuard): Promise<void> {
    if (!ULID_PATTERN.test(publicId)) throw notFound();
    await db.transaction(async (tx) => {
      await guard(tx);
      // Lock order: slides setting row, then the image row (same order as uploads and slides updates).
      await lockSlidesRow(tx);
      const slides = await readSetting(settings, PRESENTATION_SLIDES, tx);
      if (slides.some((slide) => slide.image?.source === "upload" && slide.image.id === publicId)) {
        throw validation("IMAGE_IN_USE", "This image is used by a slide. Remove it from the slideshow first.");
      }
      const [row] = await tx
        .select()
        .from(platformPresentationImages)
        .where(and(eq(platformPresentationImages.publicId, publicId), isNull(platformPresentationImages.deletedAt)))
        .for("update");
      if (!row) throw notFound();
      // Durable audit first, then the (soft) delete — both in this transaction.
      await audit.record(
        {
          category: "file",
          eventName: "platform.presentation.image.deleted",
          action: "delete",
          outcome: "completed",
          resource: { type: "presentation_image", publicId },
        },
        tx,
      );
      await tx.update(platformPresentationImages).set({ deletedAt: clock.now() }).where(eq(platformPresentationImages.id, row.id));
    });
    // Definitive outcome reached (COMMIT returned): collect bytes of deleted images, bounded.
    await purgeDeletedImageObjects(10).catch(() => 0);
  }

  /**
   * Garbage-collects stored bytes of soft-deleted images, oldest first, after the authoritative commit.
   * The row stays as the durable record; `object_purged_at` marks success so the sweep advances and a
   * failed delete is retried on the next sweep. Runs (bounded) after every delete; also callable by a job.
   */
  async function purgeDeletedImageObjects(limit = 20): Promise<number> {
    const rows = await db
      .select({ id: platformPresentationImages.id, storageKey: platformPresentationImages.storageKey })
      .from(platformPresentationImages)
      .where(and(isNotNull(platformPresentationImages.deletedAt), isNull(platformPresentationImages.objectPurgedAt)))
      .orderBy(asc(platformPresentationImages.id))
      .limit(Math.max(1, Math.min(500, limit)));
    let purged = 0;
    for (const row of rows) {
      try {
        await storage.delete(row.storageKey);
      } catch {
        continue; // retried next sweep
      }
      await db
        .update(platformPresentationImages)
        .set({ objectPurgedAt: clock.now() })
        .where(and(eq(platformPresentationImages.id, row.id), isNotNull(platformPresentationImages.deletedAt)));
      purged += 1;
    }
    return purged;
  }

  /** Public read of an uploaded image. Only non-deleted uploads; unknown ids are NOT_FOUND. */
  async function openImage(publicId: string): Promise<{ stream: Readable; mimeType: string; size: number; sha256: string }> {
    if (!ULID_PATTERN.test(publicId)) throw notFound();
    const [row] = await db
      .select()
      .from(platformPresentationImages)
      .where(and(eq(platformPresentationImages.publicId, publicId), isNull(platformPresentationImages.deletedAt)))
      .limit(1);
    if (!row) throw notFound();
    return { stream: await storage.get(row.storageKey), mimeType: row.mimeType, size: row.byteSize, sha256: row.sha256 };
  }

  return { publicPresentation, listImages, uploadImage, deleteImage, openImage, assertSlidesReferenceKnownImages, purgeDeletedImageObjects, lockSlidesRow };
}
export type PresentationService = ReturnType<typeof createPresentationService>;
