/**
 * Local protocol fake of the Microsoft Graph endpoints used by the drive adapter and the SharePoint order
 * sync (sites, drives, drive items, upload sessions, lists, list items). TEST ONLY: it models the documented
 * request/response shapes, not the real service; nothing here has touched a real tenant.
 */
import { randomUUID } from "node:crypto";
import type { GraphCredentials, GraphHttpPort, GraphRequest, GraphResponse } from "./graphDrivePort.js";
import { GraphTransportError } from "./graphDrivePort.js";
import { QuickXorHash } from "./graphDriveQuickXor.js";

interface FakeItem {
  id: string;
  name: string;
  parentId: string | null;
  folder: boolean;
  content?: Buffer;
}

interface FakeDrive {
  id: string;
  name: string;
  driveType: "documentLibrary" | "business";
  webUrl: string;
  items: Map<string, FakeItem>;
  rootId: string;
}

export interface FakeListColumn {
  name: string;
  type: "text" | "number" | "dateTime" | "hyperlinkOrPicture";
  /** Graph `enforceUniqueValues` (requires `indexed`). */
  unique?: boolean;
}

interface FakeList {
  id: string;
  displayName: string;
  columns: FakeListColumn[];
  items: Map<string, { id: string; fields: Record<string, unknown> }>;
}

interface FakeSite {
  id: string;
  hostname: string;
  path: string;
  displayName: string;
  webUrl: string;
  drives: string[];
  lists: Map<string, FakeList>;
}

interface UploadSession {
  driveId: string;
  parentId: string;
  name: string;
  size: number;
  received: Buffer[];
  next: number;
}

export interface FakeCall {
  method: string;
  path: string;
  kind: "graph" | "upload";
  authorized: boolean;
}

type Interceptor = (req: { method: string; path: string; kind: "graph" | "upload" }) => GraphResponse | "throw" | undefined;

const ok = (status: number, body: unknown = null, headers: Record<string, string> = {}): GraphResponse => ({ status, headers, body });
const err = (status: number, code = "error") => ok(status, { error: { code, message: "fake provider message (must never be surfaced)" } });

export class FakeGraph implements GraphHttpPort {
  readonly calls: FakeCall[] = [];
  readonly sites = new Map<string, FakeSite>();
  readonly drives = new Map<string, FakeDrive>();
  readonly users = new Map<string, string>();
  readonly sessions = new Map<string, UploadSession>();
  private interceptors: Interceptor[] = [];
  /** Host used for upload-session URLs; tests may set a hostile one. */
  uploadHost = "contoso.sharepoint.com";
  /** When false, responses to uploads omit file hashes (forcing a follow-up GET). */
  reportHashes = true;
  /** Corrupt the stored content (integrity mismatch simulation). */
  corruptUploads = false;
  validSecret = "fake-secret-value";
  /** Mirrors a transport without raw-bytes requests (the published GraphClient today). */
  supportsRawBody = true;

  constructor() {
    const drive = this.addDrive("Documents", "documentLibrary", "https://contoso.sharepoint.com/sites/Orders/Shared%20Documents");
    const site: FakeSite = {
      id: "contoso.sharepoint.com,11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222",
      hostname: "contoso.sharepoint.com",
      path: "sites/Orders",
      displayName: "Orders",
      webUrl: "https://contoso.sharepoint.com/sites/Orders",
      drives: [drive.id],
      lists: new Map(),
    };
    this.sites.set(site.id, site);
    const personal = this.addDrive("OneDrive", "business", "https://contoso-my.sharepoint.com/personal/ops_contoso_example_test/Documents");
    this.users.set("ops@contoso.example.test", personal.id);
  }

  get site(): FakeSite {
    return [...this.sites.values()][0]!;
  }
  get libraryDrive(): FakeDrive {
    return this.drives.get(this.site.drives[0]!)!;
  }

  addDrive(name: string, driveType: FakeDrive["driveType"], webUrl: string): FakeDrive {
    const rootId = `root-${randomUUID().slice(0, 8)}`;
    const drive: FakeDrive = { id: `b!${randomUUID().replace(/-/g, "")}`, name, driveType, webUrl, items: new Map(), rootId };
    drive.items.set(rootId, { id: rootId, name: "root", parentId: null, folder: true });
    this.drives.set(drive.id, drive);
    return drive;
  }

  intercept(fn: Interceptor): void {
    this.interceptors.push(fn);
  }
  clearInterceptors(): void {
    this.interceptors = [];
  }

  /** Path → item in a drive (segments decoded). */
  findByPath(drive: FakeDrive, segments: string[]): FakeItem | null {
    let current = drive.items.get(drive.rootId)!;
    for (const seg of segments) {
      const next = [...drive.items.values()].find((i) => i.parentId === current.id && i.name.toLowerCase() === seg.toLowerCase());
      if (!next) return null;
      current = next;
    }
    return current;
  }

  private itemJson(item: FakeItem, withHashes = true) {
    const base: Record<string, unknown> = { id: item.id, name: item.name, size: item.content?.length ?? 0 };
    if (item.folder) base.folder = { childCount: 0 };
    else base.file = withHashes ? { hashes: { quickXorHash: new QuickXorHash().update(item.content ?? Buffer.alloc(0)).digestBase64() } } : {};
    return base;
  }

  private addChild(drive: FakeDrive, parentId: string, name: string, folder: boolean, content?: Buffer): FakeItem | "conflict" {
    const clash = [...drive.items.values()].find((i) => i.parentId === parentId && i.name.toLowerCase() === name.toLowerCase());
    if (clash) return "conflict";
    const item: FakeItem = { id: `item-${randomUUID().slice(0, 12)}`, name, parentId, folder, content };
    drive.items.set(item.id, item);
    return item;
  }

  private intercepted(method: string, path: string, kind: "graph" | "upload"): GraphResponse | null {
    for (const fn of this.interceptors) {
      const r = fn({ method, path, kind });
      if (r === "throw") throw new GraphTransportError("NETWORK", true);
      if (r) return r;
    }
    return null;
  }

  async request(credentials: GraphCredentials, req: GraphRequest): Promise<GraphResponse> {
    if (req.rawBody && !this.supportsRawBody) throw new Error("fake: raw body not supported by this transport");
    this.calls.push({ method: req.method, path: req.path, kind: "graph", authorized: true });
    if (credentials.clientSecret !== this.validSecret) throw new GraphTransportError("AUTH_FAILED", false);
    await req.beforeSend?.(); // after "token acquisition", before the send
    const hit = this.intercepted(req.method, req.path, "graph");
    if (hit) return hit;
    return this.route(req);
  }

  async uploadSessionPut(input: { url: URL; body: Buffer; contentRange: string; beforeSend?: () => Promise<void> }): Promise<GraphResponse> {
    await input.beforeSend?.();
    this.calls.push({ method: "PUT", path: input.url.pathname, kind: "upload", authorized: false });
    const hit = this.intercepted("PUT", input.url.pathname, "upload");
    if (hit) return hit;
    const session = this.sessions.get(input.url.searchParams.get("token") ?? "");
    if (!session) return err(404);
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(input.contentRange);
    if (!m) return err(400);
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (Number.isNaN(session.size)) session.size = total; // learned from the first Content-Range
    if (start !== session.next || end - start + 1 !== input.body.length || total !== session.size) return err(416);
    if (end !== total - 1 && input.body.length % (320 * 1024) !== 0) return err(400);
    session.received.push(Buffer.from(input.body));
    session.next = end + 1;
    if (session.next < session.size) return ok(202, { nextExpectedRanges: [`${session.next}-`] });
    const drive = this.drives.get(session.driveId)!;
    let content = Buffer.concat(session.received);
    if (this.corruptUploads) content = Buffer.concat([content.subarray(0, content.length - 1), Buffer.from([content[content.length - 1]! ^ 1])]);
    const item = this.addChild(drive, session.parentId, session.name, false, content);
    this.sessions.delete(input.url.searchParams.get("token") ?? "");
    if (item === "conflict") return err(409);
    return ok(201, this.itemJson(item, this.reportHashes));
  }

  async uploadSessionControl(input: { url: URL; method: "GET" | "DELETE" }): Promise<GraphResponse> {
    this.calls.push({ method: input.method, path: input.url.pathname, kind: "upload", authorized: false });
    const token = input.url.searchParams.get("token") ?? "";
    const session = this.sessions.get(token);
    if (!session) return err(404);
    if (input.method === "DELETE") {
      this.sessions.delete(token);
      return ok(204);
    }
    return ok(200, { nextExpectedRanges: [`${session.next}-`] });
  }

  /* ---------------------------------------------------------------- routing */

  private route(req: GraphRequest): GraphResponse {
    const { method, path } = req;
    const body = (req.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;

    // sites
    if (method === "GET" && (m = /^\/sites\/([a-z0-9.-]+)(?::\/(.+))?$/.exec(path)) && !path.includes(",")) {
      const host = m[1]!;
      const sitePath = m[2] ? m[2].split("/").map(decodeURIComponent).join("/") : "";
      const site = [...this.sites.values()].find((s) => s.hostname === host && s.path.toLowerCase() === sitePath.toLowerCase());
      return site ? ok(200, { id: site.id, displayName: site.displayName, webUrl: site.webUrl }) : err(404);
    }
    if (method === "GET" && (m = /^\/sites\/([^/]+)\/drives$/.exec(path))) {
      const site = this.sites.get(decodeURIComponent(m[1]!));
      if (!site) return err(404);
      return ok(200, { value: site.drives.map((d) => this.drives.get(d)!).map((d) => ({ id: d.id, name: d.name, driveType: d.driveType })) });
    }
    if (method === "GET" && (m = /^\/users\/([^/]+)\/drive$/.exec(path))) {
      const driveId = this.users.get(decodeURIComponent(m[1]!));
      const drive = driveId ? this.drives.get(driveId) : undefined;
      return drive ? ok(200, { id: drive.id, name: drive.name, driveType: drive.driveType }) : err(404);
    }

    // lists
    if ((m = /^\/sites\/([^/]+)\/lists(?:\/([^/]+))?(?:\/(columns|items))?(?:\/([^/]+))?(?:\/(fields))?$/.exec(path))) {
      return this.routeLists(method, m, body, req.query ?? {});
    }

    // drives
    if (!(m = /^\/drives\/([^/]+)(.*)$/.exec(path))) return err(400);
    const drive = this.drives.get(decodeURIComponent(m[1]!));
    if (!drive) return err(404);
    const rest = m[2]!;
    if (method === "GET" && rest === "") return ok(200, { id: drive.id, driveType: drive.driveType, webUrl: drive.webUrl });
    if (method === "GET" && rest === "/root") return ok(200, this.itemJson(drive.items.get(drive.rootId)!));
    if (method === "GET" && (m = /^\/root:\/(.+):$/.exec(rest))) {
      const item = this.findByPath(drive, m[1]!.split("/").map(decodeURIComponent));
      return item ? ok(200, this.itemJson(item)) : err(404);
    }
    if (method === "GET" && (m = /^\/(?:root|items\/([^/]+))\/children$/.exec(rest))) {
      const parentId = m[1] ? decodeURIComponent(m[1]) : drive.rootId;
      if (!drive.items.has(parentId)) return err(404);
      const children = [...drive.items.values()].filter((i) => i.parentId === parentId);
      return ok(200, { value: children.map((c) => ({ ...this.itemJson(c), parentReference: { path: `/drive/root:` } })) });
    }
    if (method === "GET" && (m = /^\/items\/([^/:]+)$/.exec(rest))) {
      const item = drive.items.get(decodeURIComponent(m[1]!));
      return item ? ok(200, this.itemJson(item)) : err(404);
    }
    if (method === "POST" && (m = /^\/items\/([^/:]+)\/children$/.exec(rest))) {
      const parentId = decodeURIComponent(m[1]!);
      if (!drive.items.get(parentId)?.folder) return err(404);
      if (body["@microsoft.graph.conflictBehavior"] !== "fail") return err(400);
      const item = this.addChild(drive, parentId, String(body.name), true);
      return item === "conflict" ? err(409, "nameAlreadyExists") : ok(201, this.itemJson(item));
    }
    if (method === "PUT" && (m = /^\/items\/([^/:]+):\/([^/:]+):\/content$/.exec(rest))) {
      if (req.query?.["@microsoft.graph.conflictBehavior"] !== "fail") return err(400);
      const parentId = decodeURIComponent(m[1]!);
      if (!drive.items.get(parentId)?.folder) return err(404);
      let content = req.rawBody ?? Buffer.alloc(0);
      if (this.corruptUploads && content.length > 0) content = Buffer.concat([content.subarray(1), Buffer.from([content[0]! ^ 1])]);
      const item = this.addChild(drive, parentId, decodeURIComponent(m[2]!), false, content);
      return item === "conflict" ? err(409) : ok(201, this.itemJson(item, this.reportHashes));
    }
    if (method === "POST" && (m = /^\/items\/([^/:]+):\/([^/:]+):\/createUploadSession$/.exec(rest))) {
      const token = randomUUID();
      this.sessions.set(token, { driveId: drive.id, parentId: decodeURIComponent(m[1]!), name: decodeURIComponent(m[2]!), size: Number.NaN, received: [], next: 0 });
      return ok(200, { uploadUrl: `https://${this.uploadHost}/_api/v2.0/drives/x/uploadSession?token=${token}`, expirationDateTime: "2030-01-01T00:00:00Z" });
    }
    if (method === "DELETE" && (m = /^\/items\/([^/:]+)$/.exec(rest))) {
      return drive.items.delete(decodeURIComponent(m[1]!)) ? ok(204) : err(404);
    }
    return err(400);
  }

  private routeLists(method: string, m: RegExpExecArray, body: Record<string, unknown>, query: Record<string, string>): GraphResponse {
    const site = this.sites.get(decodeURIComponent(m[1]!));
    if (!site) return err(404);
    const listId = m[2] ? decodeURIComponent(m[2]) : null;
    const sub = m[3];
    const itemId = m[4] ? decodeURIComponent(m[4]) : null;
    if (!listId) {
      if (method === "GET") return ok(200, { value: [...site.lists.values()].map((l) => ({ id: l.id, displayName: l.displayName })) });
      if (method === "POST") {
        const columns = (Array.isArray(body.columns) ? body.columns : []) as Record<string, unknown>[];
        const list: FakeList = {
          id: randomUUID(),
          displayName: String(body.displayName),
          columns: columns.map((c) => ({
            name: String(c.name),
            type: (["text", "number", "dateTime", "hyperlinkOrPicture"] as const).find((t) => t in c) ?? "text",
            unique: c.enforceUniqueValues === true && c.indexed === true,
          })),
          items: new Map(),
        };
        if ([...site.lists.values()].some((l) => l.displayName.toLowerCase() === list.displayName.toLowerCase())) return err(409);
        site.lists.set(list.id, list);
        return ok(201, { id: list.id, displayName: list.displayName });
      }
      return err(400);
    }
    const list = site.lists.get(listId);
    if (!list) return err(404);
    if (!sub && method === "GET") return ok(200, { id: list.id, displayName: list.displayName });
    if (sub === "columns" && method === "GET") return ok(200, { value: list.columns.map((c) => ({ name: c.name, [c.type]: {}, indexed: c.unique === true, enforceUniqueValues: c.unique === true })) });
    if (sub === "items" && !itemId && method === "POST") {
      const fields = (body.fields ?? {}) as Record<string, unknown>;
      const unknown = Object.keys(fields).filter((k) => k !== "Title" && !list.columns.some((c) => c.name === k));
      if (unknown.length > 0) return err(400, "invalidRequest");
      const duplicate = list.columns.some((c) => c.unique && fields[c.name] !== undefined && [...list.items.values()].some((i) => i.fields[c.name] === fields[c.name]));
      if (duplicate) return err(409, "nameAlreadyExists");
      const id = String(list.items.size + 1);
      list.items.set(id, { id, fields: { ...fields } });
      return ok(201, { id, fields });
    }
    if (sub === "items" && !itemId && method === "GET") {
      const filter = query.$filter ?? "";
      const fm = /^fields\/(\w+) eq '([^']*)'$/.exec(filter);
      const items = [...list.items.values()].filter((i) => !fm || i.fields[fm[1]!] === fm[2]!.replace(/''/g, "'"));
      return ok(200, { value: items.map((i) => ({ id: i.id, fields: i.fields })) });
    }
    if (sub === "items" && itemId && m[5] === "fields" && method === "PATCH") {
      const item = list.items.get(itemId);
      if (!item) return err(404);
      Object.assign(item.fields, body);
      return ok(200, item.fields);
    }
    if (sub === "items" && itemId && !m[5] && method === "GET") {
      const item = list.items.get(itemId);
      return item ? ok(200, { id: item.id, fields: item.fields }) : err(404);
    }
    return err(400);
  }
}
