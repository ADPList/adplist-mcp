import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	MCP_APP_MIME_TYPE,
	UI_RESOURCES,
	appResourceMeta,
	appToolMeta,
	buildAppHtml,
} from "../src/mcpApps.ts";

const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const errorsSource = readFileSync(new URL("../src/errors.ts", import.meta.url), "utf8");
const searchSource = readFileSync(new URL("../src/searchMentors.ts", import.meta.url), "utf8");

test("V2 MCP Apps resources are registered with the app MIME type", () => {
	assert.equal(MCP_APP_MIME_TYPE, "text/html;profile=mcp-app");
	assert.match(indexSource, /registerAppResource\(/);
	assert.match(indexSource, /UI_RESOURCES\.mentorCards/);
	assert.match(indexSource, /UI_RESOURCES\.slotPicker/);
	assert.match(indexSource, /UI_RESOURCES\.sessionCards/);
});

test("interactive tools advertise MCP Apps resource metadata and preserve fallback content", () => {
	assert.match(indexSource, /_meta: appToolMeta\(UI_RESOURCES\.mentorCards\)/);
	assert.match(indexSource, /_meta: appToolMeta\(UI_RESOURCES\.slotPicker\)/);
	assert.match(indexSource, /_meta: appToolMeta\(UI_RESOURCES\.sessionCards\)/);
	assert.match(errorsSource, /structuredContent/);
	assert.match(errorsSource, /text\/html;profile=mcp-app/);
});

test("app metadata includes ChatGPT compatibility aliases", () => {
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
	assert.match(mentorHtml, /profile photo/);
	assert.match(mentorHtml, /See available times/);

	const slotHtml = buildAppHtml("slot-picker");
	assert.match(slotHtml, /class=\"days\"/);
	assert.match(slotHtml, /class=\"slots\"/);
	assert.match(slotHtml, /I choose/);
	assert.match(slotHtml, /ui\/message/);
});

test("slot picker groups days by the user's local date instead of UTC date", () => {
	const slotHtml = buildAppHtml("slot-picker");
	assert.match(slotHtml, /localDayKey\(date\)/);
	assert.match(slotHtml, /formatToParts\(date\)/);
	assert.match(slotHtml, /localDayLabel\(day\)/);
	assert.doesNotMatch(slotHtml, /toISOString\(\)\.slice\(0,10\)/);
});

test("UI resource constants use stable ui:// URIs", () => {
	assert.equal(UI_RESOURCES.mentorCards, "ui://adplist/mentor-cards.html");
	assert.equal(UI_RESOURCES.slotPicker, "ui://adplist/slot-picker.html");
	assert.equal(UI_RESOURCES.sessionCards, "ui://adplist/session-cards.html");
});
