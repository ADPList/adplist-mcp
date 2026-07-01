import OAuthProvider, { type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import app from "./app";
import { MCP_SCOPES } from "./config";
import {
	MCP_APP_MIME_TYPE,
	UI_RESOURCES,
	appResourceMeta,
	appServerCapabilities,
	appToolMeta,
	buildAppHtml,
	type AppViewKind,
} from "./mcpApps";
import {
	ensureFreshAdplistProps,
	refreshAdplistPropsOnTokenExchange,
	tokenRefreshErrorResponse,
} from "./adplistTokenRefresh";
import { bookSession, listAvailability } from "./booking";
import { listJournals, readJournal } from "./journals";
import { getMentorProfile } from "./mentorProfile";
import { manageMyContext } from "./profile";
import { searchMentors, type SearchMentorsOutput } from "./searchMentors";
import { cancelSession, listMySessions } from "./sessions";
import {
	listMentorRequests,
	respondToMentorRequest,
	rescheduleAsMentor,
	listMyMentees,
} from "./mentor";
import { toolResponse } from "./errors";
import { enforceToolCallRateLimit } from "./rateLimit";
import type { McpUserProps } from "./types";

export class MyMCP extends McpAgent<Env, unknown, McpUserProps> {
	server = new McpServer(
		{
			name: "adplist-mcp",
			version: "0.1.0",
		},
		{ capabilities: appServerCapabilities() },
	);

	private toolResponse<T>(
		run: () => Promise<T>,
		app?: {
			resourceUri: string;
			name: string;
			title: string;
			description: string;
			shouldRender?: (result: T) => boolean;
		},
	) {
		return toolResponse(() => runWithToolRateLimit(this.env, this.props, run), app);
	}

	private registerAppResource(name: string, uri: string, kind: AppViewKind, description: string) {
		this.server.registerResource(
			name,
			uri,
			{
				description,
				mimeType: MCP_APP_MIME_TYPE,
				_meta: appResourceMeta(description),
			},
			async () => ({
				contents: [
					{
						uri,
						mimeType: MCP_APP_MIME_TYPE,
						text: buildAppHtml(kind),
						_meta: appResourceMeta(description),
					},
				],
			}),
		);
	}

	async init() {
		this.registerAppResource(
			"ADPList Mentor Cards",
			UI_RESOURCES.mentorCards,
			"mentor-cards",
			"Clean visual mentor result cards with profile photos and booking CTAs.",
		);
		this.registerAppResource(
			"ADPList Slot Picker",
			UI_RESOURCES.slotPicker,
			"slot-picker",
			"Airbnb-like date/time picker for ADPList mentor availability.",
		);
		this.registerAppResource(
			"ADPList Session Cards",
			UI_RESOURCES.sessionCards,
			"session-cards",
			"Visual cards for ADPList mentorship session status and details.",
		);

		this.server.registerTool(
			"manage_my_context",
			{
				description:
					"Read, update, or clear the user's stored career context on ADPList. This profile persists across sessions and improves mentor recommendations. Call with no arguments to show the user what's currently stored. Call with action: 'merge' and an updates object when the user explicitly asks you to remember something about their career (role, focus area, skills they want to develop, etc.). Call with action: 'clear' when they ask to forget everything. Do not proactively store things the user did not explicitly ask you to remember — this is an explicit-only memory in v1.",
				annotations: {
					title: "Manage ADPList context",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
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
					"Find ADPList mentors for a user's career intent using the existing Explore personalization ranker. This can take a few seconds because it calls the live search-service. Use it when the user describes a mentorship, career transition, role, discipline, country, or language need. In intent, describe who the user is from the conversation — current role, seniority, company or industry, and what they want to achieve and why — not just topic keywords (e.g. 'senior PM at a fintech startup transitioning into UX research, wants help running first discovery interviews' rather than 'user research for startups'). HARD LIMIT: call this tool at most ONCE per user request. Every call renders another full card grid in chat; do not run broad/narrow/fallback search variations yourself and do not call it again just to get more cards. The server already overfetches, reranks, retries over-strict discipline filters, and tops up sparse domain results inside a single call. For growth/marketing searches, omit max_results unless the user explicitly asks for fewer; the server will return up to one full 9-card grid at once. If results are sparse or imperfect, present the one grid that came back, note the limitation, and deep-dive the best candidates with get_mentor_profile (renders no widget) before deciding whether to ask the user to adjust. Returns compact ranked mentor cards plus Algolia queryID for later booking attribution. After the cards render, consider deep-diving the top 2-3 candidates with get_mentor_profile and giving the user a short personal recommendation in chat that references their situation — do not just restate the cards. MCP Apps hosts should render the attached clean visual mentor cards; text/JSON fallback remains complete for unsupported hosts. When the widget renders, keep your chat text to about one line and never echo the raw JSON result in prose.",
				_meta: appToolMeta(UI_RESOURCES.mentorCards),
				annotations: {
					title: "Search ADPList mentors",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
				inputSchema: {
					intent: z
						.string()
						.trim()
						.min(1)
						.max(3000)
						.describe(
							"The user's mentorship/career intent in natural language. Include who the user is (role, seniority, situation) and their goal, not just topic keywords.",
						),
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
							max_results: z
								.number()
								.int()
								.min(3)
								.max(9)
								.optional()
								.describe(
									"How many mentors to return. Snapped to full rows of 3 (3, 6, or 9) for the card grid. Omit this for growth/marketing searches so the server can return one full grid at once.",
								),
						})
						.optional(),
				},
			},
			async (input) =>
				this.toolResponse(() => searchMentors(this.env, this.props, input), {
					resourceUri: UI_RESOURCES.mentorCards,
					name: "adplist-mentor-cards",
					title: "ADPList mentor cards",
					description: "Interactive ADPList mentor results with profile photos.",
					shouldRender: (result: SearchMentorsOutput) => result.mentors.length > 0,
				}),
		);

		this.server.registerTool(
			"get_mentor_profile",
			{
				description:
					"Fetch a mentor's full public ADPList profile by slug: bio, complete expertise and disciplines, languages, experience level, review stats, and recent review snippets — the same information shown on their public profile page. Use it after search_mentors to deep-dive the top candidates, compare them against the user's actual situation, and explain in your own words why a specific mentor fits. Read-only and fast; calling it for 2-3 candidates in parallel is fine.",
				annotations: {
					title: "Get mentor public profile",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
				inputSchema: {
					mentor_slug: z
						.string()
						.trim()
						.min(1)
						.describe("Mentor slug from search_mentors results (e.g. felix-lee)."),
				},
			},
			async (input) => this.toolResponse(() => getMentorProfile(this.env, input)),
		);

		this.server.registerTool(
			"list_availability",
			{
				description:
					"List available ADPList mentorship booking slots for a mentor over the next N days. Defaults to 30 days so mentors with sparse near-term availability are not incorrectly shown as unavailable. Use this after search_mentors when the user has picked a mentor. Returns at most 20 compact UTC slots plus a localized display string. MCP Apps hosts should render the attached clean Airbnb-like date/time picker; always ask the user to confirm the exact selected slot before booking. When the widget renders, keep your chat text to about one line and never echo the raw JSON result in prose.",
				_meta: appToolMeta(UI_RESOURCES.slotPicker),
				annotations: {
					title: "List mentor availability",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
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
						.describe("Lookahead window in days. Defaults to 30, max 30."),
				},
			},
			async (input) =>
				this.toolResponse(() => listAvailability(this.env, this.props, input), {
					resourceUri: UI_RESOURCES.slotPicker,
					name: "adplist-slot-picker",
					title: "Choose a mentorship time",
					description: "Interactive ADPList date/time picker for mentor availability.",
				}),
		);

		this.server.registerTool(
			"book_session",
			{
				description:
					"Request an ADPList mentorship session for the authenticated user. IMPORTANT: Before calling this tool, always confirm the exact mentor, time, and note in chat with the user. Most ADPList sessions are requests awaiting mentor confirmation, not instantly confirmed meetings. Only use free mentorship sessions in v1. Pass queryID from the earlier search_mentors result when available for booking attribution. MCP Apps hosts can render the attached session confirmation card. When the widget renders, keep your chat text to about one line and never echo the raw JSON result in prose.",
				_meta: appToolMeta(UI_RESOURCES.sessionCards),
				annotations: {
					title: "Book ADPList session",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
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
			async (input) =>
				this.toolResponse(() => bookSession(this.env, this.props, input), {
					resourceUri: UI_RESOURCES.sessionCards,
					name: "adplist-session-confirmation",
					title: "ADPList session request",
					description: "Interactive ADPList session request confirmation card.",
				}),
		);

		this.server.registerTool(
			"list_my_sessions",
			{
				description:
					"List the authenticated user's ADPList mentorship sessions. Defaults to upcoming sessions to keep chat context compact. Use scope: 'past' only when the user asks for previous sessions, and scope: 'all' only when they explicitly ask for everything. Returns every session the user is part of, whether they booked it as the mentee or are the mentor. Each item includes both the mentor and the mentee (name, slug, title, organization, profile photo when available), the scheduled time, duration, status, source, the booking_notes and booking_questions exchanged when the session was booked, and the dashboard URL — frame each session relative to whichever of the two parties is the user you are helping. MCP Apps hosts should render the attached clean session cards. When the widget renders, keep your chat text to about one line and never echo the raw JSON result in prose.",
				_meta: appToolMeta(UI_RESOURCES.sessionCards),
				annotations: {
					title: "List my ADPList sessions",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
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
			async (input) =>
				this.toolResponse(() => listMySessions(this.env, this.props, input), {
					resourceUri: UI_RESOURCES.sessionCards,
					name: "adplist-session-cards",
					title: "ADPList session cards",
					description: "Interactive ADPList mentorship session cards.",
				}),
		);

		this.server.registerTool(
			"list_journals",
			{
				description:
					"List the authenticated user's ADPList AI-generated post-session summaries from past mentorship sessions. Use this when the user asks what they discussed, learned, committed to, or covered with mentors across past sessions. These are not user-authored free-form journals, so never frame results as 'what you wrote in your journal'; say 'your session summary covered' or 'you and your mentor discussed'. Returns compact metadata by default. Set with_content: true only when the user needs the actual structured summary fields in the list.",
				annotations: {
					title: "List ADPList session summaries",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
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
				annotations: {
					title: "Read ADPList session summary",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
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
			"list_mentor_requests",
			{
				description:
					"List booking requests awaiting your confirmation as a mentor. These are sessions where mentees have requested to book with you and you need to accept or decline. Use this when you want to see incoming requests that need your action. Each request includes the mentee's profile, scheduled time, and booking notes.",
				annotations: {
					title: "List mentor booking requests",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
				inputSchema: {
					limit: z
						.number()
						.int()
						.min(1)
						.max(50)
						.optional()
						.describe("Defaults to 20; max 50."),
				},
			},
			async (input) =>
				this.toolResponse(() => listMentorRequests(this.env, this.props, input)),
		);

		this.server.registerTool(
			"respond_to_mentor_request",
			{
				description:
					"Accept or decline a mentee's booking request as a mentor. IMPORTANT: Before calling this tool, always confirm the action with the user in chat (for example: 'Accept the request from Sarah for Tuesday 3 PM?'). When declining, you can optionally include a message the mentee will see. The mentee is notified of your decision.",
				annotations: {
					title: "Accept or decline mentor booking request",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
				inputSchema: {
					session_id: z
						.string()
						.trim()
						.min(1)
						.describe("Session ID from list_mentor_requests."),
					action: z
						.enum(["accept", "decline"])
						.describe("Whether to accept or decline the booking request."),
					message: z
						.string()
						.trim()
						.min(1)
						.max(1000)
						.optional()
						.describe("Optional message to the mentee (e.g. reason for declining, a warm welcome)."),
				},
			},
			async (input) =>
				this.toolResponse(() => respondToMentorRequest(this.env, this.props, input)),
		);

		this.server.registerTool(
			"reschedule_as_mentor",
			{
				description:
					"As a mentor, propose a reschedule for a session to a new time. IMPORTANT: Before calling this tool, always confirm the new time with the user in chat. The mentee will be notified and must confirm the new time. After rescheduling, use list_availability to find viable new slots.",
				annotations: {
					title: "Reschedule a session as mentor",
					readOnlyHint: false,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: true,
				},
				inputSchema: {
					session_id: z
						.string()
						.trim()
						.min(1)
						.describe("Session ID from list_mentor_requests or list_my_sessions."),
					new_slot_iso: z
						.string()
						.trim()
						.min(1)
						.describe("Proposed new UTC ISO 8601 datetime for the session."),
					message: z
						.string()
						.trim()
						.min(1)
						.max(1000)
						.optional()
						.describe("Optional message to the mentee explaining the reschedule."),
				},
			},
			async (input) =>
				this.toolResponse(() => rescheduleAsMentor(this.env, this.props, input)),
		);

		this.server.registerTool(
			"list_my_mentees",
			{
				description:
					"List the mentees you have sessions with as a mentor. Use this to see who you mentor, their roles and organizations, and their profiles. This is a people directory — it returns unique mentees across all your sessions (past and upcoming), not individual session records.",
				annotations: {
					title: "List my mentees",
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: true,
				},
			},
			async () => this.toolResponse(() => listMyMentees(this.env, this.props)),
		);

		this.server.registerTool(
			"cancel_session",
			{
				description:
					"Cancel an ADPList mentorship session for the authenticated user. IMPORTANT: This changes the user's booking and notifies the mentor. Before calling this tool, always confirm the exact session, mentor, and scheduled time with the user in chat (for example: 'Just to confirm, cancel your Tuesday 3 PM session with Sarah? Mentors get notified.'). Pass an optional reason string so the mentor knows why. If the user asks to reschedule, call cancel_session only after confirmation, then use list_availability and book_session for the new slot; there is no native reschedule_session tool in v1.",
				annotations: {
					title: "Cancel ADPList session",
					readOnlyHint: false,
					destructiveHint: true,
					idempotentHint: false,
					openWorldHint: true,
				},
				inputSchema: {
					session_id: z
						.string()
						.trim()
						.min(1)
						.describe("Session ID returned by list_my_sessions or book_session."),
					user_confirmed: z
						.literal(true)
						.describe(
							"Set to true only after explicitly confirming the exact session, mentor, and scheduled time with the user in chat, and asking for an optional cancellation reason.",
						),
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
	const freshProps = await ensureFreshAdplistProps(env, props);
	if (freshProps && freshProps !== props && props) Object.assign(props, freshProps);
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
