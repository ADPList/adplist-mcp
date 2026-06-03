export type McpErrorCode =
	| "AUTH_EXPIRED"
	| "SLOT_GONE"
	| "RATE_LIMITED"
	| "UPSTREAM_UNAVAILABLE"
	| "CONFIG_ERROR"
	| "VALIDATION_ERROR"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "UNKNOWN_ERROR";

export type StructuredMcpError = {
	error: {
		code: McpErrorCode;
		message: string;
		retryable: boolean;
		user_action?: string;
		details?: Record<string, unknown>;
	};
};

export function formatToolError(error: unknown): StructuredMcpError {
	const message = errorMessage(error);
	const lower = message.toLowerCase();
	const status = httpStatusFromMessage(message);

	if (
		lower.includes("auth_expired") ||
		lower.includes("requires an authenticated adplist user") ||
		status === 401
	) {
		return structuredError(
			"AUTH_EXPIRED",
			"Your ADPList sign-in has expired or is missing.",
			false,
			"Ask the user to reconnect ADPList in this MCP host, then retry the request.",
		);
	}

	if (lower.includes("selected slot is no longer available")) {
		return structuredError(
			"SLOT_GONE",
			"That mentorship slot is no longer available.",
			false,
			"Call list_availability again and ask the user to choose a fresh slot before booking.",
		);
	}

	if (status === 429 || lower.includes("rate limit") || lower.includes("too many")) {
		return structuredError(
			"RATE_LIMITED",
			"ADPList is temporarily rate limiting this request.",
			true,
			"Wait briefly, then retry. If the user is present, explain that ADPList needs a short cooldown.",
			{ http_status: status ?? 429 },
		);
	}

	if (status === 403 || lower.includes("not associated with the authenticated user")) {
		return structuredError(
			"FORBIDDEN",
			"This ADPList item is not available to the signed-in user.",
			false,
			"Do not retry automatically. Ask the user to choose an item from their own ADPList results.",
			status ? { http_status: status } : undefined,
		);
	}

	if (status === 404) {
		return structuredError(
			"NOT_FOUND",
			"ADPList could not find that item.",
			false,
			"Refresh the relevant list, then ask the user to choose from the current results.",
			{ http_status: status },
		);
	}

	if (status && status >= 500) {
		return structuredError(
			"UPSTREAM_UNAVAILABLE",
			"ADPList is temporarily unavailable for this request.",
			true,
			"Retry once after a short pause. If it fails again, tell the user ADPList is having trouble and try later.",
			{ http_status: status },
		);
	}

	if (lower.includes("is not configured")) {
		return structuredError(
			"CONFIG_ERROR",
			"The ADPList MCP server is missing required configuration.",
			false,
			"Report this to ADPList support or the MCP server operator; user retries will not fix it.",
		);
	}

	if (isValidationMessage(lower)) {
		return structuredError(
			"VALIDATION_ERROR",
			message,
			false,
			"Fix the tool input and retry only after confirming the corrected value with the user when needed.",
		);
	}

	return structuredError(
		"UNKNOWN_ERROR",
		"ADPList MCP could not complete the request.",
		false,
		"Explain that the request failed unexpectedly and ask the user to retry or try a narrower request.",
		{ cause: message },
	);
}

export async function toolResponse<T>(
	run: () => Promise<T>,
	app?: {
		resourceUri: string;
		name: string;
		title: string;
		description: string;
		shouldRender?: (result: T) => boolean;
	},
) {
	try {
		const result = await run();
		const renderApp = app && (app.shouldRender ? app.shouldRender(result) : true);
		return {
			structuredContent: isRecord(result) ? result : undefined,
			content: [
				{ type: "text" as const, text: JSON.stringify(result) },
				...(renderApp
					? [
							{
								type: "resource_link" as const,
								uri: app.resourceUri,
								name: app.name,
								title: app.title,
								description: app.description,
								mimeType: "text/html;profile=mcp-app",
								annotations: { audience: ["user" as const], priority: 1 },
							},
						]
					: []),
			],
		};
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify(formatToolError(error)) }],
			isError: true,
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function structuredError(
	code: McpErrorCode,
	message: string,
	retryable: boolean,
	userAction?: string,
	details?: Record<string, unknown>,
): StructuredMcpError {
	return {
		error: {
			code,
			message,
			retryable,
			...(userAction ? { user_action: userAction } : {}),
			...(details ? { details } : {}),
		},
	};
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error.trim()) return error.trim();
	return "Unknown error";
}

function httpStatusFromMessage(message: string): number | undefined {
	const match = /HTTP\s+(\d{3})/i.exec(message);
	if (!match) return undefined;
	const status = Number(match[1]);
	return Number.isFinite(status) ? status : undefined;
}

function isValidationMessage(lower: string): boolean {
	return (
		lower.includes("must be") ||
		lower.includes(" is required") ||
		lower.includes("requires an updates object") ||
		lower.includes("paid sessions are out of scope")
	);
}
