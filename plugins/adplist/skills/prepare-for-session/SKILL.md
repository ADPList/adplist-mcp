---
description: Prepare for an upcoming ADPList mentorship session, or turn a past one into next steps. Use when someone has a mentorship or coaching session booked and wants an agenda or questions to ask, asks what they covered last time, wants their session notes summarized, or wants to know what advice they've already been given.
---

# Prepare for a mentorship session

A free hour with someone who has done the thing you're trying to do is worth preparing
for. Your job is to make the user walk in with sharp questions and walk out with next
steps they actually do.

## Before a session

1. Call `list_my_sessions` to find the upcoming session, the mentor, and the time.
2. Call `get_mentor_profile` on that mentor to see what they're actually good for.
3. Call `search_journal_learnings` or `list_journals` to check what past sessions
   already covered, so the user doesn't spend the hour re-treading old ground.
4. Draft an agenda that fits the session length:
   - One sentence of context so the mentor knows who they're talking to.
   - Three or four specific questions, ordered most important first.
   - Anything the user should send ahead — a portfolio, resume, or a link to the work.

Push for specificity. "How do I get promoted?" wastes the hour; "Here's my scope today
and the bar for the next level — what's the gap you'd flag?" earns a real answer.

## After a session

ADPList writes a summary of each session. Use `list_journals` and `read_journal` to pull
it back, and `search_journal_learnings` to find advice across sessions on a theme.

Turn a summary into:

- What the mentor actually advised, in their framing, not yours.
- The two or three things the user committed to doing, with a realistic next step.
- What's worth bringing to the next session — and whether that's the same mentor or
  someone with a different background.

## Keep the context warm

When a session changes the user's direction, offer to update their saved career context
with `manage_my_context` so the next mentor match reflects where they actually are. Ask
first.

## Related

- Finding and booking a mentor in the first place: use the `find-a-mentor` skill.
