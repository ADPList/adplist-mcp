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

export type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

export function emitPublicEvent(
	env: Env,
	ctx: WaitUntil | undefined,
	event: PublicAnalyticsEvent,
): void {
	const { event: eventType, ...properties } = event;
	// Non-identifying constant per source, never a person or client.
	emitAggregateEvent(env, ctx, eventType, `ai-mcp-${event.source}`, event, properties);
}

// Logs `logged` as one JSON line, then posts the event to Amplitude when a key
// and waitUntil are available. Never throws and never awaits the network.
export function emitAggregateEvent(
	env: Env,
	ctx: WaitUntil | undefined,
	eventType: string,
	deviceId: string,
	logged: object,
	properties: Record<string, unknown>,
): void {
	try {
		console.log(JSON.stringify(logged));
	} catch {
		// Logging must never affect the response.
	}
	const apiKey = env.AMPLITUDE_API_KEY;
	if (!apiKey || !ctx) return;
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
							device_id: deviceId,
							time: Date.now(),
							insert_id: crypto.randomUUID(),
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
