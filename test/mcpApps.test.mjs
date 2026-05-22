import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MCP_APP_MIME_TYPE, UI_RESOURCES, buildAppHtml } from "../src/mcpApps.ts";

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

test("UI resource constants use stable ui:// URIs", () => {
	assert.equal(UI_RESOURCES.mentorCards, "ui://adplist/mentor-cards.html");
	assert.equal(UI_RESOURCES.slotPicker, "ui://adplist/slot-picker.html");
	assert.equal(UI_RESOURCES.sessionCards, "ui://adplist/session-cards.html");
});
