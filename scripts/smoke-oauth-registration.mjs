const baseUrl = (process.env.MCP_SMOKE_BASE_URL || "https://mcp.adplist.org").replace(/\/+$/, "");

async function main() {
	await expectOk(`${baseUrl}/health`, "health");

	const metadata = await expectJson(
		`${baseUrl}/.well-known/oauth-authorization-server`,
		"OAuth discovery",
	);
	if (metadata.issuer !== baseUrl) {
		throw new Error(`OAuth discovery issuer mismatch: expected ${baseUrl}, got ${metadata.issuer}`);
	}
	if (metadata.registration_endpoint !== `${baseUrl}/oauth/register`) {
		throw new Error(`OAuth registration endpoint mismatch: ${metadata.registration_endpoint}`);
	}

	const registration = await fetch(`${baseUrl}/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: `adplist-mcp-smoke-${Date.now()}`,
			redirect_uris: ["http://127.0.0.1:1455/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: "profile:read tools:read",
		}),
	});
	const registrationBody = await registration.text();
	if (registration.status !== 201) {
		throw new Error(
			`OAuth dynamic client registration failed: HTTP ${registration.status} ${registrationBody}`,
		);
	}

	const client = JSON.parse(registrationBody);
	if (typeof client.client_id !== "string" || client.client_id.length === 0) {
		throw new Error("OAuth registration response did not include client_id");
	}

	console.log(`OAuth registration smoke passed for ${baseUrl}`);
}

async function expectOk(url, label) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
}

async function expectJson(url, label) {
	const response = await fetch(url);
	const body = await response.text();
	if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status} ${body}`);
	return JSON.parse(body);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
