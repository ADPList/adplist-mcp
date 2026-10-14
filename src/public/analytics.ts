import type { IntentCategory } from "./tools.ts";
import type { PublicSource } from "./source.ts";

// Public-tier reporting (ADPLIST-4479). Aggregate only: no raw query, IP,
// slug, or session id is ever put in an event.
const AMPLITUDE_ENDPOINT = "https://api2.amplitude.com/2/httpapi";

export type PublicAnalyticsEvent =
	| {
			event: "ai_mentor_search_query";
			source: PublicSource;
			status: "ok" | "error";
			result_count: number;
			latency_ms: number;
			had_company_filter: boolean;
			intent_category: IntentCategory;
	  }
	| {
			event: "ai_mentor_profile_view";
			source: PublicSource;
			status: "ok" | "error";
			found: boolean;
			latency_ms: number;
	  };

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

export function emitPublicEvent(
	env: Env,
	ctx: WaitUntil | undefined,
	event: PublicAnalyticsEvent,
): void {
	try {
		console.log(JSON.stringify(event));
	} catch {
		// Logging must never affect the response.
	}
	const apiKey = env.AMPLITUDE_API_KEY;
	if (!apiKey || !ctx) return;
	const { event: eventType, ...properties } = event;
	try {
		ctx.waitUntil(
			fetch(AMPLITUDE_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "*/*" },
				body: JSON.stringify({
					api_key: apiKey,
					events: [
						{
							event_type: eventType,
							// Non-identifying constant per source, never a person or client.
							device_id: `ai-mcp-${event.source}`,
							time: Date.now(),
							event_properties: properties,
						},
					],
				}),
			}).then(
				() => undefined,
				() => undefined,
			),
		);
	} catch {
		// waitUntil or fetch construction failing must not surface to the caller.
	}
}
