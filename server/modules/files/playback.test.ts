import { describe, expect, it } from "vitest";
import { parseAudioRange } from "./playback.js";

describe("audio byte ranges", () => {
  it("supports inclusive, open-ended and suffix ranges without reading other bytes", () => {
    expect(parseAudioRange(undefined, 100)).toBeNull();
    expect(parseAudioRange("bytes=2-4", 100)).toEqual({ start: 2, end: 4 });
    expect(parseAudioRange("Bytes=2-4", 100)).toEqual({ start: 2, end: 4 });
    expect(parseAudioRange("bytes=99-", 100)).toEqual({ start: 99, end: 99 });
    expect(parseAudioRange("bytes=-3", 100)).toEqual({ start: 97, end: 99 });
    expect(parseAudioRange("bytes=-1000", 100)).toEqual({ start: 0, end: 99 });
    expect(parseAudioRange("bytes=0-1000", 100)).toEqual({ start: 0, end: 99 });
  });

  it.each(["bytes=100-", "bytes=8-7", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "items=0-1",
    "bytes=9007199254740993-", "bytes=0-999999999999999999999999999999999999999999999999"])("rejects %s", (header) => {
    expect(parseAudioRange(header, 100)).toBe("unsatisfiable");
  });
});
