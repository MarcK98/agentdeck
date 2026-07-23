# AgentDeck UX audit & improvement plan (SPWN-17)

Date: 2026-07-21 · Branch: `ux-overhaul` (off `phase-6-mobile`)
Benchmark: **Discord, enhanced with Claude dev features.** Audit ran as 4 parallel passes: live browser walkthrough of the desktop app (mock harness + screenshots in `deliverables/claude-spawn/SPWN-17/audit/`), code-level desktop audit, code-level mobile audit, and installation of two UX-review skills for future audits (`~/.claude/skills/design-audit`, `~/.claude/skills/ux-audit`).

## Verdict

The daemon side is solid — chats/threads/tickets/messages already persist in SQLite (`agentdeck.db`, cursor pagination built in). The renderer layer is where the Discord feel breaks down:

- **No motion layer.** 5 keyframes in the entire desktop CSS; views, modals, sheets, toasts and the palette all hard-pop. Hover changes are instant, list rows have no `:active` state.
- **Chat is plain text.** Agent output (mostly markdown + code) renders as raw `<pre>`. No grouping, no timestamps on text rows, no day dividers, forced scroll-to-bottom on every streamed token, drafts leak across threads and die on view switch, history silently truncates at 200 messages.
- **No unread model.** A finished agent reply in an unfocused thread produces zero badge anywhere — the core Discord mechanic.
- **Views are disposable.** Every nav click unmounts the view: scroll positions, board state, usage range, settings category all reset. No back, no state restore on relaunch.
- **Mobile is a prototype shell.** Hand-rolled navigation (no transitions, Android back exits app), zero local persistence (relay unreachable = permanent spinners), chat is a full-re-render ScrollView, no press feedback or haptics, no push/deep links.

## Execution plan

### Phase 1 — Motion & feedback layer (desktop)
Motion tokens (100–150 ms ease) + shared overlay animation; fade+scale on sheet/modal/palette, slide-up toast; `:active` + eased hover on nav items, thread rows, board cards, palette results, ctx items; spinners (existing `.spin`) + in-flight disable on delegate/approve/send/comment (kills approval double-fire).

### Phase 2 — Chat core (desktop)
Markdown + syntax-highlighted code blocks with copy button; Discord-style grouping (same role ≤5 min), hover timestamps, day dividers; scroll anchoring — auto-follow only when at bottom, "jump to latest" pill with new-message count; per-thread drafts in localStorage, draft survives send failure (try/catch + restore); "load older" pagination on scroll-top (DB already supports `before`); memoized rows + isolated live-stream tail (stops full-list reconcile per token); autosize composer; seed `busyThreads` from `listActiveThreads.running` so a reload mid-run still shows work.

### Phase 3 — Navigation, unread & state (desktop)
Unread model: per-thread last-read message id (localStorage) → bold+dot on threads, count badges on projects rail and Threads nav; keep views mounted (`display:none`) so switching is instant and stateful; palette indexes all threads, not just active; Escape closes every overlay (shared hook), backdrop closes on pointerdown not click (stops text-drag dismiss), focus trap + restore; shortcut gating (⌘N/⌘K don't stack overlays); persist last view/project/thread across relaunch.

### Phase 4 — Mobile foundation
react-navigation (bottom tabs + native stack): real transitions, swipe-back, Android back; **expo-sqlite local cache** — write-through tables (projects, tickets, threads, messages per thread, usage, kv), hydrate every screen instantly on cold start, reconcile on WS `ready` (fixes offline dead state); fix connect race (queue RPCs until socket open + refetch on `ready`); reconnect banner + exponential backoff; chat → inverted FlatList, memoized rows, isolated live tail, grouping + timestamps, markdown rendering, optimistic send with failure restore, scroll-to-bottom pill; Pressable pressed states + expo-haptics everywhere; pull-to-refresh; per-screen error/retry states; approval buttons disable in flight.

### Phase 5 — Consistency & polish
Unify nav naming/icons desktop↔mobile (phosphor); shared ConfirmDialog (kills `window.confirm`); shared model/effort constants (TicketModal missing xhigh/max); assorted mediums (saved-tick reset, drag rollback, hidden-window poll pause, approval thread titles).

Deferred (needs Marc): push notifications + deep links (`spawn://thread/:id`) — blocked on Apple Developer/APNs; server-side read-state sync (desktop↔mobile shared unread) — localStorage per device first.

## Appendix — full findings

Raw ranked findings from all passes live in `deliverables/claude-spawn/SPWN-17/` (desktop-code-findings.md, mobile-code-findings.md, walkthrough-findings.md + screenshots).
