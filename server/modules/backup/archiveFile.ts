/**
 * Opening an operator-supplied archive path without a check-then-use gap.
 *
 * The path is opened first (never following a final symlink) and the opened descriptor is inspected
 * afterwards, so the file that was checked is the file that is read even if the path is swapped in between.
 */
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { validation } from "../../core/errors.js";

const REFUSED_OPEN_CODES = new Set(["ENOENT", "ELOOP", "ENOTDIR", "ENXIO", "EISDIR"]);

export async function openRegularFileNoFollow(filePath: string, refusalMessage: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    // O_NONBLOCK: opening a FIFO must not wait for a writer; it has no effect on regular files.
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (REFUSED_OPEN_CODES.has(String((error as NodeJS.ErrnoException).code))) {
      throw validation("INVALID_ARCHIVE_PATH", refusalMessage);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw validation("INVALID_ARCHIVE_PATH", refusalMessage);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
