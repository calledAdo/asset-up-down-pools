---
name: handoffprotocol
description: >-
  At the START of essentially every coding or multi-step session, consult this FIRST, before
  doing anything else: find or create `llmtimeline/` at the repository root, read its current
  state, and acknowledge to the user in one line where things stand. This maintains
  `llmtimeline/`, a portable plain-text work record, so that ANY coding agent — a later session
  of yourself or a different model (Claude, Codex, Gemini, Cursor, etc.) — can continue work
  without losing context. After the session-start check, keep the record updated after every
  task. Treat this as almost always relevant for coding work. Trigger on session start, on
  resuming or continuing work, on any job with multiple steps or that might not finish in one
  sitting, and whenever the user mentions continuity, handoffs, picking up from a previous session or another agent, or keeping a
  log/timeline of what was done. When in doubt, use it — the cost is a few lines per task and
  the payoff is never losing the thread across sessions or models.
---

# Handoff Protocol

This skill keeps a small, plain-text record of work in `llmtimeline/` at the repository root so
that any agent picking up the project — including a different model with no memory of what came
before — can orient itself in seconds and continue safely.

The record is plain Markdown with no tool dependency, so even an agent that has never seen this
skill can read and extend it by hand. This file is the decoder for that record.

## Use this at the start of every session

The first thing you do when a session begins on a project that involves coding or any
multi-step work is consult the timeline. Do not start the actual task first. Concretely:

1. Look for `llmtimeline/` at the repository root (walk up from the working directory).
2. **If it exists:** read `llmtimeline/state.md` in full, then read the newest one or two files
   in `llmtimeline/sessions/`. Then **acknowledge out loud** in one line where things stand and
   what you intend to do — e.g. *"Picking up from session 002 (Codex): tasks A and B are done,
   C is blocked on missing SMTP creds. I'll resolve C."*
3. **If it does not exist** and the job is more than a trivial one-shot: create it (see
   *Initializing*), then acknowledge — e.g. *"No timeline yet; I've started one and will track
   this work in `llmtimeline/`."*
4. Open your own session file for this sitting (see *Per session*), then proceed.

This acknowledgment is not ceremony — it confirms to the user that context carried over, and it
forces you to actually read the state before touching anything.

## What's in the folder (the primitives)

```
llmtimeline/
├── state.md                       the live snapshot — ONE file, rewritten in place
└── sessions/
    ├── 001-2026-06-20-opus.md     one file per session — APPEND-ONLY, never edited later
    ├── 002-2026-06-21-codex.md
    └── ...
```

- **state.md — the snapshot.** Always describes *now*: the goal, the cross-session task board,
  a running summary, and the next steps. There is only ever one. You **overwrite/edit it in
  place** whenever something changes. A fresh agent reads this first.
- **sessions/NNN-date-agent.md — the history.** One file per sitting of one agent. You **append**
  task blocks to your *own* file as you work and **never touch earlier session files**. These
  carry the *why* — reasoning, decisions, dead ends, gotchas — in chronological order.
- **task** — a unit of work, recorded with intent → status → outcome → files → decisions →
  gotchas → next.
- **status vocabulary** — use exactly these words, and these board markers:
  `[ ] pending` · `[~] in_progress` · `[!] blocked` · `[x] done` · `[-] abandoned`.

The split exists because "what's true now" and "what happened over time" need opposite rules.
The snapshot must be rewritten to stay current; the history must never be rewritten to stay
trustworthy. One file can't be both — so `state.md` mutates and `sessions/` only grows.

## Initializing (no `llmtimeline/` yet)

Create the folder and the two pieces:

1. `llmtimeline/state.md` from the State template below. Fill in the Goal and an initial task
   board from what the user wants done. Keep the self-describing top line verbatim — it's what
   lets a tool or human that lacks this skill still understand the folder.
2. `llmtimeline/sessions/` containing your first session file (see *Per session*).

## Per session

Pick your session file name: `sessions/NNN-YYYY-MM-DD-agent.md`, where `NNN` is the next number
after the highest existing one (zero-padded, e.g. `003`), the date is today, and `agent` is a
short slug for who you are (`opus`, `codex`, `gemini`, …). Create it from the Session template
below with the header filled in. As the session proceeds, append one task block per unit of work.
Never edit a previous session's file.

## Before each task

In `state.md`, set the task to `[~] in_progress` and write your **intent** — what you're about
to do and why. This one line is the crash safety net: if your session ends mid-task, the next
agent sees what was attempted instead of finding a silent gap.

## After each task (the core loop)

Do both, every time a unit of work finishes or is stopped:

1. **Append a block to your session file** using the Session template's task block. Fill in
   status, intent, did, files, and — importantly — decisions and gotchas. Those two are what let
   the next agent *interpret* your work rather than reverse-engineer it. Append at the bottom;
   never rewrite earlier blocks.
2. **Update `state.md`:**
   - Flip the task's marker (`[x]`, or `[!]`/`[-]` with the reason inline).
   - Refresh the **Summary** so it reads as an accurate, complete picture *as of now* — don't
     save summarizing for the final task. If the job dies at task 3 of 4, the summary must still
     be coherent on its own.
   - Rewrite **Next** to be concrete for a stranger: name the file, function, or command. "Continue
     the work" is useless; "implement `confirm_reset()` in `api/auth.py`, mirror `request_reset()`
     above it" is a real handoff.
   - Update the timestamp + agent on the header line.

## Conventions that keep the record trustworthy

- **state.md is overwritten; session files are append-only.** Never rewrite history; never let
  the snapshot go stale. Mixing these up corrupts the record.
- **Always-current summary.** Robustness comes from `state.md` being correct at every pause
  point, not just at the end.
- **Self-identify on every write.** Name the agent in the session header and the `state.md`
  header line. Cross-model handoffs depend on knowing who did what.
- **ISO 8601 timestamps** (e.g. `2026-06-20T16:10Z`) — universally parseable.
- **Record decisions and what you did NOT do.** Settled choices shouldn't be re-litigated;
  half-finished work and known gaps belong in `gotchas` and in `Next`.
- **Plain Markdown only.** Anything you write, the next agent must be able to read and extend by
  hand. Don't invent formats not described here.

---

## Template: `state.md`

```markdown
> llmtimeline · cross-agent work record. `state.md` is the live snapshot — rewrite it in place. `sessions/` is append-only history — never edit past files. Any agent: read this file and the newest `sessions/` entries before starting.

# Project State — updated <ISO timestamp> by <agent> (session <NNN>)

## Goal
<1–3 sentences; what "done" means for the whole job>

## Tasks
<markers: [ ] pending · [~] in_progress · [!] blocked · [x] done · [-] abandoned>
- [ ] <task>
- [ ] <task>

## Summary
<always-current narrative of what has actually been accomplished so far>

## Next
<concrete and actionable for a fresh agent: name files, functions, commands.
if work stopped mid-task, say exactly where and what to do next>

## Notes
<durable decisions and their rationale, conventions, gotchas, known gaps>
```

## Template: `sessions/NNN-YYYY-MM-DD-agent.md`

```markdown
# Session <NNN> · <YYYY-MM-DD> · <agent name>

<!-- Append one block per task as you finish or stop it. Never edit blocks above. -->

## <task title>
status: <done | in_progress | blocked | abandoned>
intent: <what you set out to do and why>
did: <what actually happened — the substance of the work>
files: <paths created / modified / deleted>
decisions: <choices made and the reasoning>      (omit the line if none)
gotchas: <surprises, warnings, anything unfinished>  (omit the line if none)
next: <what should happen next as a result>
```

### Example of a filled task block

```markdown
## Task B — request/confirm endpoints
status: in_progress
intent: add POST /reset/request and POST /reset/confirm.
did: wrote /reset/request fully; /reset/confirm is a stub.
files: api/auth.py
decisions: defer rate-limiting on /request to a later task.
gotchas: confirm is NOT implemented — do not assume it works.
next: implement /reset/confirm — validate token + expiry, then set the new password.
```