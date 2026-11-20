/** Regenerates data/catalog/offerings.schema.json from the Zod schema:  tsx scripts/ops/catalog/export-schema.ts */
import { writeFile } from "node:fs/promises";
import { buildOfferingsJsonSchema, OFFERINGS_JSON_SCHEMA_FILE } from "./offerings.js";

await writeFile(OFFERINGS_JSON_SCHEMA_FILE, buildOfferingsJsonSchema());
process.stdout.write(`wrote ${OFFERINGS_JSON_SCHEMA_FILE}\n`);
