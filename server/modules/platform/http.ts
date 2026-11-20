/**
 * Platform module — raw HTTP routes (uploads, downloads, signed webhooks). Owner: platform module engineer.
 * Leave empty if the module needs none. Routes mount under /api/platform/… AFTER session resolution and
 * CSRF/origin enforcement, except routes registered through `registerRawRoutes` (signed webhooks only).
 */
import type { Router } from "express";
import type { Services } from "../../container.js";

export function registerPlatformHttpRoutes(_router: Router, _services: Services): void {}
