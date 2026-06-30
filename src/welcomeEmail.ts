const SENDGRID_MAIL_SEND_URL = "https://api.sendgrid.com/v3/mail/send";
const DEFAULT_FROM_EMAIL = "felix@adplist.org";
const DEFAULT_FROM_NAME = "Felix Lee";
const DEFAULT_SUBJECT = "You just connected ADPList to Claude 🎉";

type WelcomeEmailInput = {
	userId: string;
	email: string;
	firstName?: string;
	accessToken?: string;
	origin?: string;
	nowSeconds?: number;
};

type WelcomeProfileRow = {
	welcome_email_sent_at: number | null;
};

export async function sendWelcomeEmailOnce(env: Env, input: WelcomeEmailInput): Promise<void> {
	try {
		if (!input.email) return;
		if (!env.SENDGRID_API_KEY) {
			console.warn(JSON.stringify({ event: "welcome_email_missing_sendgrid_config" }));
			return;
		}

		const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
		const existing = await env.PROFILE_DB.prepare(
			"SELECT welcome_email_sent_at FROM user_mcp_welcome WHERE user_id = ?",
		)
			.bind(input.userId)
			.first<WelcomeProfileRow>();
		if (existing?.welcome_email_sent_at) return;

		const claimed = await claimWelcomeEmailSend(env, input.userId, nowSeconds);
		if (!claimed) return;

		const firstName = await fetchWelcomeFirstName(env, input.accessToken).catch(() => "");
		try {
			await triggerSendGridWelcomeEmail(env, {
				email: input.email,
				firstName: firstName || input.firstName || "",
				gifUrl: welcomeEmailGifUrl(env, input.origin),
			});
		} catch (error) {
			await releaseWelcomeEmailClaim(env, input.userId);
			console.warn(
				JSON.stringify({ event: "welcome_email_send_failed", error: String(error) }),
			);
			return;
		}

		try {
			await markWelcomeEmailSent(env, input.userId, Math.floor(Date.now() / 1000));
		} catch (error) {
			console.warn(
				JSON.stringify({
					event: "welcome_email_mark_sent_failed_after_send",
					error: String(error),
				}),
			);
		}
	} catch (error) {
		console.warn(
			JSON.stringify({ event: "welcome_email_unexpected_error", error: String(error) }),
		);
	}
}

async function claimWelcomeEmailSend(
	env: Env,
	userId: string,
	nowSeconds: number,
): Promise<boolean> {
	await env.PROFILE_DB.prepare(
		`INSERT OR IGNORE INTO user_mcp_welcome (user_id)
		 VALUES (?)`,
	)
		.bind(userId)
		.run();

	const result = await env.PROFILE_DB.prepare(
		`UPDATE user_mcp_welcome
		 SET welcome_email_in_flight_at = ?
		 WHERE user_id = ?
		   AND welcome_email_sent_at IS NULL
		   AND welcome_email_in_flight_at IS NULL`,
	)
		.bind(nowSeconds, userId)
		.run();

	return (result.meta.changes ?? 0) > 0;
}

type SendGridWelcomeEmailInput = {
	email: string;
	firstName: string;
	gifUrl: string;
};

async function fetchWelcomeFirstName(env: Env, accessToken: string | undefined): Promise<string> {
	if (!accessToken || !env.AUTH_SERVICE_URL) return "";
	const response = await fetch(new URL("/users/profile/me", env.AUTH_SERVICE_URL).toString(), {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		signal: AbortSignal.timeout(2000),
	});
	if (!response.ok) return "";
	return firstNameFromProfileResponse(await response.json());
}

function firstNameFromProfileResponse(response: unknown): string {
	const data = asRecord((response as { data?: unknown } | undefined)?.data);
	const profile = asRecord(data.profile);
	const candidates = [
		data.firstName,
		data.first_name,
		data.givenName,
		data.fullName,
		data.name,
		profile.firstName,
		profile.first_name,
		profile.givenName,
		profile.fullName,
		profile.name,
	];
	for (const candidate of candidates) {
		const firstName = firstNameFromValue(candidate);
		if (firstName) return firstName;
	}
	return "";
}

function firstNameFromValue(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().split(/\s+/)[0] ?? "";
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

async function triggerSendGridWelcomeEmail(
	env: Env,
	input: SendGridWelcomeEmailInput,
): Promise<void> {
	const response = await fetch(SENDGRID_MAIL_SEND_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.SENDGRID_API_KEY ?? ""}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			personalizations: [{ to: [{ email: input.email }] }],
			from: { email: welcomeEmailFromEmail(env), name: welcomeEmailFromName(env) },
			reply_to: { email: welcomeEmailFromEmail(env), name: welcomeEmailFromName(env) },
			subject: DEFAULT_SUBJECT,
			content: [
				{ type: "text/plain", value: welcomeEmailText(input.firstName) },
				{ type: "text/html", value: welcomeEmailHtml(input.firstName, input.gifUrl) },
			],
		}),
	});
	if (!response.ok) {
		throw new Error(`SendGrid welcome email failed: HTTP ${response.status}`);
	}
}

function welcomeEmailText(firstName: string): string {
	return `Hey ${welcomeGreetingName(firstName)},


You're in. ADPList is now connected to Claude, which means you can book a mentor without ever leaving your chat.

 

Try this first: ask Claude something like
"Book me a mentor who can help me prep for a product design interview."

 

It'll find the right expert from 40K+ mentors and set up the call for you.

 

A few other things to try:

"Find me a mentor who made the jump from designer to PM."
"Summarize what I've learned across my ADPList sessions."
 

That's it. You're set. Reply to this email if anything feels off, it comes straight to me.


Thanks!

Felix`;
}

function welcomeEmailHtml(firstName: string, gifUrl: string): string {
	return `<!doctype html>
<html>
	<body style="margin:0;padding:0;background:#ffffff;color:#1f2328;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;">
		<div style="max-width:640px;margin:0 auto;padding:32px 24px;">
			<p>Hey ${escapeHtml(welcomeGreetingName(firstName))},</p>
			<p>You're in. ADPList is now connected to Claude, which means you can book a mentor without ever leaving your chat.</p>
			<p>Try this first: ask Claude something like<br><strong>&ldquo;Book me a mentor who can help me prep for a product design interview.&rdquo;</strong></p>
			<p>It'll find the right expert from 40K+ mentors and set up the call for you.</p>
			<p><img src="${escapeHtml(gifUrl)}" alt="Booking an ADPList mentor from Claude" style="display:block;width:100%;max-width:560px;height:auto;border:0;border-radius:8px;margin:18px 0 24px;" /></p>
			<p>A few other things to try:</p>
			<p>&ldquo;Find me a mentor who made the jump from designer to PM.&rdquo;<br>&ldquo;Summarize what I've learned across my ADPList sessions.&rdquo;</p>
			<p>That's it. You're set. Reply to this email if anything feels off, it comes straight to me.</p>
			<p>Thanks!</p>
			<p>Felix</p>
		</div>
	</body>
</html>`;
}

function welcomeGreetingName(firstName: string): string {
	return firstName.trim() || "there";
}

function welcomeEmailFromEmail(env: Env): string {
	return env.WELCOME_EMAIL_FROM_EMAIL || DEFAULT_FROM_EMAIL;
}

function welcomeEmailFromName(env: Env): string {
	return env.WELCOME_EMAIL_FROM_NAME || DEFAULT_FROM_NAME;
}

function welcomeEmailGifUrl(env: Env, origin: string | undefined): string {
	if (env.WELCOME_EMAIL_GIF_URL) return env.WELCOME_EMAIL_GIF_URL;
	const baseUrl = origin || "https://mcp.adplist.org";
	return `${baseUrl.replace(/\/$/, "")}/assets/claude-mcp.gif`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

async function markWelcomeEmailSent(env: Env, userId: string, sentAt: number): Promise<void> {
	await env.PROFILE_DB.prepare(
		`UPDATE user_mcp_welcome
		 SET welcome_email_sent_at = ?, welcome_email_in_flight_at = NULL
		 WHERE user_id = ?`,
	)
		.bind(sentAt, userId)
		.run();
}

async function releaseWelcomeEmailClaim(env: Env, userId: string): Promise<void> {
	await env.PROFILE_DB.prepare(
		`UPDATE user_mcp_welcome
		 SET welcome_email_in_flight_at = NULL
		 WHERE user_id = ? AND welcome_email_sent_at IS NULL`,
	)
		.bind(userId)
		.run();
}
