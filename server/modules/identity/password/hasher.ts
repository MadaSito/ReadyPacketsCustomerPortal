/**
 * Argon2id hashing with transparent rehash. Production parameters follow the source baseline and exceed the
 * OWASP Password Storage Cheat Sheet minimum (m=19 MiB, t=2, p=1): m=64 MiB, t=3, p=1. The `test` deployment
 * profile ONLY uses reduced cost so the shared CI box stays fast; production/development/preview never do.
 */
import argon2 from "argon2";
import type { DeploymentProfile } from "../../../config/env.js";

export interface Argon2Params {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

export const PRODUCTION_ARGON2: Argon2Params = { memoryCost: 65536, timeCost: 3, parallelism: 1 };
const TEST_ARGON2: Argon2Params = { memoryCost: 8192, timeCost: 1, parallelism: 1 };

export function argon2ParamsFor(profile: DeploymentProfile): Argon2Params {
  return profile === "test" ? TEST_ARGON2 : PRODUCTION_ARGON2;
}

export interface PasswordHasher {
  readonly params: Argon2Params;
  hash(password: string): Promise<string>;
  /** Always performs one Argon2 verification, even when `hash` is null (dummy hash), for uniform timing. */
  verify(hash: string | null, password: string): Promise<boolean>;
  needsRehash(hash: string): boolean;
}

export function createPasswordHasher(params: Argon2Params): PasswordHasher {
  let dummy: Promise<string> | undefined;
  const options = { type: argon2.argon2id, ...params } as const;
  const prepare = (password: string) => password.normalize("NFC");
  return {
    params,
    hash: (password) => argon2.hash(prepare(password), options),
    async verify(hash, password) {
      if (hash === null || !hash.startsWith("$argon2")) {
        dummy ??= argon2.hash("rp-dummy-password-for-uniform-timing", options);
        await argon2.verify(await dummy, prepare(password)).catch(() => false);
        return false;
      }
      try {
        return await argon2.verify(hash, prepare(password));
      } catch {
        return false;
      }
    },
    needsRehash(hash) {
      try {
        return argon2.needsRehash(hash, options);
      } catch {
        return true;
      }
    },
  };
}
