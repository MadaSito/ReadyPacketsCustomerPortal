# Portable fixtures (synthetic only)

`golden-v3.rpkg` — a contract-v3 package containing one or more synthetic records of every record type and
one object. All data is invented (`*.example.test`). It is produced deterministically by
`portable/scripts/make-golden.ts` (seeded randomness, fixed clock, **test** KDF parameters N=2^14 which are
below the production default of N=2^17 — never use these parameters for real packages).

- Passphrase: `correct horse battery staple 2026` (public test value)
- `portable/tests/golden.test.ts` re-builds the package and requires byte-identical output, then verifies it.

Third parties can check it with:

    printf '%s' 'correct horse battery staple 2026' > pass.txt
    tsx portable/cli/verify.ts verify portable/fixtures/golden-v3.rpkg --passphrase-file pass.txt

Legacy v1/v2 fixtures are synthesized inside `portable/tests/legacy.test.ts` from the reference source
algorithm; they were **not** produced by the legacy system itself.
