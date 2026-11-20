import { describe, expect, it } from "vitest";
import { connectionOptionsFromUrl, DatabaseUrlError } from "../server/db/connectionOptions.js";

describe("database URL handling", () => {
  it("maps only allow-listed components and pins safe driver behaviour", () => {
    const o = connectionOptionsFromUrl("mysql://app:p%40ss@db.internal:3307/portal");
    expect(o).toMatchObject({ host: "db.internal", port: 3307, user: "app", password: "p@ss", database: "portal", multipleStatements: false, debug: false, insecureAuth: false });
    expect(o).not.toHaveProperty("uri");
    expect(o.ssl).toBeUndefined();
  });

  it("requires certificate verification when TLS is requested", () => {
    const o = connectionOptionsFromUrl("mysql://app:x@db/portal?tls=required");
    expect(o.ssl).toMatchObject({ rejectUnauthorized: true, verifyIdentity: true, minVersion: "TLSv1.2" });
  });

  it.each([
    "mysql://app:x@db/portal?multipleStatements=true",
    "mysql://app:x@db/portal?debug=true",
    "mysql://app:x@db/portal?ssl=%7B%22rejectUnauthorized%22%3Afalse%7D",
    "mysql://app:x@db/portal?insecureAuth=true",
    "mysql://app:x@db/portal?tls=preferred",
    "mysql://app:x@db/portal?tlsCaFile=/etc/ca.pem",
    "postgres://app:x@db/portal",
    "mysql://app:x@db/",
    "not a url",
  ])("refuses %s without echoing it", (url) => {
    let caught: unknown;
    try {
      connectionOptionsFromUrl(url);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseUrlError);
    expect((caught as Error).message).not.toContain("app:x");
    expect((caught as Error).message).not.toContain("db/portal");
  });
});
