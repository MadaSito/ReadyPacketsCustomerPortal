const tag = (value: string) => Buffer.from(value, "latin1");

function element(id: string, contents: Buffer): Buffer {
  if (contents.length >= 127) throw new Error("Fixture element is too long");
  return Buffer.concat([Buffer.from(id, "hex"), Buffer.from([contents.length | 0x80]), contents]);
}

export function exampleWebm(kind: "audio" | "video", streaming: boolean | "unknown_clusters" = false): Buffer {
  const header = element("1a45dfa3", element("4282", tag("webm")));
  const track = element("ae", Buffer.concat([
    element("83", Buffer.from([kind === "audio" ? 2 : 1])),
    element("86", tag(kind === "audio" ? "A_OPUS" : "V_VP9")),
  ]));
  const cluster = element("1f43b675", element("a3", Buffer.from([0x81, 0x00, 0x00, 0x80, 0x01, 0x02])));
  const tracks = element("1654ae6b", track);
  const unknown = Buffer.concat([Buffer.from("1f43b675ff", "hex"), cluster.subarray(5)]);
  const segmentBody = streaming === "unknown_clusters" ? Buffer.concat([tracks, unknown, unknown]) : Buffer.concat([tracks, cluster]);
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

export function exampleDocx(text = "Synthetic text", extraEntry?: string): Buffer {
  const entries = [
    ["[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"],
    ["_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"],
    ["word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`],
    ...(extraEntry ? [[extraEntry, "synthetic"]] : []),
  ] as const;
  const local: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name!);
    const content = Buffer.from(value!);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(content.length, 18);
    head.writeUInt32LE(content.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    head.copy(central, 6, 4, 28);
    central.writeUInt32LE(offset, 42);
    local.push(head, nameBytes, content);
    directory.push(central, nameBytes);
    offset += head.length + nameBytes.length + content.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralDirectory, end]);
}
