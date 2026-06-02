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

test("MCP App output includes visible version diagnostics for Claude verification", () => {
	const html = buildAppHtml("mentor-cards");
	assert.equal(UI_RESOURCE_VERSION, "v3");
	assert.equal(APP_BUILD_LABEL, "ADPList MCP App v3");
	assert.match(html, /ADPList MCP App v3/);
	assert.match(html, /aria-label="ADPList MCP App version"/);
	assert.match(html, /appInfo: \{ name: titleForView\(\), version: "v3" \}/);
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
	assert.equal(UI_RESOURCES.mentorCards, "ui://adplist/v3/mentor-cards.html");
	assert.equal(UI_RESOURCES.slotPicker, "ui://adplist/v3/slot-picker.html");
	assert.equal(UI_RESOURCES.sessionCards, "ui://adplist/v3/session-cards.html");
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

	assert.match(subtitle.textContent, /time in your local timezone/);
	assert.doesNotMatch(root.innerHTML, /Tue, Jun 2 · 8:00 PM UTC/);
	assert.match(root.innerHTML, /30 min · /);
	assert.match(root.innerHTML, /ada-lovelace/);
});
