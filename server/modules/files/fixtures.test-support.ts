const tag = (value: string) => Buffer.from(value, "latin1");

function element(id: string, contents: Buffer): Buffer {
  if (contents.length >= 127) throw new Error("Fixture element is too long");
  return Buffer.concat([Buffer.from(id, "hex"), Buffer.from([contents.length | 0x80]), contents]);
}

export function exampleWebm(kind: "audio" | "video", streaming = false): Buffer {
  const header = element("1a45dfa3", element("4282", tag("webm")));
  const track = element("ae", Buffer.concat([
    element("83", Buffer.from([kind === "audio" ? 2 : 1])),
    element("86", tag(kind === "audio" ? "A_OPUS" : "V_VP9")),
  ]));
  const cluster = element("1f43b675", element("a3", Buffer.from([0x81, 0x00, 0x00, 0x80, 0x01, 0x02])));
  const tracks = element("1654ae6b", track);
  const segmentBody = Buffer.concat([tracks, cluster]);
  const segment = streaming
    ? Buffer.concat([Buffer.from("1853806701ffffffffffffff", "hex"), segmentBody])
    : element("18538067", segmentBody);
  return Buffer.concat([header, segment]);
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const data = Buffer.concat(parts);
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(data.length + 8);
  prefix.write(type, 4, "ascii");
  return Buffer.concat([prefix, data]);
}

export function exampleMp4(kind: "video" | "audio" | "both", brand?: string): Buffer {
  const track = (media: "soun" | "vide") => box("trak", box("mdia", box("hdlr", Buffer.alloc(8), tag(media))));
  return Buffer.concat([
    box("ftyp", tag(brand ?? (kind === "audio" ? "M4A " : "isom")), Buffer.alloc(4), tag("isom")),
    box("moov", ...(kind === "both" ? [track("soun"), track("vide")] : [track(kind === "video" ? "vide" : "soun")])),
    box("mdat", Buffer.from([1, 2, 3, 4])),
  ]);
}

export function exampleOgg(kind: "video" | "audio", addLast = true): Buffer {
  const page = (flags: number, index: number, packet: Buffer) => {
    const header = Buffer.alloc(28);
    header.write("OggS");
    header[5] = flags;
    header.writeUInt32LE(123, 14);
    header.writeUInt32LE(index, 18);
    header[26] = 1;
    header[27] = packet.length;
    return Buffer.concat([header, packet]);
  };
  const opener = page(2, 0, tag(kind === "audio" ? "OpusHead synthetic" : "\x80theora synthetic"));
  return addLast ? Buffer.concat([opener, page(4, 1, Buffer.from([1, 2]))]) : opener;
}

export function exampleWav(samples = 1): Buffer {
  const riff = Buffer.alloc(44 + samples * 2);
  riff.write("RIFF");
  riff.writeUInt32LE(riff.length - 8, 4);
  riff.write("WAVEfmt ", 8);
  riff.writeUInt32LE(16, 16);
  riff.writeUInt16LE(1, 20); // PCM, mono
  riff.writeUInt16LE(1, 22);
  riff.writeUInt32LE(8000, 24);
  riff.writeUInt32LE(16000, 28);
  riff.writeUInt16LE(2, 32);
  riff.writeUInt16LE(16, 34);
  riff.write("data", 36);
  riff.writeUInt32LE(samples * 2, 40);
  return riff;
}

export function examplePdf(extra = ""): Buffer {
  const document = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${extra} >>\nendobj\n`;
  return tag(`${document}xref\n0 2\n0000000000 65535 f\n0000000009 00000 n\ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n${document.length}\n%%EOF\n`);
}
