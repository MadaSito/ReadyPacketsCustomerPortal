import crypto from "node:crypto";
import net from "node:net";

/**
 * Minimal pure-TypeScript ASN.1 DER X.509 v3 certificate generator using `node:crypto` (EC P-256).
 * Generates real X.509v3 Root CAs, TLS server leaf certificates (with DNS + IP SANs), and mTLS client
 * certificates in <5ms in-memory with zero external `openssl` CLI subprocesses.
 */

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let rem = len;
  while (rem > 0) {
    bytes.unshift(rem & 0xff);
    rem >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function seq(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}

function set(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items));
}

function ctxExplicit(tagNum: number, inner: Buffer): Buffer {
  return tlv(0xa0 | tagNum, inner);
}

function derInteger(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && (bytes[start + 1]! & 0x80) === 0) {
    start += 1;
  }
  const sliced = bytes.subarray(start);
  const body = (sliced[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0x00]), sliced]) : sliced;
  return tlv(0x02, body);
}

function derIntNumber(n: number): Buffer {
  if (n === 0) return tlv(0x02, Buffer.from([0x00]));
  const bytes: number[] = [];
  let rem = n;
  while (rem > 0) {
    bytes.unshift(rem & 0xff);
    rem >>= 8;
  }
  return derInteger(Buffer.from(bytes));
}

function derBoolean(val: boolean): Buffer {
  return tlv(0x01, Buffer.from([val ? 0xff : 0x00]));
}

function derOctetString(buf: Buffer): Buffer {
  return tlv(0x04, buf);
}

function derBitString(buf: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), buf]));
}

function derUtf8String(str: string): Buffer {
  return tlv(0x0c, Buffer.from(str, "utf8"));
}

function derOid(dotOid: string): Buffer {
  const parts = dotOid.split(".").map((p) => Number(p));
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i += 1) {
    let val = parts[i]!;
    const sub: number[] = [val & 0x7f];
    val = Math.floor(val / 128);
    while (val > 0) {
      sub.unshift((val & 0x7f) | 0x80);
      val = Math.floor(val / 128);
    }
    out.push(...sub);
  }
  return tlv(0x06, Buffer.from(out));
}

function derTime(date: Date): Buffer {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const year = Number(iso.slice(0, 4));
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  const hh = iso.slice(11, 13);
  const mm = iso.slice(14, 16);
  const ss = iso.slice(17, 19);
  if (year >= 1950 && year <= 2049) {
    const yy = String(year % 100).padStart(2, "0");
    return tlv(0x17, Buffer.from(`${yy}${month}${day}${hh}${mm}${ss}Z`, "ascii"));
  }
  return tlv(0x18, Buffer.from(`${iso.slice(0, 4)}${month}${day}${hh}${mm}${ss}Z`, "ascii"));
}

function buildDistinguishedName(commonName: string): Buffer {
  // CN = 2.5.4.3, O = 2.5.4.10
  return seq(
    set(seq(derOid("2.5.4.10"), derUtf8String("ReadyPackets Test PKI"))),
    set(seq(derOid("2.5.4.3"), derUtf8String(commonName))),
  );
}

function buildExtension(oid: string, critical: boolean, extnValue: Buffer): Buffer {
  return critical
    ? seq(derOid(oid), derBoolean(true), derOctetString(extnValue))
    : seq(derOid(oid), derOctetString(extnValue));
}

function ipToOctets(ip: string): Buffer {
  const fam = net.isIP(ip);
  if (fam === 4) {
    return Buffer.from(ip.split(".").map((n) => Number(n)));
  }
  if (fam === 6) {
    // Expand IPv6 into 8 16-bit groups
    const [head, tail] = ip.split("::");
    const headParts = head ? head.split(":").filter(Boolean) : [];
    const tailParts = tail !== undefined ? tail.split(":").filter(Boolean) : [];
    const missing = tail !== undefined ? 8 - (headParts.length + tailParts.length) : 0;
    const full = [...headParts, ...Array<string>(missing).fill("0"), ...tailParts];
    const buf = Buffer.alloc(16);
    full.forEach((hex, idx) => {
      buf.writeUInt16BE(parseInt(hex, 16), idx * 2);
    });
    return buf;
  }
  throw new Error(`Invalid IP SAN: ${ip}`);
}

function toPem(label: string, der: Buffer): string {
  const b64 = der.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// ecdsa-with-SHA256 = 1.2.840.10045.4.3.2
const ALG_ECDSA_SHA256 = seq(derOid("1.2.840.10045.4.3.2"));

export interface GeneratedCert {
  certPem: string;
  keyPem: string;
  keyObject: crypto.KeyObject;
  subjectDer: Buffer;
}

export interface TestPkiBundle {
  ca: GeneratedCert;
  issueServerCert: (opts: {
    commonName: string;
    dnsNames?: string[];
    ipAddresses?: string[];
    notBefore?: Date;
    notAfter?: Date;
  }) => GeneratedCert;
  issueClientCert: (opts: {
    commonName: string;
    notBefore?: Date;
    notAfter?: Date;
  }) => GeneratedCert;
}

function signCertificate(params: {
  subjectCn: string;
  subjectSpkiDer: Buffer;
  issuerSubjectDer: Buffer;
  issuerKey: crypto.KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Buffer[];
}): { certPem: string; subjectDer: Buffer } {
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const subjectDer = buildDistinguishedName(params.subjectCn);

  const tbs = seq(
    ctxExplicit(0, derIntNumber(2)), // v3 = 2
    derInteger(serial),
    ALG_ECDSA_SHA256,
    params.issuerSubjectDer,
    seq(derTime(params.notBefore), derTime(params.notAfter)),
    subjectDer,
    params.subjectSpkiDer,
    ctxExplicit(3, seq(...params.extensions)),
  );

  const signature = crypto.sign("sha256", tbs, params.issuerKey);
  const certDer = seq(tbs, ALG_ECDSA_SHA256, derBitString(signature, 0));
  return { certPem: toPem("CERTIFICATE", certDer), subjectDer };
}

export function createTestPki(options?: { caCommonName?: string; notBefore?: Date; notAfter?: Date }): TestPkiBundle {
  const defaultNotBefore = options?.notBefore ?? new Date("2025-01-01T00:00:00.000Z");
  const defaultNotAfter = options?.notAfter ?? new Date("2035-01-01T00:00:00.000Z");

  const caKeys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caSpkiDer = caKeys.publicKey.export({ type: "spki", format: "der" });
  const caKeyPem = caKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const caSubjectDer = buildDistinguishedName(options?.caCommonName ?? "ReadyPackets Test Root CA");

  // BasicConstraints (2.5.29.19): CA=TRUE
  const extBasicCa = buildExtension("2.5.29.19", true, seq(derBoolean(true)));
  // KeyUsage (2.5.29.15): keyCertSign (bit 5) | cRLSign (bit 6) => 0x06 with 1 unused bit
  const extKeyUsageCa = buildExtension("2.5.29.15", true, derBitString(Buffer.from([0x06]), 1));
  const skiHash = crypto.createHash("sha1").update(caSpkiDer).digest();
  // SubjectKeyIdentifier (2.5.29.14)
  const extSkiCa = buildExtension("2.5.29.14", false, derOctetString(skiHash));

  const signedCa = signCertificate({
    subjectCn: options?.caCommonName ?? "ReadyPackets Test Root CA",
    subjectSpkiDer: caSpkiDer,
    issuerSubjectDer: caSubjectDer,
    issuerKey: caKeys.privateKey,
    notBefore: defaultNotBefore,
    notAfter: defaultNotAfter,
    extensions: [extBasicCa, extKeyUsageCa, extSkiCa],
  });

  const ca: GeneratedCert = {
    certPem: signedCa.certPem,
    keyPem: caKeyPem,
    keyObject: caKeys.privateKey,
    subjectDer: signedCa.subjectDer,
  };

  return {
    ca,

    issueServerCert(opts) {
      const keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const spkiDer = keys.publicKey.export({ type: "spki", format: "der" });
      const keyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

      const sanEntries: Buffer[] = [];
      for (const dnsName of opts.dnsNames ?? []) {
        sanEntries.push(tlv(0x82, Buffer.from(dnsName, "ascii"))); // dNSName [2] IMPLICIT IA5String
      }
      for (const ip of opts.ipAddresses ?? []) {
        sanEntries.push(tlv(0x87, ipToOctets(ip))); // iPAddress [7] IMPLICIT OCTET STRING
      }

      const exts: Buffer[] = [
        buildExtension("2.5.29.19", true, seq()), // BasicConstraints CA=FALSE
        // KeyUsage: digitalSignature (bit 0) => 0x80 with 7 unused bits
        buildExtension("2.5.29.15", true, derBitString(Buffer.from([0x80]), 7)),
        // ExtendedKeyUsage (2.5.29.37): serverAuth (1.3.6.1.5.5.7.3.1)
        buildExtension("2.5.29.37", false, seq(derOid("1.3.6.1.5.5.7.3.1"))),
        // AuthorityKeyIdentifier (2.5.29.35): keyIdentifier [0] IMPLICIT
        buildExtension("2.5.29.35", false, seq(tlv(0x80, skiHash))),
      ];
      if (sanEntries.length > 0) {
        exts.push(buildExtension("2.5.29.17", false, seq(...sanEntries)));
      }

      const signed = signCertificate({
        subjectCn: opts.commonName,
        subjectSpkiDer: spkiDer,
        issuerSubjectDer: ca.subjectDer,
        issuerKey: ca.keyObject,
        notBefore: opts.notBefore ?? defaultNotBefore,
        notAfter: opts.notAfter ?? defaultNotAfter,
        extensions: exts,
      });

      return {
        certPem: signed.certPem,
        keyPem,
        keyObject: keys.privateKey,
        subjectDer: signed.subjectDer,
      };
    },

    issueClientCert(opts) {
      const keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const spkiDer = keys.publicKey.export({ type: "spki", format: "der" });
      const keyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

      const exts: Buffer[] = [
        buildExtension("2.5.29.19", true, seq()),
        buildExtension("2.5.29.15", true, derBitString(Buffer.from([0x80]), 7)),
        // ExtendedKeyUsage: clientAuth (1.3.6.1.5.5.7.3.2)
        buildExtension("2.5.29.37", false, seq(derOid("1.3.6.1.5.5.7.3.2"))),
        buildExtension("2.5.29.35", false, seq(tlv(0x80, skiHash))),
      ];

      const signed = signCertificate({
        subjectCn: opts.commonName,
        subjectSpkiDer: spkiDer,
        issuerSubjectDer: ca.subjectDer,
        issuerKey: ca.keyObject,
        notBefore: opts.notBefore ?? defaultNotBefore,
        notAfter: opts.notAfter ?? defaultNotAfter,
        extensions: exts,
      });

      return {
        certPem: signed.certPem,
        keyPem,
        keyObject: keys.privateKey,
        subjectDer: signed.subjectDer,
      };
    },
  };
}
