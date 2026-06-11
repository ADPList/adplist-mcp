import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
	MCP_APP_MIME_TYPE,
	MCP_APP_EXTENSION_ID,
	CLAUDE_APP_DOMAIN,
	UI_RESOURCES,
	UI_RESOURCE_VERSION,
	APP_BUILD_LABEL,
	appResourceMeta,
	appServerCapabilities,
	appToolMeta,
	buildAppHtml,
} from "../src/mcpApps.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const errorsSource = readFileSync(new URL("../src/errors.ts", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../src/searchMentors.ts", import.meta.url), "utf8");

function renderAppWithToolResult(kind, structuredContent, options = {}) {
	const html = buildAppHtml(kind);
	const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
	assert.ok(script);

	const elements = {
		root: { innerHTML: "" },
		subtitle: { textContent: "" },
	};
	const messageListeners = [];
	const context = {
		Date,
		Intl,
		Map,
		clearTimeout,
		console,
		setTimeout,
		ResizeObserver: class {
			observe() {}
		},
		document: {
			body: {},
			documentElement: { scrollHeight: 0, scrollWidth: 0 },
			getElementById(id) {
				return elements[id];
			},
			querySelectorAll(selector) {
				if (selector === ".mentor-photo") return options.mentorPhotos || [];
				return [];
			},
		},
		parent: { postMessage() {} },
		window: {
			addEventListener(type, listener) {
				if (type === "message") messageListeners.push(listener);
			},
		},
	};
	vm.createContext(context);
	vm.runInContext(script, context);
	for (const listener of messageListeners) {
		listener({
			data: {
				method: "ui/notifications/tool-result",
				params: { structuredContent },
			},
		});
	}
	return elements;
}

test("MCP Apps resources are registered with the app MIME type", () => {
	assert.equal(MCP_APP_MIME_TYPE, "text/html;profile=mcp-app");
	assert.match(indexSource, /registerAppResource\(/);
	assert.match(indexSource, /UI_RESOURCES\.mentorCards/);
	assert.match(indexSource, /UI_RESOURCES\.slotPicker/);
	assert.match(indexSource, /UI_RESOURCES\.sessionCards/);
});

test("server advertises MCP Apps extension capability", () => {
	assert.equal(MCP_APP_EXTENSION_ID, "io.modelcontextprotocol/ui");
	assert.deepEqual(appServerCapabilities(), {
		extensions: {
			"io.modelcontextprotocol/ui": {},
		},
	});
	assert.match(indexSource, /capabilities: appServerCapabilities\(\)/);
});

test("interactive tools advertise MCP Apps resource metadata and preserve fallback content", () => {
	assert.match(indexSource, /_meta: appToolMeta\(UI_RESOURCES\.mentorCards\)/);
	assert.match(indexSource, /_meta: appToolMeta\(UI_RESOURCES\.slotPicker\)/);
	assert.match(indexSource, /_meta: appToolMeta\(UI_RESOURCES\.sessionCards\)/);
	assert.match(errorsSource, /structuredContent/);
	assert.match(errorsSource, /text\/html;profile=mcp-app/);
});

test("app metadata includes Claude domain and ChatGPT compatibility aliases", () => {
	assert.deepEqual(appToolMeta(UI_RESOURCES.mentorCards), {
		ui: {
			resourceUri: UI_RESOURCES.mentorCards,
			visibility: ["model", "app"],
		},
		"ui/resourceUri": UI_RESOURCES.mentorCards,
		"openai/outputTemplate": UI_RESOURCES.mentorCards,
		"openai/widgetAccessible": true,
	});

	const resourceMeta = appResourceMeta("Mentor cards");
	assert.equal(
		CLAUDE_APP_DOMAIN,
		"a2380ff814fb1c60de1605b6ee5c83af.claudemcpcontent.com",
	);
	assert.equal(resourceMeta.ui.domain, CLAUDE_APP_DOMAIN);
	assert.equal(resourceMeta["openai/widgetDescription"], "Mentor cards");
	assert.equal(resourceMeta["openai/widgetPrefersBorder"], true);
	assert.deepEqual(
		resourceMeta["openai/widgetCSP"].resource_domains,
		resourceMeta.ui.csp.resourceDomains,
	);
	assert.ok(
		resourceMeta.ui.csp.resourceDomains.includes("https://adplist-bucket.s3.amazonaws.com"),
	);
});

test("mentor cards require and normalize profile photo URLs from search-service", () => {
	assert.match(searchSource, /profile_photo_url/);
	assert.match(searchSource, /mentor\.profile\?\.image/);
	assert.match(searchSource, /mentor\.profileImage/);
	assert.match(searchSource, /normalizeImageUrl/);
});

test("mentor cards render photos and slot picker renders selectable date-time components", () => {
	const mentorHtml = buildAppHtml("mentor-cards");
	assert.match(mentorHtml, /mentor-photo/);
	assert.match(mentorHtml, /mentor-photo-frame/);
	assert.match(mentorHtml, /aspect-ratio: 1 \/ 1/);
	assert.match(mentorHtml, /mentor-photo-fallback visible/);
	assert.match(mentorHtml, /addEventListener\('error', showFallback\)/);
	assert.match(mentorHtml, /naturalWidth === 0/);
	assert.doesNotMatch(mentorHtml, /onerror=/);
	assert.match(mentorHtml, /profile photo/);
	assert.match(mentorHtml, /See available times/);

	const slotHtml = buildAppHtml("slot-picker");
	assert.match(slotHtml, /class=\"days\"/);
	assert.match(slotHtml, /class=\"slots\"/);
	assert.match(slotHtml, /I choose/);
	assert.match(slotHtml, /ui\/message/);
});

test("mentor cards render a three-column grid with compact black CTAs", () => {
	const mentorHtml = buildAppHtml("mentor-cards");
	assert.match(mentorHtml, /class="grid cols-3"/);
	assert.match(mentorHtml, /\.grid\.cols-3 \{ grid-template-columns: repeat\(3, 1fr\); \}/);
	assert.match(mentorHtml, /\.cta \{[^}]*background: var\(--text\)/);
	assert.doesNotMatch(mentorHtml, /\.cta \{[^}]*linear-gradient/);
});

test("slot picker enforces a single selection and only messages chat on explicit confirm", () => {
	const slotHtml = buildAppHtml("slot-picker");
	// selection is tracked as one value and painted from state, not accumulated classes
	assert.match(slotHtml, /selected && selected\.iso === slot\.slot_iso/);
	assert.doesNotMatch(slotHtml, /classList\.add\('selected'\)/);
	// slot clicks only update selection; the confirm button sends the one chat message
	assert.match(slotHtml, /id="confirm-slot"/);
	assert.match(slotHtml, /if \(sent \|\| !selected\) return;/);
	assert.equal(slotHtml.match(/sendUserMessage\('I choose/g)?.length, 1);
	// re-clicking the confirmed slot must not re-arm the confirm button (Greptile/Codex P1)
	assert.match(slotHtml, /if \(selected && selected\.iso === button\.dataset\.slot\) return;/);
	// the confirm bar only shows when the selected slot's day is active (Greptile P2)
	assert.match(slotHtml, /selectedOnActiveDay/);
});

test("MCP App output includes visible version diagnostics for Claude verification", () => {
	const html = buildAppHtml("mentor-cards");
	assert.equal(UI_RESOURCE_VERSION, "v5");
	assert.equal(APP_BUILD_LABEL, "ADPList MCP App v5");
	assert.match(html, /ADPList MCP App v5/);
	assert.match(html, /aria-label="ADPList MCP App version"/);
	assert.match(html, /appInfo: \{ name: titleForView\(\), version: "5\.0\.0" \}/);
});

test("mentor photo fallback runs for already-broken Claude-hosted images", () => {
	const fallback = {
		addedClasses: [],
		classList: {
			add(className) {
				fallback.addedClasses.push(className);
			},
		},
	};
	const image = {
		style: {},
		complete: true,
		naturalWidth: 0,
		nextElementSibling: fallback,
		listeners: {},
		addEventListener(type, listener) {
			this.listeners[type] = listener;
		},
	};

	renderAppWithToolResult(
		"mentor-cards",
		{
			mentors: [
				{
					name: "Ada Lovelace",
					slug: "ada-lovelace",
					profile_photo_url: "https://images.example/missing.jpg",
				},
			],
		},
		{ mentorPhotos: [image] },
	);

	assert.equal(typeof image.listeners.error, "function");
	assert.equal(image.style.display, "none");
	assert.deepEqual(fallback.addedClasses, ["visible"]);
});

test("embedded apps perform MCP Apps ui initialize handshake before initialized notification", () => {
	const html = buildAppHtml("mentor-cards");
	assert.match(html, /request\('ui\/initialize'/);
	assert.match(html, /appCapabilities/);
	assert.match(html, /appInfo/);
	assert.match(html, /protocolVersion: '2026-01-26'/);
	assert.match(html, /notify\('ui\/notifications\/initialized'/);
	assert.match(html, /const isResponse = hasId && !msg\.method/);
	assert.match(html, /msg\.method === 'ui\/resource-teardown'/);
	assert.ok(
		html.indexOf("request('ui/initialize'") <
			html.indexOf("notify('ui/notifications/initialized'"),
	);
});

test("slot picker groups days by the user's local date instead of UTC date", () => {
	const slotHtml = buildAppHtml("slot-picker");
	assert.match(slotHtml, /localDayKey\(date\)/);
	assert.match(slotHtml, /formatToParts\(date\)/);
	assert.match(slotHtml, /localDayLabel\(day\)/);
	assert.doesNotMatch(slotHtml, /toISOString\(\)\.slice\(0,10\)/);
});

test("UI resource constants use versioned ui:// URIs so Claude refreshes cached app resources", () => {
	assert.equal(UI_RESOURCES.mentorCards, "ui://adplist/v5/mentor-cards.html");
	assert.equal(UI_RESOURCES.slotPicker, "ui://adplist/v5/slot-picker.html");
	assert.equal(UI_RESOURCES.sessionCards, "ui://adplist/v5/session-cards.html");
});

test("each widget shows friendly per-view loading copy instead of MCP jargon", () => {
	assert.match(buildAppHtml("mentor-cards"), /Finding your mentors…/);
	assert.match(buildAppHtml("slot-picker"), /Loading available times…/);
	assert.match(buildAppHtml("session-cards"), /Loading your sessions…/);
	assert.doesNotMatch(buildAppHtml("mentor-cards"), /Waiting for the MCP tool result/);
});

test("mentor card CTA sends the display name to chat, not the slug", () => {
	const mentorHtml = buildAppHtml("mentor-cards");
	assert.match(mentorHtml, /data-name=/);
	assert.match(
		mentorHtml,
		/sendUserMessage\('Show available times for ' \+ \(button\.dataset\.name \|\| \('mentor ' \+ button\.dataset\.slug\)\)\)/,
	);
});

test("session card never prints the raw session URL as text", () => {
	const { root } = renderAppWithToolResult("session-cards", {
		sessions: [
			{
				session_id: "meeting-1",
				status: "confirmed",
				session_url: "https://adplist.org/meetings/meeting-1",
				mentor: { name: "Ada Lovelace" },
				mentee: { name: "Grace Hopper" },
			},
		],
	});
	assert.match(root.innerHTML, /data-url="https:\/\/adplist\.org\/meetings\/meeting-1"/);
	assert.doesNotMatch(root.innerHTML, />https:\/\/adplist\.org/);
	assert.match(root.innerHTML, /Open session/);
});

test("session card relabels the link button to View request while awaiting confirmation", () => {
	for (const status of ["requested", "pending", undefined]) {
		const { root } = renderAppWithToolResult("session-cards", {
			sessions: [
				{
					session_id: "meeting-2",
					status,
					session_url: "https://adplist.org/meetings/meeting-2",
					mentor: { name: "Ada Lovelace" },
					mentee: { name: "Grace Hopper" },
				},
			],
		});
		assert.match(root.innerHTML, /View request/);
		assert.doesNotMatch(root.innerHTML, /Open session/);
	}
});

test("session card uses View session for terminal statuses instead of Open session", () => {
	for (const status of ["completed", "cancelled", "declined"]) {
		const { root } = renderAppWithToolResult("session-cards", {
			sessions: [
				{
					session_id: "meeting-5",
					status,
					session_url: "https://adplist.org/meetings/meeting-5",
					mentor: { name: "Ada Lovelace" },
					mentee: { name: "Grace Hopper" },
				},
			],
		});
		assert.match(root.innerHTML, /View session/);
		assert.doesNotMatch(root.innerHTML, /Open session/);
	}
});

test("session card hides the people row when both party names are blank", () => {
	const { root } = renderAppWithToolResult("session-cards", {
		sessions: [{ session_id: "meeting-3", status: "requested", mentor: {}, mentee: {} }],
	});
	assert.doesNotMatch(root.innerHTML, /class="people"/);

	const withNames = renderAppWithToolResult("session-cards", {
		sessions: [
			{ session_id: "meeting-4", status: "requested", mentor: { name: "Ada" }, mentee: {} },
		],
	});
	assert.match(withNames.root.innerHTML, /class="people"/);
});

test("slot picker renders viewer-local timezone labels instead of raw UTC-only times", () => {
	const { root, subtitle } = renderAppWithToolResult("slot-picker", {
		slots: [
			{
				mentor_slug: "ada-lovelace",
				slot_iso: "2026-06-02T20:00:00.000Z",
				duration_minutes: 30,
				slot_local_display: "Tue, Jun 2 · 8:00 PM UTC",
			},
		],
	});

	assert.match(subtitle.textContent, /in your local timezone/);
	assert.doesNotMatch(root.innerHTML, /Tue, Jun 2 · 8:00 PM UTC/);
	assert.match(root.innerHTML, /30 min · /);
	assert.match(root.innerHTML, /ada-lovelace/);
});
