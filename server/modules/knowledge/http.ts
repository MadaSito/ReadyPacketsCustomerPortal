/**
 * Knowledge Base raw-HTTP routes (mounted at `/api/knowledge`).
 * - `POST /attachments/:articlePublicId` — multipart upload via `files` classification + AV pipeline
 * - `POST /attachments/download` — single-use 60s ticket redemption via `sendPrivateDownload`
 */
import busboy from "busboy";
import type { Request, Router } from "express";
import { Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { z } from "zod";
import type { Services } from "../../container.js";
import { DomainError, validation } from "../../core/errors.js";
import { ULID_PATTERN } from "../../core/ids.js";
import { sendPrivateDownload } from "../../http/downloads.js";
import { requireFullSession } from "../../http/requestState.js";
import type { StagedUpload } from "../files/index.js";
import type { KnowledgeAttachmentUploadAuth, KnowledgeModule } from "./service.js";

const downloadBodySchema = z.strictObject({
  ticket: z.string().length(43).regex(/^[a-zA-Z0-9_-]{43}$/),
});

const multipartInvalid = () =>
  validation("INVALID_MULTIPART", "Send one or more files using the multipart 'files' field.");
const requestTooLarge = () =>
  validation("UPLOAD_REQUEST_TOO_LARGE", "The upload request exceeds the allowed size.");
const countExceeded = () =>
  validation("TOO_MANY_FILES", "This upload contains too many files.");
const fileTooLarge = () =>
  validation("FILE_TOO_LARGE", "The file exceeds the allowed size.");

type Candidate = { staged: StagedUpload } | { error: unknown };

function getKnowledgeService(services: Services): KnowledgeModule {
  const kb = (services as unknown as { knowledge?: KnowledgeModule }).knowledge;
  if (!kb) {
    throw new DomainError(
      "UNAVAILABLE",
      "KNOWLEDGE_UNAVAILABLE",
      "Knowledge base service is not mounted.",
    );
  }
  return kb;
}

async function parseKnowledgeMultipart(
  req: Request,
  services: Services,
  plan: KnowledgeAttachmentUploadAuth,
): Promise<Candidate[]> {
  const type = req.get("content-type");
  if (!type || !/^multipart\/form-data(?:;|$)/iu.test(type)) throw multipartInvalid();

  const length = req.get("content-length");
  if (length && (!/^\d{1,15}$/u.test(length) || Number(length) > plan.rules.maxRequestBytes)) {
    throw requestTooLarge();
  }

  let parser: ReturnType<typeof busboy>;
  try {
    parser = busboy({
      headers: req.headers,
      preservePath: false,
      defParamCharset: "utf8",
      limits: {
        files: plan.rules.maxFiles,
        fields: 0,
        parts: plan.rules.maxFiles + 1,
        fileSize: plan.rules.maxFileBytes + 1,
        headerPairs: 32,
      },
    });
  } catch {
    throw multipartInvalid();
  }

  const files: Promise<Candidate>[] = [];
  const active = new Set<Readable>();
  let envelopeError: DomainError | undefined;
  let total = 0;

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
    if (!req.destroyed) req.resume();
    for (const stream of active) stream.destroy(error);
    meter.destroy();
    if (!parser.destroyed) parser.destroy(error);
  };

  const aborted = () => fail(validation("UPLOAD_INTERRUPTED", "The upload did not finish."));
  req.once("aborted", aborted);
  req.once("error", aborted);
  meter.on("error", (err: unknown) => fail(err instanceof DomainError ? err : multipartInvalid()));
  parser.on("error", (err: unknown) => fail(err instanceof DomainError ? err : multipartInvalid()));
  parser.once("filesLimit", () => fail(countExceeded()));
  parser.once("fieldsLimit", () => fail(multipartInvalid()));
  parser.once("partsLimit", () => fail(countExceeded()));

  parser.on("file", (name, stream, info) => {
    if (envelopeError) {
      stream.on("error", () => {});
      stream.resume();
      return;
    }
    active.add(stream);
    stream.on("error", () => {});
    const candidate = (async (): Promise<Candidate> => {
      try {
        if (
          name !== "files" ||
          !info.filename ||
          !["7bit", "8bit", "binary"].includes(info.encoding.toLowerCase())
        ) {
          fail(multipartInvalid());
          return { error: multipartInvalid() };
        }
        const input = Readable.from(stream.iterator({ destroyOnReturn: false }), {
          objectMode: false,
        });
        const staged = await services.files.stageUpload(info.filename, input, plan.rules);
        if (stream.truncated) {
          await services.files.cleanUpload(staged);
          return { error: fileTooLarge() };
        }
        return { staged };
      } catch (err) {
        if (!stream.destroyed) stream.resume();
        return { error: stream.truncated ? fileTooLarge() : err };
      } finally {
        active.delete(stream);
      }
    })();
    files.push(candidate);
  });

  try {
    const fullyParsed = finished(parser, { cleanup: true });
    req.pipe(meter).pipe(parser);
    await fullyParsed.catch(() => {
      envelopeError ??= multipartInvalid();
    });
    const candidates = await Promise.all(files);
    if (envelopeError || candidates.length === 0) {
      await Promise.all(
        candidates.flatMap((c) => ("staged" in c ? [services.files.cleanUpload(c.staged)] : [])),
      );
      throw envelopeError ?? multipartInvalid();
    }
    return candidates;
  } finally {
    req.off("aborted", aborted);
    req.off("error", aborted);
  }
}

export function registerKnowledgeHttpRoutes(router: Router, services: Services): void {
  router.post("/attachments/download", async (req, res) => {
    const principal = requireFullSession(req);
    const parsed = downloadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw validation("DOWNLOAD_TICKET_INVALID", "The download request is invalid.");
    }
    const kb = getKnowledgeService(services);
    const { attachment, stream } = await kb.redeemAttachmentDownloadTicket(
      principal,
      parsed.data.ticket,
    );
    try {
      await sendPrivateDownload(res, {
        stream,
        filename: attachment.displayName,
        contentType: attachment.contentType,
        size: attachment.size,
      });
    } catch (err) {
      if (!res.headersSent && !res.destroyed) throw err;
      res.destroy();
    } finally {
      stream.destroy();
    }
  });

  router.post("/attachments/:articlePublicId", async (req, res) => {
    const principal = requireFullSession(req);
    const articlePublicId = req.params.articlePublicId;
    if (!articlePublicId || articlePublicId.length !== 26 || !ULID_PATTERN.test(articlePublicId)) {
      throw multipartInvalid();
    }
    const kb = getKnowledgeService(services);
    const plan = await kb.beginAttachmentUpload(principal, articlePublicId);
    const candidates = await parseKnowledgeMultipart(req, services, plan);

    try {
      const results = [];
      for (const [index, candidate] of candidates.entries()) {
        try {
          if ("error" in candidate) throw candidate.error;
          if (req.aborted || res.destroyed) {
            throw validation("UPLOAD_INTERRUPTED", "The upload did not finish.");
          }
          const attachment = await kb.commitAttachmentUpload(principal, plan, candidate.staged);
          results.push({ index, outcome: "completed" as const, attachment });
        } catch (err) {
          if (err instanceof DomainError && err.code === "AUDIT_UNAVAILABLE") throw err;
          if (err instanceof DomainError) {
            results.push({
              index,
              outcome: "refused" as const,
              reason: err.reasonCode,
              message: err.safeMessage,
            });
          } else {
            results.push({
              index,
              outcome: "unknown" as const,
              reason: "ATTACHMENT_UPLOAD_FAILED",
              message: "The attachment could not be confirmed. Reload the article before retrying.",
            });
          }
        }
      }
      res.set("Cache-Control", "no-store").json({ results });
    } finally {
      await Promise.all(
        candidates.flatMap((c) => ("staged" in c ? [services.files.cleanUpload(c.staged)] : [])),
      );
    }
  });
}
