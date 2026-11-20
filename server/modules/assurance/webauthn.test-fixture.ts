import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

/** Small in-process synthetic P-256 authenticator for server ceremony tests; no stored credential. */
export function syntheticAuthenticator(origin: string) {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const coseKey = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"), Buffer.from(jwk.x!, "base64url"),
    Buffer.from("225820", "hex"), Buffer.from(jwk.y!, "base64url"),
  ]);
  const credential = randomBytes(32);
  const credentialId = credential.toString("base64url");
  const envelope = { id: credentialId, rawId: credentialId, type: "public-key" as const, clientExtensionResults: {} };
  const rpHash = createHash("sha256").update(new URL(origin).hostname).digest();

  function authData(flags: number, counter: number) {
    const head = Buffer.alloc(37);
    rpHash.copy(head);
    head[32] = flags;
    head.writeUInt32BE(counter, 33);
    return head;
  }
  function clientData(type: string, challenge: string, assertedOrigin: string) {
    return Buffer.from(JSON.stringify({ type, origin: assertedOrigin, challenge, crossOrigin: false }));
  }
  return {
    registration(challenge: string) {
      const credLength = Buffer.alloc(2);
      credLength.writeUInt16BE(credential.length);
      const data = Buffer.concat([authData(0x45, 0), Buffer.alloc(16), credLength, credential, coseKey]);
      const authLength = Buffer.alloc(2);
      authLength.writeUInt16BE(data.length);
      // CBOR map: { fmt: "none", attStmt: {}, authData: bytes }. Only the bytes length is variable.
      const cborPrefix = Buffer.from("a363666d74646e6f6e656761747453746d74a068617574684461746159", "hex");
      return {
        ...envelope,
        response: {
          clientDataJSON: clientData("webauthn.create", challenge, origin).toString("base64url"),
          attestationObject: Buffer.concat([cborPrefix, authLength, data]).toString("base64url"),
        },
      };
    },
    authentication(challenge: string, counter: number, assertedOrigin = origin): AuthenticationResponseJSON {
      const client = clientData("webauthn.get", challenge, assertedOrigin);
      const auth = authData(0x05, counter);
      const signature = sign("sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), pair.privateKey);
      return {
        ...envelope,
        response: {
          authenticatorData: auth.toString("base64url"), signature: signature.toString("base64url"),
          clientDataJSON: client.toString("base64url"),
        },
      };
    },
  };
}
