import OAuthProvider, { type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import app from "./app";
import { MCP_SCOPES } from "./config";
import {
	refreshAdplistPropsOnTokenExchange,
	tokenRefreshErrorResponse,
} from "./adplistTokenRefresh";
import { bookSession, listAvailability } from "./booking";
import { listJournals, readJournal } from "./journals";
import { manageMyContext } from "./profile";
import { searchMentors } from "./searchMentors";
import { cancelSession, listMySessions } from "./sessions";
import { toolResponse } from "./errors";
import { enforceToolCallRateLimit } from "./rateLimit";
import type { McpUserProps } from "./types";

export class MyMCP extends McpAgent<Env, unknown, McpUserProps> {
	server = new McpServer({
		name: "adplist-mcp",
		version: "0.1.0",
	});

	private toolResponse<T>(run: () => Promise<T>) {
		return toolResponse(() => runWithToolRateLimit(this.env, this.props, run));
	}

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
			async (input) => this.toolResponse(() => manageMyContext(this.env, this.props, input)),
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
			async (input) => this.toolResponse(() => searchMentors(this.env, this.props, input)),
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
			async (input) => this.toolResponse(() => listAvailability(this.env, this.props, input)),
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
			async (input) => this.toolResponse(() => bookSession(this.env, this.props, input)),
		);

		this.server.registerTool(
			"list_my_sessions",
			{
				description:
					"List the authenticated user's ADPList mentorship sessions. Defaults to upcoming sessions to keep chat context compact. Use scope: 'past' only when the user asks for previous sessions, and scope: 'all' only when they explicitly ask for everything. Returns every session the user is part of, whether they booked it as the mentee or are the mentor. Each item includes both the mentor and the mentee (name, slug, title, organization), the scheduled time, duration, status, source, the booking_notes and booking_questions exchanged when the session was booked, and the dashboard URL — frame each session relative to whichever of the two parties is the user you are helping.",
				inputSchema: {
					scope: z
						.enum(["upcoming", "past", "all"])
						.optional()
						.describe("Defaults to upcoming."),
					limit: z
						.number()
						.int()
						.min(1)
						.max(50)
						.optional()
						.describe("Defaults to 20; max 50."),
				},
			},
			async (input) => this.toolResponse(() => listMySessions(this.env, this.props, input)),
		);

		this.server.registerTool(
			"list_journals",
			{
				description:
					"List the authenticated user's ADPList AI-generated post-session summaries from past mentorship sessions. Use this when the user asks what they discussed, learned, committed to, or covered with mentors across past sessions. These are not user-authored free-form journals, so never frame results as 'what you wrote in your journal'; say 'your session summary covered' or 'you and your mentor discussed'. Returns compact metadata by default. Set with_content: true only when the user needs the actual structured summary fields in the list.",
				inputSchema: {
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.optional()
						.describe("Defaults to 30; max 100."),
					since_iso: z
						.string()
						.trim()
						.min(1)
						.optional()
						.describe("Optional ISO 8601 lower bound for journal created time."),
					with_content: z
						.boolean()
						.optional()
						.describe(
							"Defaults to false. When true, includes full structured summary fields for each returned journal.",
						),
				},
			},
			async (input) => this.toolResponse(() => listJournals(this.env, this.props, input)),
		);

		this.server.registerTool(
			"read_journal",
			{
				description:
					"Read one ADPList AI-generated post-session summary for the authenticated user. Use this after list_journals or when the user asks about a specific past mentorship session. The content is generated from the AI Note Taker transcript summary (tldr, insights, highlights, action items), not something the user wrote manually. Journal content is sensitive; fetch it only when needed for the user's request and do not imply it is stored in MCP infrastructure.",
				inputSchema: {
					journal_id: z
						.string()
						.trim()
						.min(1)
						.describe("Journal ID returned by list_journals."),
				},
			},
			async (input) => this.toolResponse(() => readJournal(this.env, this.props, input)),
		);

		this.server.registerTool(
			"cancel_session",
			{
				description:
					"Cancel an ADPList mentorship session for the authenticated user. IMPORTANT: This changes the user's booking and notifies the mentor. Before calling this tool, always confirm the exact session, mentor, and scheduled time with the user in chat (for example: 'Just to confirm, cancel your Tuesday 3 PM session with Sarah? Mentors get notified.'). Pass an optional reason string so the mentor knows why. If the user asks to reschedule, call cancel_session only after confirmation, then use list_availability and book_session for the new slot; there is no native reschedule_session tool in v1.",
				inputSchema: {
					session_id: z
						.string()
						.trim()
						.min(1)
						.describe("Session ID returned by list_my_sessions or book_session."),
					reason: z
						.string()
						.trim()
						.min(1)
						.max(1000)
						.optional()
						.describe("Optional cancellation reason to share with the mentor."),
				},
			},
			async (input) => this.toolResponse(() => cancelSession(this.env, this.props, input)),
		);
	}
}

async function runWithToolRateLimit<T>(
	env: Env,
	props: McpUserProps | undefined,
	run: () => Promise<T>,
): Promise<T> {
	await enforceToolCallRateLimit(env, props);
	return run();
}

function createOAuthProvider(env: Env) {
	const options: OAuthProviderOptions<Env> = {
		apiRoute: "/sse",
		apiHandler: MyMCP.serve("/sse", { transport: "auto" }),
		defaultHandler: app,
		authorizeEndpoint: "/oauth/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
		scopesSupported: [...MCP_SCOPES],
		accessTokenTTL: 60 * 60,
		refreshTokenTTL: 30 * 24 * 60 * 60,
		tokenExchangeCallback: (options) => refreshAdplistPropsOnTokenExchange(options, env),
		allowImplicitFlow: false,
		allowPlainPKCE: false,
		resourceMetadata: {
			resource_name: "ADPList MCP",
			scopes_supported: [...MCP_SCOPES],
			bearer_methods_supported: ["header"],
		},
	};
	return new OAuthProvider(options);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		try {
			return await createOAuthProvider(env).fetch(request, env, ctx);
		} catch (error) {
			const response = tokenRefreshErrorResponse(error);
			if (response) return response;
			throw error;
		}
	},
};
