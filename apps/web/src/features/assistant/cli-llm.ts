/**
 * The ONE seam between the assistant route and hf-bridge's planJson dispatch.
 * Existing only so the route test can mock this module (app-internal alias)
 * instead of mock.module-ing the shared @framecut/hf-bridge package, which
 * Bun would apply process-globally and leak into the Director suites.
 */
import { planJson } from "@framecut/hf-bridge";

export function cliPlanTurn({
	prompt,
	auth,
	schema,
}: {
	prompt: string;
	auth: Parameters<typeof planJson>[0]["auth"];
	schema: object;
}): ReturnType<typeof planJson> {
	return planJson({ prompt, auth, schema });
}
