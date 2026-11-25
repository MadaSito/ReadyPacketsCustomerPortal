import busboy from "busboy";
import type { Request, Router } from "express";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { z } from "zod";
import { stageKeySchema } from "../../../shared/workflowStages.js";
import type { Services } from "../../container.js";
import { DomainError, notFound, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { sendPrivateDownload } from "../../http/downloads.js";
import { getHttpState, requireFullSession } from "../../http/requestState.js";
import { readCookie } from "../../http/sessionTransport.js";
import { playbackLifetimeMs, type StagedUpload, type UploadAuthorization } from "./index.js";
import { uploadIntents } from "./governance.js";
import { fileCategories, fileVisibilities } from "./schema.js";
import { slotKeySchema, transcriptSchema } from "./settings.js";

const options = z.strictObject({
  category: z.enum(fileCategories).default("supporting"),
  visibility: z.enum(fileVisibilities).default("customer_visible"),
  versionOf: z.string().length(26).regex(ULID_PATTERN).optional(),
  slotKey: slotKeySchema.optional(),
  statusKey: slotKeySchema.optional(),
  source: z.literal("recording").optional(),
  stageKey: stageKeySchema.optional(),
  intent: z.enum(uploadIntents).optional(),
});
const downloadBody = z.strictObject({ ticket: z.string().length(43).regex(/^[a-zA-Z0-9_-]{43}$/) });
const publicId = z.string().length(26).regex(ULID_PATTERN);
const documentParams = z.strictObject({ orderPublicId: publicId, filePublicId: publicId });
const documentQuery = z.strictObject({ taskKey: slotKeySchema.optional() });
const playbackCookie = "rp_audio_grant";
const multipartInvalid = () => validation("INVALID_MULTIPART", "Send one or more files using the multipart file fields.");
const requestTooLarge = () => validation("UPLOAD_REQUEST_TOO_LARGE", "The upload request exceeds the allowed size.");
const countExceeded = () => validation("TOO_MANY_FILES", "This upload contains too many files.");
const fileTooLarge = () => validation("FILE_TOO_LARGE", "The file exceeds the allowed size.");

type Candidate = { staged: StagedUpload } | { error: unknown };

async function readMultipart(req: Request, services: Services, plan: UploadAuthorization): Promise<{ candidates: Candidate[]; transcript?: string }> {
  const type = req.get("content-type");
  if (!type || !/^multipart\/form-data(?:;|$)/iu.test(type)) throw multipartInvalid();
  const length = req.get("content-length");
  if (length && (!/^\d{1,15}$/u.test(length) || Number(length) > plan.rules.maxRequestBytes)) throw requestTooLarge();
  const requestedFiles = plan.versionOf ? 1 : plan.rules.maxFiles;
  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: req.headers,
      preservePath: false,
      defParamCharset: "utf8",
      limits: { files: requestedFiles, fields: 1, fieldSize: 16_001, parts: requestedFiles + 2,
        fileSize: plan.rules.maxFileBytes + 1, headerPairs: 32 },
    });
  } catch {
    throw multipartInvalid();
  }

  const files: Promise<Candidate>[] = [];
  const active = new Set<Readable>();
  let envelopeError: DomainError | undefined;
  let total = 0;
  let transcript: string | undefined;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      if (total > plan.rules.maxRequestBytes) return done(requestTooLarge());
      done(null, chunk);
    },
  });

  const fail = (error: DomainError) => {
    envelopeError ??= error;
    req.unpipe(meter);
    meter.unpipe(parser);
    // Do not destroy req's socket here: the outer pipeline may still return a safe error.
    if (!req.destroyed) req.resume();
    for (const stream of active) stream.destroy(error);
    meter.destroy();
    if (!parser.destroyed) parser.destroy(error);
  };
  const aborted = () => fail(validation("UPLOAD_INTERRUPTED", "The upload did not finish."));
  req.once("aborted", aborted);
  req.once("error", aborted);
  meter.on("error", (error: unknown) => fail(error instanceof DomainError ? error : multipartInvalid()));
  parser.on("error", (error: unknown) => fail(error instanceof DomainError ? error : multipartInvalid()));
  parser.once("filesLimit", () => fail(countExceeded()));
  parser.once("fieldsLimit", () => fail(multipartInvalid()));
  parser.once("partsLimit", () => fail(countExceeded()));
  parser.on("field", (name, value, info) => {
    if (name !== "transcript" || transcript !== undefined || info.nameTruncated || info.valueTruncated ||
      !["7bit", "8bit", "binary"].includes(info.encoding.toLowerCase())) {
      fail(multipartInvalid());
      return;
    }
    const parsed = transcriptSchema.safeParse(value);
    if (!parsed.success) {
      fail(validation("INVALID_AUDIO_TRANSCRIPT", "The transcript must be plain text, up to 4,000 characters."));
      return;
    }
    transcript = parsed.data;
  });
  parser.on("file", (name, stream, info) => {
    if (envelopeError) {
      stream.on("error", () => {});
      stream.resume();
      return;
    }
    active.add(stream);
    // Close and parser failures can arrive before async staging attaches the stream iterator.
    stream.on("error", () => {});
    const candidate = (async (): Promise<Candidate> => {
      try {
        if (name !== "files" || !info.filename ||
            !["7bit", "8bit", "binary"].includes(info.encoding.toLowerCase())) {
          fail(multipartInvalid());
          return { error: multipartInvalid() };
        }
        // A per-file staging refusal must not destroy Busboy's stream: the multipart parser waits
        // for its end event, including when skipping the rest of an over-limit part.
        const input = Readable.from(stream.iterator({ destroyOnReturn: false }), { objectMode: false });
        const staged = await services.files.stageUpload(info.filename, input, plan.rules);
        if (stream.truncated) {
          await services.files.cleanUpload(staged);
          return { error: fileTooLarge() };
        }
        return { staged };
      } catch (error) {
        if (!stream.destroyed) stream.resume();
        return { error: stream.truncated ? fileTooLarge() : error };
      } finally {
        active.delete(stream);
      }
    })();
    files.push(candidate);
  });

  try {
    const fullyParsed = finished(parser, { cleanup: true });
    req.pipe(meter).pipe(parser);
    await fullyParsed.catch(() => { envelopeError ??= multipartInvalid(); });
    const candidates = await Promise.all(files);
    if (transcript !== undefined && candidates.length !== 1) {
      envelopeError ??= validation("INVALID_AUDIO_TRANSCRIPT", "Supply an optional transcript only for one audio upload.");
    }
    if (envelopeError || candidates.length === 0) {
      await Promise.all(candidates.flatMap((candidate) => "staged" in candidate ? [services.files.cleanUpload(candidate.staged)] : []));
      throw envelopeError ?? multipartInvalid();
    }
    return { candidates, transcript };
  } finally {
    req.off("aborted", aborted);
    req.off("error", aborted);
  }
}

export function registerFilesHttpRoutes(router: Router, services: Services): void {
  router.post("/upload/:orderId", async (req, res) => {
    const principal = requireFullSession(req);
    const orderId = req.params.orderId;
    const query = options.safeParse(req.query);
    if (!orderId || orderId.length !== 26 || !ULID_PATTERN.test(orderId) || !query.success) throw multipartInvalid();
    const plan = await services.files.beginUpload(principal, orderId, query.data);
    let candidates: Candidate[];
    let transcript: string | undefined;
    try {
      ({ candidates, transcript } = await readMultipart(req, services, plan));
    } catch (error) {
      if (error instanceof DomainError) {
        if (error.reasonCode === "UPLOAD_REQUEST_TOO_LARGE" && req.httpVersionMajor === 1) res.set("Connection", "close");
        await services.files.rejectUpload(principal, orderId, error.reasonCode);
      }
      throw error;
    }
    try {
      const results = [];
      for (const [index, candidate] of candidates.entries()) {
        try {
          if ("error" in candidate) throw candidate.error;
          if (req.aborted || res.destroyed) throw validation("UPLOAD_INTERRUPTED", "The upload did not finish.");
          results.push({ index, outcome: "completed", file: await services.files.commitUpload(principal, plan, candidate.staged, transcript) });
        } catch (error) {
          if (error instanceof DomainError && error.code === "AUDIT_UNAVAILABLE") throw error;
          if (error instanceof DomainError && (["NOT_FOUND", "FORBIDDEN", "UNAUTHENTICATED", "LOCKED", "CONFLICT", "VALIDATION", "REMEDIATION_REQUIRED"].includes(error.code)
              || error.reasonCode === "FILE_SCANNER_UNAVAILABLE")) {
            await services.files.rejectUpload(principal, orderId, error.reasonCode);
            results.push({ index, outcome: "refused", reason: error.reasonCode, message: error.safeMessage,
              ...(error.reasonCode === "AGREEMENT_REQUIRED" ? { details: error.details } : {}) });
          } else {
            await services.files.rejectUpload(principal, orderId, "FILE_UPLOAD_UNCONFIRMED");
            results.push({ index, outcome: "unknown", reason: "FILE_UPLOAD_UNCONFIRMED", message: "The upload could not be confirmed. Reload the file list before retrying." });
          }
        }
      }
      res.set("Cache-Control", "no-store").json({ results });
    } finally {
      await Promise.all(candidates.flatMap((candidate) => "staged" in candidate ? [services.files.cleanUpload(candidate.staged)] : []));
    }
  });

  const documentPath = "/orders/:orderPublicId/:filePublicId/document";
  router.get(documentPath, async (req, res) => {
    const principal = requireFullSession(req);
    const locator = documentParams.safeParse(req.params);
    if (!locator.success || !documentQuery.safeParse(req.query).success) throw validation("DOCUMENT_REFERENCE_INVALID", "Choose a valid order document.");
    const { file, stream } = await services.files.openDocumentForEditing(principal, locator.data);
    let outcome: "completed" | "failed" | "unknown" = "unknown";
    try {
      await sendPrivateDownload(res, { stream, filename: file.displayName, contentType: file.contentType, size: file.size });
      if (res.writableFinished) outcome = "completed";
    } catch (error) {
      if (!res.headersSent && !res.destroyed) { outcome = "failed"; throw error; }
      res.destroy();
    } finally {
      stream.destroy();
      await services.files.recordDownloadResult(principal, file.publicId, outcome)
        .catch(() => services.logger.error("Order document download outcome could not be recorded"));
    }
  });

  router.post(documentPath, async (req, res) => {
    const principal = requireFullSession(req);
    const locator = documentParams.safeParse(req.params);
    const query = documentQuery.safeParse(req.query);
    if (!locator.success || !query.success) throw validation("DOCUMENT_REFERENCE_INVALID", "Choose a valid order document.");
    const plan = await services.files.beginEditedVersion(principal, { ...locator.data, ...query.data });
    let candidates: Candidate[] = [];
    try {
      const parsed = await readMultipart(req, services, plan);
      candidates = parsed.candidates;
      const [candidate] = candidates;
      if (parsed.transcript !== undefined || !candidate || req.aborted || res.destroyed) throw multipartInvalid();
      if ("error" in candidate) throw candidate.error;
      const file = await services.files.saveEditedVersion(principal, plan, candidate.staged);
      res.set("Cache-Control", "no-store").json(file);
    } catch (error) {
      if (error instanceof DomainError && error.code !== "AUDIT_UNAVAILABLE") {
        if (error.reasonCode === "UPLOAD_REQUEST_TOO_LARGE" && req.httpVersionMajor === 1) res.set("Connection", "close");
        await services.files.rejectUpload(principal, plan.orderPublicId, error.reasonCode);
      }
      throw error;
    } finally {
      await Promise.all(candidates.flatMap((candidate) => "staged" in candidate ? [services.files.cleanUpload(candidate.staged)] : []));
    }
  });

  router.post("/playback", async (req, res) => {
    const principal = requireFullSession(req);
    const body = downloadBody.safeParse(req.body);
    if (!body.success) {
      await services.files.recordPlaybackAccess(principal, "denied", undefined, "PLAYBACK_NOT_AVAILABLE");
      throw notFound("PLAYBACK_NOT_AVAILABLE");
    }
    const { grantPublicId, secret } = await services.files.redeemPlaybackTicket(principal, body.data.ticket);
    res.cookie(playbackCookie, secret, {
      path: `/api/files/playback/${grantPublicId}`, httpOnly: true, sameSite: "strict",
      secure: services.config.cookieSecure, maxAge: playbackLifetimeMs,
    });
    res.set("Cache-Control", "private, no-store").json({ grantPublicId });
  });

  router.get("/playback/:publicId", async (req, res) => {
    const principal = requireFullSession(req);
    const id = publicId.safeParse(req.params.publicId);
    if (!id.success || req.get("sec-fetch-site") === "cross-site") {
      await services.files.recordPlaybackAccess(principal, "denied", undefined, "PLAYBACK_NOT_AVAILABLE");
      throw notFound("PLAYBACK_NOT_AVAILABLE");
    }
    const secret = readCookie(req, playbackCookie) ?? "";
    const head = req.method === "HEAD";
    // Without a strong validator no If-Range request can match.
    const rangeHeader = head || req.get("if-range") !== undefined ? undefined : req.get("range");
    const { file, range, stream } = await services.files.openPlayback(principal, id.data, secret, rangeHeader, head);
    res.set({
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin", "Accept-Ranges": "bytes", "X-Accel-Buffering": "no",
    });
    if (range === "unsatisfiable") {
      res.status(416).set("Content-Range", `bytes */${file.size}`).end();
      return;
    }
    const size = range ? range.end - range.start + 1 : file.size;
    res.status(range ? 206 : 200).set({ "Content-Type": file.contentType, "Content-Length": String(size) });
    if (range) res.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
    let outcome: "completed" | "failed" | "unknown" = "unknown";
    try {
      if (!stream) {
        res.end();
      } else {
        let bytes = 0;
        await pipeline(stream, new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > size) done(new Error("PLAYBACK_LENGTH_MISMATCH"));
            else done(null, chunk);
          },
          flush(done) { done(bytes === size ? undefined : new Error("PLAYBACK_LENGTH_MISMATCH")); },
        }), res);
      }
      if (res.writableFinished) outcome = "completed";
    } catch {
      if (!req.destroyed || res.headersSent) outcome = "failed";
      res.destroy();
    } finally {
      stream?.destroy();
      await services.files.recordPlaybackAccess(principal, outcome, file)
        .catch(() => services.logger.error("Audio playback outcome could not be recorded"));
    }
  });

  router.post("/download", async (req, res) => {
    let principal;
    try {
      principal = requireFullSession(req);
    } catch (error) {
      if (error instanceof DomainError) await services.files.recordDownloadDenied(getHttpState(req).session, error.reasonCode);
      throw error;
    }
    const body = downloadBody.safeParse(req.body);
    if (!body.success) {
      await services.files.recordDownloadDenied(principal, "DOWNLOAD_TICKET_INVALID");
      throw validation("DOWNLOAD_TICKET_INVALID", "The download request is invalid.");
    }
    const { file, stream } = await services.files.redeemDownloadTicket(principal, body.data.ticket);
    let outcome: "completed" | "failed" | "unknown" = "unknown";
    try {
      await sendPrivateDownload(res, { stream, filename: file.displayName, contentType: file.contentType, size: file.size });
      if (res.writableFinished) outcome = "completed";
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        outcome = "failed";
        throw error;
      }
      res.destroy();
    } finally {
      stream.destroy();
      // A result audit cannot retroactively recall bytes written. The durable pre-send attempted row
      // remains true because we deliberately do not call it completed until the stream finishes.
      await services.files.recordDownloadResult(principal, file.publicId, outcome)
        .catch(() => services.logger.error("Private download outcome could not be recorded"));
    }
  });
}
