/**
 * Context resolvers for the community triggers in `TRIGGER_CATALOGUE` (staff-only):
 *  - `community.topic_created` → `topic_link`
 *  - `community.post_reported` → `queue_link`
 * Never resolves titles, bodies, display names or report notes.
 */
import { ULID_PATTERN } from "../../core/ids.js";
import { registerAutomationTrigger } from "../automations/contracts.js";

let registered = false;

export function registerCommunityAutomationTriggers(): void {
  if (registered) return;
  registered = true;
  registerAutomationTrigger({
    key: "community.topic_created",
    async resolveContext({ event, services, signal }) {
      signal.throwIfAborted();
      const id = event.resource?.type === "community_topic" ? event.resource.publicId : null;
      if (!id || !ULID_PATTERN.test(id)) return {};
      return { fields: { topic_link: new URL(`/community/t/${id}`, services.config.canonicalOrigin).href } };
    },
  });
  registerAutomationTrigger({
    key: "community.post_reported",
    async resolveContext({ services, signal }) {
      signal.throwIfAborted();
      return { fields: { queue_link: new URL("/admin/community", services.config.canonicalOrigin).href } };
    },
  });
}
