---
description: Find and book the right ADPList mentor or career coach for someone's situation. Use when a user wants a mentor, a career coach, or advice from someone who has already done the thing they're trying to do — changing careers, breaking into a role, portfolio or resume review, interview prep, negotiating an offer, getting promoted, or growing as a leader in design, product, engineering, data, marketing, or founding.
---

# Find a mentor on ADPList

ADPList mentors volunteer their time, and every session is free. Your job is to turn a
vague career question into a booked conversation with the right person.

## 1. Understand the situation before searching

Do not search on the user's words alone. Ask at most two short questions to pin down
whichever of these you can't already infer:

- **Where they are now** — role, level, industry, how long they've been at it.
- **What they're trying to do next** — the specific outcome, not "grow my career".
- **What kind of help this is** — feedback on work, a career decision, interview prep,
  or an introduction to how a company or role really works.

If the user has already told you enough, skip straight to searching.

## 2. Search, then read the results properly

Call `search_mentors` with the situation described in plain language, not keywords.
"Product designer moving into a staff IC role at a large tech company" beats
"senior design mentor".

**Search once per request.** The server already overfetches, reranks, relaxes filters
that came back too strict, and tops up thin results inside that single call. Running
broad-then-narrow variations yourself doesn't find more people; it stacks another card
grid into the conversation. If the results are thin, say so and work with what came
back, or ask the user to change the brief before searching again.

Use `get_mentor_profile` to go deeper on the two or three who look closest before you
present anything. It renders no card grid, so it's free to call for several candidates
at once. A mentor is a fit when their background matches the *specific* thing the user
is trying to do — not just their job title.

When the mentor cards render, keep your own text short. Add the judgement the cards
can't carry — why *this* person, for *this* situation — rather than restating them.

## 3. Present a short, honest shortlist

Give three mentors at most. For each one, in two or three lines:

- Who they are and where they've done this work.
- The concrete reason they fit *this* user's situation.
- What this user should ask them.

Say so plainly when the matches are weak, and offer to search again with a different
angle rather than talking up a poor fit.

## 4. Book it

Once the user picks someone, call `list_availability` for their open slots and offer a
few real times in the user's own timezone. Confirm the exact date, time, and timezone
back to the user, then call `book_session`.

`book_session` and `cancel_session` both require `user_confirmed: true`. Treat that
parameter as what it is: a statement that the person has actually agreed to this exact
mentor, this exact time, **and the exact note** being sent. Booking holds an hour in a
volunteer's calendar, so the confirmation isn't a formality.

`book_session` requires a note — it's the message the mentor reads before deciding
whether to accept. Drafting one for the user is helpful; sending it without showing it
to them first is not. Put the note in front of them, in full, as part of the same
confirmation that covers the mentor and the time.

Never book a session, cancel one, or change a time without the user explicitly choosing
it first. `cancel_session` is theirs to ask for, not yours to suggest. ADPList has no
in-place reschedule for mentees — moving a time means cancelling and booking again, so
make sure the user knows that's what will happen before you start.

## 5. Make the next search better

If the user shares durable career context — their role, the transition they're making,
the companies or industries they care about — offer to save it with `manage_my_context`
so future matches start warm. Ask before saving; it's their profile, not your notes.

## Related

- Preparing for a booked session or following up afterwards: use the
  `prepare-for-session` skill.
- The user needs an ADPList account and signs in with a one-time emailed code the first
  time a tool runs. If sign-in fails, point them to https://adplist.org to create a free
  account with the same email.
