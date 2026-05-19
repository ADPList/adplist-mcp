import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import app from "./app";
import { MCP_SCOPES } from "./config";
import type { McpUserProps } from "./types";

export class MyMCP extends McpAgent<Env, unknown, McpUserProps> {
	server = new McpServer({
		name: "adplist-mcp",
		version: "0.1.0",
	});

	async init() {
		// M1 intentionally exposes no tools. Tool implementation starts in M2.
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
