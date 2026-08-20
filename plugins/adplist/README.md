# ADPList plugin for Claude Code

Free 1:1 mentorship and career coaching from ADPList's community of 1M+ mentors, without
leaving Claude.

Tell Claude what you're working through — *"I'm a designer trying to break into
product"* — and it searches ADPList for mentors who've actually done it, shows you who
fits, finds an open slot, and books the session.

## Install

```bash
/plugin marketplace add ADPList/adplist-mcp
/plugin install adplist@adplist
```

Then run `/reload-plugins` if the install summary asks you to.

You'll need a free [ADPList account](https://adplist.org). The first time Claude uses a
tool, it opens a sign-in step: enter the email tied to your account and ADPList emails
you a one-time code. No password, no separate signup.

## What's in it

**A connection to the hosted ADPList MCP server** (`https://mcp.adplist.org/sse`) —
14 tools covering mentor search, profiles, availability, booking, cancellation, session
summaries, saved career context, and the mentor-side request queue. Nothing runs on your
machine.

**Two skills** that Claude uses on its own, no command needed:

| Skill | When Claude uses it |
| --- | --- |
| `find-a-mentor` | You want a mentor, a career coach, or advice from someone who's done the thing you're trying to do |
| `prepare-for-session` | You have a session booked and want an agenda, or want to turn a past session into next steps |

You can also invoke them directly as `/adplist:find-a-mentor` and
`/adplist:prepare-for-session`.

## Try it

- *"find me a product design mentor who's worked at a big tech company"*
- *"I'm switching from marketing to PM — who should I talk to?"*
- *"when is [mentor] free next week? book me the earliest evening slot"*
- *"help me prep for my session on Thursday"*
- *"remind me what we covered in my last mentorship session"*

## Privacy

You sign in with your own ADPList account, and Claude only ever sees what that account
can already see. Sessions you book, context you save, and summaries you read stay tied to
you. ADPList rate-limits requests per account.

Claude never books, cancels, or reschedules anything without you choosing it first.

## Source

The MCP server this plugin connects to is open source at
[ADPList/adplist-mcp](https://github.com/ADPList/adplist-mcp).
