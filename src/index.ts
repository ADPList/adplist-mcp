import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import app from "./app";
import { MCP_SCOPES } from "./config";
import { searchMentors } from "./searchMentors";
import type { McpUserProps } from "./types";

export class MyMCP extends McpAgent<Env, unknown, McpUserProps> {
	server = new McpServer({
		name: "adplist-mcp",
		version: "0.1.0",
	});

	async init() {
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
