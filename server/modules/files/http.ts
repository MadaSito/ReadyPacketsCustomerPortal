/**
 * Files module — raw HTTP routes (uploads, downloads, signed webhooks). Owner: files module engineer.
 * Leave empty if the module needs none. Routes mount under /api/files/… AFTER session resolution and
 * CSRF/origin enforcement, except routes registered through `registerRawRoutes` (signed webhooks only).
 */
import type { Router } from "express";
import type { Services } from "../../container.js";

export function registerFilesHttpRoutes(_router: Router, _services: Services): void {}
