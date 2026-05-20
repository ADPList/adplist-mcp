import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import app from "./app";
import { MCP_SCOPES } from "./config";
import { bookSession, listAvailability } from "./booking";
import { manageMyContext } from "./profile";
import { searchMentors } from "./searchMentors";
import type { McpUserProps } from "./types";

export class MyMCP extends McpAgent<Env, unknown, McpUserProps> {
	server = new McpServer({
		name: "adplist-mcp",
		version: "0.1.0",
	});

	async init() {
		this.server.registerTool(
			"manage_my_context",
			{
				description:
					"Read, update, or clear the user's stored career context on ADPList. This profile persists across sessions and improves mentor recommendations. Call with no arguments to show the user what's currently stored. Call with action: 'merge' and an updates object when the user explicitly asks you to remember something about their career (role, focus area, skills they want to develop, etc.). Call with action: 'clear' when they ask to forget everything. Do not proactively store things the user did not explicitly ask you to remember — this is an explicit-only memory in v1.",
				inputSchema: {
					action: z
						.enum(["read", "merge", "clear"])
						.optional()
						.describe("Defaults to read when omitted."),
					updates: z
						.record(z.string(), z.unknown())
						.optional()
						.describe("Career context fields to shallow-merge when action is merge."),
				},
			},
			async (input) => {
				const result = await manageMyContext(this.env, this.props, input);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		);

		this.server.registerTool(
			"search_mentors",
			{
				description:
					"Find ADPList mentors for a user's career intent using the existing Explore personalization ranker. This can take a few seconds because it calls the live search-service. Use it when the user describes a mentorship, career transition, role, discipline, country, or language need. Returns compact ranked mentor cards plus Algolia queryID for later booking attribution.",
				inputSchema: {
					intent: z
						.string()
						.trim()
						.min(1)
						.max(3000)
						.describe("The user's mentorship/career intent in natural language."),
					filters: z
						.object({
							discipline: z.string().trim().min(1).optional(),
							country: z
								.string()
								.trim()
								.min(2)
								.max(2)
								.optional()
								.describe("ISO 3166-1 alpha-2 country code, e.g. US or SG."),
							language: z.string().trim().min(1).optional(),
							max_results: z.number().int().min(5).max(8).optional(),
						})
						.optional(),
				},
			},
			async (input) => {
				const result = await searchMentors(this.env, this.props, input);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		);

		this.server.registerTool(
			"list_availability",
			{
				description:
					"List available ADPList mentorship booking slots for a mentor over the next N days. Use this after search_mentors when the user has picked a mentor. Returns at most 20 compact UTC slots plus a localized display string, so ask the user which slot they want before booking.",
				inputSchema: {
					mentor_slug: z
						.string()
						.trim()
						.min(1)
						.describe("Mentor slug returned by search_mentors."),
					days: z
						.number()
						.int()
						.min(1)
						.max(30)
						.optional()
						.describe("Lookahead window in days. Defaults to 14, max 30."),
				},
			},
			async (input) => {
				const result = await listAvailability(this.env, this.props, input);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		);

		this.server.registerTool(
			"book_session",
			{
				description:
					"Request an ADPList mentorship session for the authenticated user. IMPORTANT: Before calling this tool, always confirm the exact mentor, time, and note in chat with the user. Most ADPList sessions are requests awaiting mentor confirmation, not instantly confirmed meetings. Only use free mentorship sessions in v1. Pass queryID from the earlier search_mentors result when available for booking attribution.",
				inputSchema: {
					mentor_slug: z
						.string()
						.trim()
						.min(1)
						.describe("Mentor slug returned by search_mentors."),
					slot_iso: z
						.string()
						.trim()
						.min(1)
						.describe("UTC ISO 8601 slot returned by list_availability."),
					note: z
						.string()
						.trim()
						.min(1)
						.max(3000)
						.describe("User-approved booking note/message to the mentor."),
					queryID: z
						.string()
						.trim()
						.min(1)
						.optional()
						.describe("Algolia queryID from search_mentors, if available."),
				},
			},
			async (input) => {
				const result = await bookSession(this.env, this.props, input);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			},
		);
	}
}

export default new OAuthProvider({
	apiRoute: "/sse",
	apiHandler: MyMCP.serveSSE("/sse"),
	defaultHandler: app,
	authorizeEndpoint: "/oauth/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	scopesSupported: [...MCP_SCOPES],
	accessTokenTTL: 60 * 60,
	refreshTokenTTL: 30 * 24 * 60 * 60,
	allowImplicitFlow: false,
	allowPlainPKCE: false,
	resourceMetadata: {
		resource_name: "ADPList MCP",
		scopes_supported: [...MCP_SCOPES],
		bearer_methods_supported: ["header"],
	},
});
