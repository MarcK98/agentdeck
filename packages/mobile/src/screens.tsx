import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { RelayClient } from "./api";
import { C } from "./theme";
import { useCachedRpc, useSpawnEvents } from "./hooks";
import { Btn, Card, Center, Chip, Dot, ErrorBar, Field, S, fmtTok, tapHaptic } from "./ui";

const MODELS = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export { ThreadScreen } from "./thread";
export { Dot, Center } from "./ui";

// The phone surfaces: Board, Map, Runs, Approvals, Usage, Settings. Every
// list hydrates from the SQLite cache first (instant cold start, readable
// offline) and reconciles when the relay is ready.

function useRefreshControl(refresh: () => void) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <RefreshControl
      refreshing={refreshing}
      tintColor={C.n500}
      onRefresh={() => {
        setRefreshing(true);
        refresh();
        setTimeout(() => setRefreshing(false), 600);
      }}
    />
  );
}

// ── Shared bits: pickers, sheet ────────────────────────────────────────────────
function ChipPicker({
  options,
  value,
  onChange,
  allowed,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  allowed?: string[];
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      <Chip label="auto" on={value === ""} onPress={() => onChange("")} />
      {options.map((o) => (
        <Chip
          key={o}
          label={o}
          on={value === o}
          dim={allowed ? !allowed.includes(o) : false}
          onPress={() => onChange(value === o ? "" : o)}
        />
      ))}
    </View>
  );
}

function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: any[];
  value: number | "";
  onChange: (v: number | "") => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {projects.map((p) => (
        <Chip key={p.id} label={p.name} on={value === p.id} onPress={() => onChange(p.id)} />
      ))}
    </View>
  );
}

const sheetInput = {
  backgroundColor: C.n900,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: C.n800,
  color: C.text,
  paddingHorizontal: 12,
  paddingVertical: 10,
  fontSize: 14,
} as const;

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1, justifyContent: "flex-end" }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Tap outside to dismiss. */}
        <Pressable style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#000a" }} onPress={onClose} />
        <View
          style={{
            backgroundColor: C.bg,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            maxHeight: "92%",
            borderTopWidth: 1,
            borderColor: C.n800,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              padding: 16,
              borderBottomWidth: 1,
              borderColor: C.n800,
            }}
          >
            <Text style={{ color: C.text, fontSize: 16, fontWeight: "600", flex: 1 }}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={12} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
              <Text style={{ color: C.n500, fontSize: 20 }}>✕</Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 32 }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Comment thread — who wrote it and how the byline reads (mirrors the desktop
// ticket modal). A human comment wakes the team lead, which replies here.
const AUTHOR_LABEL: Record<string, string> = { human: "you", lead: "team lead", agent: "agent" };
const AUTHOR_COLOR: Record<string, string> = { human: C.accent300, lead: C.warn, agent: C.ok };
const fmtCommentTime = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

// Create / edit / delegate / delete a ticket (the board's row is source of truth).
function TicketSheet({
  client,
  projects,
  ticket,
  initialProjectId,
  onClose,
  onOpenThread,
}: {
  client: RelayClient;
  projects: any[];
  ticket: any | null;
  initialProjectId: number | "";
  onClose: () => void;
  onOpenThread: (threadId: number, title: string) => void;
}) {
  const editing = ticket != null;
  const [title, setTitle] = useState<string>(ticket?.title ?? "");
  const [body, setBody] = useState<string>(ticket?.body ?? "");
  const [projectId, setProjectId] = useState<number | "">(ticket?.project_id ?? initialProjectId ?? "");
  const [status, setStatus] = useState<string>(ticket?.status ?? "todo");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [settings, setSettings] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Full detail (comments + attachments) for an existing ticket — the board row
  // only carries the summary fields, so fetch the thread on open.
  const [detail, setDetail] = useState<any>(null);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const canDelegate = editing ? ticket.thread_id == null : true;
  const threadId: number | null = ticket?.thread_id ?? null;

  const loadDetail = useCallback(() => {
    if (!editing) return;
    client.rpc<any>("getTicket", ticket.id).then(setDetail).catch(() => {});
  }, [client, editing, ticket?.id]);
  useEffect(() => { loadDetail(); }, [loadDetail]);
  // A comment (from the lead/agent) or a status flip on THIS ticket re-fetches.
  useSpawnEvents(client, ["ticket:comment", "ticket:updated"], (ev) => {
    if (!editing) return;
    const tid = ev.payload?.ticketId ?? ev.payload?.id;
    if (tid === ticket.id) loadDetail();
  });

  const postComment = async () => {
    const text = comment.trim();
    if (!text || posting) return;
    setPosting(true);
    setError("");
    try {
      await client.rpc("addTicketComment", ticket.id, { authorKind: "human", body: text });
      setComment("");
      loadDetail();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  };

  useEffect(() => {
    if (projectId === "") return setSettings(null);
    client.rpc("getProjectSettings", projectId).then(setSettings).catch(() => setSettings(null));
  }, [client, projectId]);
  const allowed: string[] = settings?.allowedModels ?? MODELS.filter((m) => m !== "fable");

  const save = async () => {
    if (!title.trim() || projectId === "") return null;
    return editing
      ? client.rpc<any>("updateTicket", ticket.id, { title: title.trim(), body, status })
      : client.rpc<any>("createTicket", { projectId, title: title.trim(), body, status });
  };
  const run = async (fn: () => Promise<void>, tag: string) => {
    setBusy(tag);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const doSave = () => run(async () => { if (await save()) onClose(); }, "save");
  const doDelegate = () =>
    run(async () => {
      const saved = await save();
      if (!saved) return;
      const th = await client.rpc<any>("delegateTicket", saved.id, { model: model || undefined, effort: effort || undefined });
      onClose();
      onOpenThread(th.id, th.title);
    }, "delegate");
  const doDelete = () => run(async () => { await client.rpc("deleteTicket", ticket.id); onClose(); }, "delete");

  return (
    <Sheet title={editing ? `Ticket SPWN-${ticket.id}` : "New ticket"} onClose={onClose}>
      {threadId != null && (
        <Btn
          label="↗ Open thread"
          color={C.accent}
          onPress={() => {
            onClose();
            onOpenThread(threadId, title || ticket.title);
          }}
        />
      )}
      <TextInput style={[sheetInput, { fontWeight: "500" }]} placeholder="Title" placeholderTextColor={C.n600} value={title} onChangeText={setTitle} />
      <TextInput
        style={[sheetInput, { minHeight: 90, textAlignVertical: "top" }]}
        placeholder="Describe the task — the agent reads this verbatim when delegated."
        placeholderTextColor={C.n600}
        multiline
        value={body}
        onChangeText={setBody}
      />
      {!editing && (
        <Field label="Project">
          <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
        </Field>
      )}
      <Field label="Column">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {COLUMNS.map((c) => (
            <Chip key={c} label={c.replace("-", " ")} on={status === c} onPress={() => setStatus(c)} />
          ))}
        </View>
      </Field>
      {canDelegate && (
        <>
          <Field label="Model (auto = team lead right-sizes)">
            <ChipPicker options={MODELS} value={model} onChange={setModel} allowed={allowed} />
          </Field>
          <Field label="Effort">
            <ChipPicker options={EFFORTS} value={effort} onChange={setEffort} />
          </Field>
        </>
      )}
      {error !== "" && <Text style={{ color: C.err, fontSize: 12 }}>⚠ {error}</Text>}
      <View style={{ flexDirection: "row", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
        {editing && <Btn label="Delete" color={C.err} onPress={doDelete} disabled={busy !== ""} busy={busy === "delete"} />}
        <View style={{ flex: 1 }} />
        <Btn label="Save" color={C.n400} onPress={doSave} disabled={!title.trim() || projectId === "" || busy !== ""} busy={busy === "save"} />
        {canDelegate && (
          <Btn
            label={editing ? "Delegate" : "Create & delegate"}
            color={C.accent}
            onPress={doDelegate}
            disabled={!title.trim() || projectId === "" || busy !== ""}
            busy={busy === "delegate"}
          />
        )}
      </View>

      {editing && (
        <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: C.n800, paddingTop: 14, gap: 12 }}>
          <Text style={{ color: C.n500, fontSize: 11 }}>
            Comments{detail?.comments?.length ? ` · ${detail.comments.length}` : ""}
          </Text>

          {/* Compose — a human comment wakes the team lead, which acts + replies. */}
          <View style={{ gap: 8 }}>
            <TextInput
              style={[sheetInput, { minHeight: 64, textAlignVertical: "top" }]}
              placeholder="Write a comment — the team lead is notified and acts on it."
              placeholderTextColor={C.n600}
              multiline
              value={comment}
              onChangeText={setComment}
            />
            <View style={{ flexDirection: "row" }}>
              <View style={{ flex: 1 }} />
              <Btn label="Comment" color={C.accent} onPress={postComment} disabled={!comment.trim() || posting} busy={posting} />
            </View>
          </View>

          {/* Newest first — reverse a shallow copy so stored order stays put. */}
          {detail == null ? (
            <Text style={S.dim}>Loading…</Text>
          ) : detail.comments.length === 0 ? (
            <Text style={S.dim}>No comments yet.</Text>
          ) : (
            [...detail.comments].reverse().map((c: any) => (
              <View key={c.id} style={{ gap: 3 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
                  <Text style={{ color: AUTHOR_COLOR[c.author_kind] ?? C.n400, fontSize: 12, fontWeight: "600" }}>
                    {AUTHOR_LABEL[c.author_kind] ?? c.author_kind}
                  </Text>
                  <Text style={{ color: C.n600, fontSize: 10 }}>{fmtCommentTime(c.created_at)}</Text>
                </View>
                <Text style={{ color: C.text, fontSize: 14, lineHeight: 20 }} selectable>
                  {c.body}
                </Text>
              </View>
            ))
          )}
        </View>
      )}
    </Sheet>
  );
}

// Freeform delegate — a task that lands on the board and runs immediately.
function DelegateSheet({
  client,
  projects,
  onClose,
  onOpenThread,
}: {
  client: RelayClient;
  projects: any[];
  onClose: () => void;
  onOpenThread: (threadId: number, title: string) => void;
}) {
  const [task, setTask] = useState("");
  const [projectId, setProjectId] = useState<number | "">("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async () => {
    if (!task.trim() || projectId === "") return;
    setBusy(true);
    setError("");
    try {
      const th = await client.rpc<any>("delegateTask", {
        projectId,
        task: task.trim(),
        model: model || undefined,
        effort: effort || undefined,
      });
      onClose();
      onOpenThread(th.id, th.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet title="Delegate a task" onClose={onClose}>
      <TextInput
        style={[sheetInput, { minHeight: 110, textAlignVertical: "top" }]}
        placeholder="Describe a task — it lands on the board and runs immediately…"
        placeholderTextColor={C.n600}
        multiline
        autoFocus
        value={task}
        onChangeText={setTask}
      />
      <Field label="Project">
        <ProjectPicker projects={projects} value={projectId} onChange={setProjectId} />
      </Field>
      <Field label="Model">
        <ChipPicker options={MODELS} value={model} onChange={setModel} />
      </Field>
      <Field label="Effort">
        <ChipPicker options={EFFORTS} value={effort} onChange={setEffort} />
      </Field>
      {error !== "" && <Text style={{ color: C.err, fontSize: 12 }}>⚠ {error}</Text>}
      <View style={{ flexDirection: "row", marginTop: 4 }}>
        <View style={{ flex: 1 }} />
        <Btn label="Delegate" color={C.accent} onPress={send} disabled={!task.trim() || projectId === "" || busy} busy={busy} />
      </View>
    </Sheet>
  );
}

// ── Board ────────────────────────────────────────────────────────────────────
const COLUMNS = ["todo", "in-progress", "blocked", "in-review", "done"] as const;

export function BoardScreen({
  client,
  projects,
  openThread,
}: {
  client: RelayClient;
  projects: any[];
  openThread: (threadId: number, title: string) => void;
}) {
  const { data: tickets, error, refresh } = useCachedRpc<any[]>(client, "tickets", "listTickets");
  const [sheet, setSheet] = useState<null | { kind: "ticket"; ticket: any | null } | { kind: "delegate" }>(null);
  useSpawnEvents(client, ["ticket:created", "ticket:updated", "ticket:deleted", "turn:start", "turn:done"], refresh);
  const refreshControl = useRefreshControl(refresh);

  if (tickets == null && error) return <ErrorBar message={error} onRetry={refresh} />;
  if (tickets == null) return <Center spinner />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 }}>
        <Btn label="⚡ Delegate" color={C.accent} onPress={() => setSheet({ kind: "delegate" })} />
        <View style={{ flex: 1 }} />
        <Btn label="+ Ticket" color={C.n400} onPress={() => setSheet({ kind: "ticket", ticket: null })} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }} refreshControl={refreshControl}>
        {COLUMNS.map((col) => {
          const rows = tickets.filter((t) => t.status === col);
          if (!rows.length) return null;
          return (
            <View key={col} style={{ marginBottom: 18 }}>
              <Text
                style={{
                  color: col === "in-progress" ? C.ok : col === "blocked" ? C.warn : C.n500,
                  fontSize: 11,
                  letterSpacing: 1,
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                {col.replace("-", " ")} · {rows.length}
              </Text>
              {rows.map((t) => (
                <Card
                  key={t.id}
                  // Always open the ticket detail (comments + Open thread inside),
                  // mirroring the desktop card → modal flow — a delegated ticket's
                  // comment thread was otherwise unreachable on mobile.
                  onPress={() => setSheet({ kind: "ticket", ticket: t })}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                    {t.running && <Dot color={C.ok} />}
                    <Text style={[S.title, { flex: 1 }]} numberOfLines={2}>
                      {t.title}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 7, alignItems: "center" }}>
                    <Text style={S.dim}>SPWN-{t.id}</Text>
                    <Text style={S.dim}>{t.project_name}</Text>
                    {t.branch && (
                      <Text style={[S.dim, { color: C.accent300 }]} numberOfLines={1}>
                        ⎇ {String(t.branch).replace(/^ticket\//, "")}
                      </Text>
                    )}
                    {t.running && (
                      <Text style={[S.dim, { color: C.ok, marginLeft: "auto" }]}>running…</Text>
                    )}
                  </View>
                </Card>
              ))}
            </View>
          );
        })}
        {tickets.length === 0 && <Center text="Board is empty. Delegate a task or add a ticket." />}
      </ScrollView>
      {sheet?.kind === "ticket" && (
        <TicketSheet
          client={client}
          projects={projects}
          ticket={sheet.ticket}
          initialProjectId=""
          onClose={() => {
            setSheet(null);
            refresh();
          }}
          onOpenThread={openThread}
        />
      )}
      {sheet?.kind === "delegate" && (
        <DelegateSheet
          client={client}
          projects={projects}
          onClose={() => {
            setSheet(null);
            refresh();
          }}
          onOpenThread={openThread}
        />
      )}
    </View>
  );
}

// ── Approvals ────────────────────────────────────────────────────────────────
export function ApprovalsScreen({ client }: { client: RelayClient }) {
  const { data: pending, error, refresh } = useCachedRpc<any[]>(client, "approvals", "listApprovals");
  const [answering, setAnswering] = useState<number | null>(null);
  const [answerError, setAnswerError] = useState("");
  useSpawnEvents(client, ["approval:request", "approval:resolved"], refresh);
  const refreshControl = useRefreshControl(refresh);

  const answer = async (id: number, allow: boolean) => {
    if (answering != null) return;
    setAnswering(id);
    setAnswerError("");
    try {
      await client.rpc("resolveApproval", id, allow);
    } catch (e) {
      setAnswerError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnswering(null);
      refresh();
    }
  };

  if (pending == null && error) return <ErrorBar message={error} onRetry={refresh} />;
  if (pending == null) return <Center spinner />;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }} refreshControl={refreshControl}>
      {answerError !== "" && <Text style={{ color: C.err, fontSize: 12, marginBottom: 8 }}>⚠ {answerError}</Text>}
      {pending.map((a) => (
        <View key={a.id} style={[S.card, { borderColor: C.warn, borderWidth: 1 }]}>
          <Text style={S.title}>✋ {a.tool}</Text>
          <Text style={[S.dim, { marginTop: 6 }]} numberOfLines={6}>
            {JSON.stringify(a.input, null, 2)}
          </Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
            <Btn label="Allow" color={C.ok} onPress={() => answer(a.id, true)} disabled={answering != null} busy={answering === a.id} />
            <Btn label="Deny" color={C.err} onPress={() => answer(a.id, false)} disabled={answering != null} />
          </View>
        </View>
      ))}
      {pending.length === 0 && <Center text="Nothing waiting on you." />}
    </ScrollView>
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────
const RunRow = React.memo(function RunRow({
  t,
  liveTokens,
  openThread,
}: {
  t: any;
  liveTokens: number | null;
  openThread: (threadId: number, title: string) => void;
}) {
  return (
    <Card onPress={() => openThread(t.id, t.title)}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Dot color={t.running ? C.ok : C.n600} />
        <Text style={[S.title, { flex: 1 }]} numberOfLines={1}>
          {t.title}
        </Text>
        {t.running && liveTokens != null && liveTokens > 0 && (
          <Text style={{ color: C.ok, fontSize: 12 }}>⚡ {fmtTok(liveTokens)}</Text>
        )}
      </View>
      <Text style={[S.dim, { marginTop: 4 }]}>
        {t.project_name} · {t.kind}
        {t.branch ? ` · ${String(t.branch).replace(/^ticket\//, "")}` : ""}
      </Text>
    </Card>
  );
});

export function RunsScreen({
  client,
  openThread,
}: {
  client: RelayClient;
  openThread: (threadId: number, title: string) => void;
}) {
  const { data: runs, error, refresh } = useCachedRpc<any[]>(client, "runs", "listActiveThreads");
  const [live, setLive] = useState<Map<number, number>>(new Map());
  useSpawnEvents(client, ["thread:created", "thread:updated", "turn:start", "turn:done"], refresh);
  useSpawnEvents(client, ["turn:usage"], (ev) =>
    setLive((prev) => new Map(prev).set(ev.payload.threadId, ev.payload.liveTokens))
  );
  useSpawnEvents(client, ["turn:done"], (ev) =>
    setLive((prev) => {
      const next = new Map(prev);
      next.delete(ev.payload.threadId);
      return next;
    })
  );
  const refreshControl = useRefreshControl(refresh);

  if (runs == null && error) return <ErrorBar message={error} onRetry={refresh} />;
  if (runs == null) return <Center spinner />;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }} refreshControl={refreshControl}>
      {runs.map((t) => (
        <RunRow key={t.id} t={t} liveTokens={live.get(t.id) ?? t.liveTokens ?? null} openThread={openThread} />
      ))}
      {runs.length === 0 && <Center text="Nothing active." />}
    </ScrollView>
  );
}

// Provider labels for the MCP section in Settings. Phone flips servers on/off
// (a non-secret write); connecting itself stays on desktop (host browser /
// clipboard / file picker, and those RPCs are relay-denied).
const PROVIDER_LABEL: Record<string, string> = {
  gcloud: "Google Cloud",
  supabase: "Supabase",
  neon: "Neon",
  firebase: "Firebase",
  apple: "App Store Connect",
  expo: "Expo",
  railway: "Railway",
  netlify: "Netlify",
  heroku: "Heroku",
  vercel: "Vercel",
};

// ── Live map (native grouped: team lead → projects → running threads) ──────────
export function MapScreen({
  client,
  openThread,
}: {
  client: RelayClient;
  openThread: (threadId: number, title: string) => void;
}) {
  const { data: map, error, refresh } = useCachedRpc<any>(client, "map", "getMap");
  useEffect(() => {
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);
  useSpawnEvents(client, ["thread:created", "thread:updated", "turn:start", "turn:done"], refresh);
  const refreshControl = useRefreshControl(refresh);

  if (map == null && error) return <ErrorBar message={error} onRetry={refresh} />;
  if (map == null) return <Center spinner />;
  const projects: any[] = map.projects ?? [];
  const threads: any[] = map.threads ?? [];
  const liveTotal = threads.filter((t) => t.running).length;
  const leadName = projects.find((p) => p.id === map.teamLeadProjectId)?.name;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }} refreshControl={refreshControl}>
      {leadName && (
        <View style={[S.card, { flexDirection: "row", alignItems: "center", gap: 8, borderColor: C.accent700, borderWidth: 1 }]}>
          <Text style={{ fontSize: 15 }}>🧭</Text>
          <Text style={[S.title, { flex: 1 }]}>{leadName}</Text>
          <Text style={{ color: liveTotal ? C.ok : C.n600, fontSize: 12 }}>● {liveTotal} live</Text>
        </View>
      )}
      {projects.map((p) => {
        const rows = threads.filter((t) => t.projectId === p.id);
        if (!rows.length) return null;
        const live = rows.filter((t) => t.running).length;
        return (
          <View key={p.id} style={{ marginTop: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
              <Text style={{ color: C.n500, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", flex: 1 }}>
                {p.name}
              </Text>
              {live > 0 && <Text style={{ color: C.ok, fontSize: 11 }}>● {live}</Text>}
            </View>
            {rows.map((t) => (
              <Card key={t.id} onPress={() => openThread(t.id, t.title)}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
                  <Dot color={t.running ? C.ok : C.n600} />
                  <Text style={[S.title, { flex: 1 }]} numberOfLines={1}>
                    {t.title}
                  </Text>
                  {t.running && t.model && <Text style={S.tag}>{t.model}</Text>}
                </View>
                <View style={{ flexDirection: "row", gap: 8, marginTop: 7, alignItems: "center", flexWrap: "wrap" }}>
                  {t.branch && (
                    <Text style={[S.dim, { color: C.accent300 }]} numberOfLines={1}>
                      ⎇ {String(t.branch).replace(/^ticket\//, "")}
                    </Text>
                  )}
                  {t.dirty != null && t.dirty > 0 && <Text style={[S.dim, { color: C.warn }]}>±{t.dirty}</Text>}
                  {t.turns > 0 && <Text style={S.dim}>${Number(t.costUsd ?? 0).toFixed(2)}</Text>}
                  {t.pr ? (
                    <Pressable onPress={() => t.pr.url && Linking.openURL(t.pr.url)} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
                      <Text style={{ color: t.pr.state === "OPEN" ? C.ok : t.pr.state === "MERGED" ? C.n400 : C.err, fontSize: 12 }}>
                        ⑂ #{t.pr.number} {String(t.pr.state).toLowerCase()}
                        {t.pr.checks ? ` · ${t.pr.checks}` : ""}
                      </Text>
                    </Pressable>
                  ) : (
                    <Text style={[S.dim, { color: C.n600 }]}>no PR</Text>
                  )}
                  {t.running && t.pid && <Text style={[S.dim, { color: C.ok, marginLeft: "auto" }]}>pid {t.pid}</Text>}
                </View>
              </Card>
            ))}
          </View>
        );
      })}
      {liveTotal === 0 && threads.length === 0 && <Center text="Nothing on the map — no active threads." />}
    </ScrollView>
  );
}

// ── Usage (tokens over time, by model / project, live sessions) ────────────────
const RANGES: { label: string; days: number }[] = [
  { label: "Today", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
];

export function UsageScreen({ client }: { client: RelayClient }) {
  const [days, setDays] = useState(1);
  const { data: u, error, refresh } = useCachedRpc<any>(client, `usage:${days}`, "getUsage", days);
  useSpawnEvents(client, ["turn:done"], refresh);
  const refreshControl = useRefreshControl(refresh);

  const maxSeries = u ? Math.max(...u.series.map((s: any) => s.tokens), 1) : 1;
  const maxProject = u ? Math.max(...u.byProject.map((p: any) => p.tokens), 1) : 1;
  const totalModel = u ? Math.max(u.byModel.reduce((a: number, m: any) => a + m.tokens, 0), 1) : 1;

  const bar = (frac: number, color = C.accent500) => (
    <View style={{ height: 4, backgroundColor: C.n800, borderRadius: 2, overflow: "hidden" }}>
      <View style={{ height: 4, width: `${Math.min(frac * 100, 100)}%`, backgroundColor: color }} />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", gap: 8, padding: 14, paddingBottom: 6 }}>
        {RANGES.map((r) => (
          <Chip key={r.days} label={r.label} on={days === r.days} onPress={() => setDays(r.days)} />
        ))}
      </View>
      {u == null && error !== "" && <ErrorBar message={error} onRetry={refresh} />}
      {u == null && error === "" && <Center spinner />}
      {u != null && (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingTop: 6, paddingBottom: 40, gap: 14 }} refreshControl={refreshControl}>
        <View style={S.card}>
          <Text style={{ color: C.text, fontSize: 26, fontWeight: "600" }}>{fmtTok(u.totalTokens)}</Text>
          <Text style={S.dim}>{`tokens · ${u.turns} turns · ${u.threads} threads · $${u.totalCost.toFixed(2)}`}</Text>
          {u.series.length > 0 && (
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 70, marginTop: 12 }}>
              {u.series.map((pt: any, i: number) => (
                <View
                  key={pt.ts}
                  style={{
                    flex: 1,
                    height: Math.max((pt.tokens / maxSeries) * 66, 2),
                    backgroundColor: i === u.series.length - 1 ? C.accent500 : C.accent700,
                    borderRadius: 2,
                  }}
                />
              ))}
            </View>
          )}
        </View>

        <View style={S.card}>
          <Text style={[S.title, { marginBottom: 10 }]}>By model</Text>
          {(u.byModel ?? []).map((m: any) => (
            <View key={m.model} style={{ marginBottom: 9 }}>
              <View style={{ flexDirection: "row", marginBottom: 3 }}>
                <Text style={[S.dim, { flex: 1, color: C.text }]}>{m.model}</Text>
                <Text style={S.dim}>
                  {fmtTok(m.tokens)} · {Math.round((m.tokens / totalModel) * 100)}%
                </Text>
              </View>
              {bar(m.tokens / totalModel)}
            </View>
          ))}
          {u.byModel.length === 0 && <Text style={S.dim}>No runs yet.</Text>}
        </View>

        <View style={S.card}>
          <Text style={[S.title, { marginBottom: 10 }]}>By project</Text>
          {(u.byProject ?? []).map((p: any) => (
            <View key={p.project} style={{ marginBottom: 9 }}>
              <View style={{ flexDirection: "row", marginBottom: 3 }}>
                <Text style={[S.dim, { flex: 1, color: C.text }]} numberOfLines={1}>
                  {p.project}
                </Text>
                <Text style={S.dim}>
                  {p.threads}t · {p.turns}r · {fmtTok(p.tokens)}
                </Text>
              </View>
              {bar(p.tokens / maxProject)}
            </View>
          ))}
          {u.byProject.length === 0 && <Text style={S.dim}>Nothing in this window.</Text>}
        </View>

        <View style={S.card}>
          <Text style={[S.title, { marginBottom: 10 }]}>Live sessions</Text>
          {(u.sessions ?? []).map((s: any) => (
            <View key={s.threadId} style={{ marginBottom: 11 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                {s.running && <Dot color={C.ok} />}
                <Text style={[S.dim, { flex: 1, color: C.text }]} numberOfLines={1}>
                  {s.kind === "teamlead" ? "team lead" : s.title}
                </Text>
                <Text style={S.dim}>
                  {s.contextTokens != null ? `${fmtTok(s.contextTokens)} ctx` : "no ctx"}
                  {s.model ? ` · ${s.model}` : ""}
                </Text>
                <Pressable
                  onPress={() => {
                    tapHaptic();
                    client.rpc("resetThreadSession", s.threadId).then(refresh).catch(() => {});
                  }}
                  hitSlop={8}
                  style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                >
                  <Text style={{ color: C.accent300, fontSize: 14 }}>↺</Text>
                </Pressable>
              </View>
              {s.contextTokens != null && <View style={{ marginTop: 4 }}>{bar(s.contextTokens / 200_000, C.accent500)}</View>}
            </View>
          ))}
          {u.sessions.length === 0 && <Text style={S.dim}>No live sessions.</Text>}
        </View>
      </ScrollView>
      )}
    </View>
  );
}

// ── Settings (per-project: models/effort/approvals/isolation/skills/rules/mem/MCP) ─
export function SettingsScreen({ client, projects }: { client: RelayClient; projects: any[] }) {
  const [pid, setPid] = useState<number | null>(projects[0]?.id ?? null);
  const [s, setS] = useState<any>(null);
  const [skills, setSkills] = useState<any[]>([]);
  const [rules, setRules] = useState("");
  const [memory, setMemory] = useState("");
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Projects can arrive after mount (they load over the relay) — pick the
  // first one as soon as they do.
  useEffect(() => {
    if (pid == null && projects.length > 0) setPid(projects[0].id);
  }, [projects, pid]);

  useEffect(() => {
    if (pid == null) return;
    setS(null);
    client.rpc<any>("getProjectSettings", pid).then((v) => {
      setS(v);
      setRules(v.rules ?? "");
      setMemory(v.memory ?? "");
    }).catch(() => {});
    client.rpc<any[]>("listSkills", pid).then(setSkills).catch(() => setSkills([]));
  }, [client, pid]);

  const patch = async (p: any) => {
    if (pid == null) return;
    const next = await client.rpc<any>("updateProjectSettings", pid, p).catch(() => null);
    if (next) {
      setS(next);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    }
  };
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  const toggleModel = (m: string) => {
    if (!s) return;
    const allowed = s.allowedModels.includes(m) ? s.allowedModels.filter((x: string) => x !== m) : [...s.allowedModels, m];
    const change: any = { allowedModels: allowed };
    if (s.defaultModel && !allowed.includes(s.defaultModel)) change.defaultModel = "";
    patch(change);
  };
  const toggleSkill = async (sk: any) => {
    if (!s || pid == null) return;
    const disabled = sk.enabled ? [...s.disabledSkills, sk.name] : s.disabledSkills.filter((x: string) => x !== sk.name);
    await patch({ disabledSkills: disabled });
    setSkills(await client.rpc<any[]>("listSkills", pid).catch(() => skills));
  };
  const toggleMcp = (server: any) => {
    if (!s) return;
    patch({ mcpServers: s.mcpServers.map((m: any) => (m.name === server.name ? { ...m, enabled: !m.enabled } : m)) });
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={{ flexDirection: "row", alignItems: "center", padding: 14, paddingBottom: 6, gap: 8 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {projects.map((p) => (
            <Chip key={p.id} label={p.name} on={pid === p.id} onPress={() => setPid(p.id)} />
          ))}
        </ScrollView>
        {saved && <Text style={{ color: C.ok, fontSize: 11 }}>✓ saved</Text>}
      </View>
      {!s ? (
        <Center spinner />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, paddingTop: 6, paddingBottom: 40, gap: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={S.card}>
            <Text style={[S.title, { marginBottom: 10 }]}>Models & effort</Text>
            <Field label="Allowed models">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {MODELS.map((m) => (
                  <Chip key={m} label={m} on={s.allowedModels.includes(m)} onPress={() => toggleModel(m)} />
                ))}
              </View>
            </Field>
            <View style={{ height: 12 }} />
            <Field label="Default model">
              <ChipPicker options={s.allowedModels} value={s.defaultModel ?? ""} onChange={(v) => patch({ defaultModel: v })} />
            </Field>
            <View style={{ height: 12 }} />
            <Field label="Default effort">
              <ChipPicker options={EFFORTS} value={s.defaultEffort ?? ""} onChange={(v) => patch({ defaultEffort: v })} />
            </Field>
          </View>

          <View style={S.card}>
            <Text style={[S.title, { marginBottom: 10 }]}>Approvals</Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Chip label="Prompt me" on={s.approvalMode === "prompt"} onPress={() => patch({ approvalMode: "prompt" })} />
              <Chip label="Auto-allow" on={s.approvalMode === "auto"} onPress={() => patch({ approvalMode: "auto" })} />
            </View>
            <View style={{ height: 14 }} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ color: C.text, fontSize: 13, flex: 1 }}>Worktree per ticket</Text>
              <Switch
                value={s.isolation !== false}
                onValueChange={() => patch({ isolation: s.isolation === false })}
                trackColor={{ true: C.accent, false: C.n800 }}
                thumbColor={C.text}
              />
            </View>
          </View>

          <View style={S.card}>
            <Text style={[S.title, { marginBottom: 4 }]}>MCP servers</Text>
            {(s.mcpServers ?? []).map((m: any) => {
              const connected = !!m.account || (m.secretsSet?.length ?? 0) > 0;
              const status = !m.provider ? m.transport : m.account ? m.account : connected ? "connected" : "not connected";
              return (
                <View key={m.name} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 }}>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={{ color: C.text, fontSize: 13 }} numberOfLines={1}>{m.name}</Text>
                      {m.environment ? <Text style={S.tag}>{m.environment}</Text> : null}
                    </View>
                    <Text style={[S.dim, { color: connected ? C.ok : m.provider ? C.warn : C.n500 }]} numberOfLines={1}>
                      {PROVIDER_LABEL[m.provider] ?? (m.provider || "custom")} · {status}
                    </Text>
                  </View>
                  <Switch
                    value={!!m.enabled}
                    onValueChange={() => toggleMcp(m)}
                    trackColor={{ true: C.accent, false: C.n800 }}
                    thumbColor={C.text}
                  />
                </View>
              );
            })}
            {(s.mcpServers ?? []).length === 0 && <Text style={[S.dim, { marginTop: 8 }]}>None. Add + connect on desktop.</Text>}
          </View>

          <View style={S.card}>
            <Text style={[S.title, { marginBottom: 8 }]}>Skills</Text>
            {skills.map((sk) => (
              <View key={`${sk.scope}-${sk.name}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <Text style={{ color: C.text, fontSize: 13, flex: 1 }} numberOfLines={1}>
                  {sk.name} <Text style={S.dim}>{sk.scope}</Text>
                </Text>
                <Switch
                  value={sk.enabled}
                  onValueChange={() => toggleSkill(sk)}
                  trackColor={{ true: C.accent, false: C.n800 }}
                  thumbColor={C.text}
                />
              </View>
            ))}
            {skills.length === 0 && <Text style={S.dim}>No skills found.</Text>}
          </View>

          <View style={S.card}>
            <Text style={[S.title, { marginBottom: 8 }]}>Rules</Text>
            <TextInput
              style={[sheetInput, { minHeight: 80, textAlignVertical: "top" }]}
              multiline
              placeholder="Standing instructions for every run in this project."
              placeholderTextColor={C.n600}
              value={rules}
              onChangeText={setRules}
              onBlur={() => rules !== s.rules && patch({ rules })}
            />
          </View>
          <View style={S.card}>
            <Text style={[S.title, { marginBottom: 8 }]}>Memory</Text>
            <TextInput
              style={[sheetInput, { minHeight: 80, textAlignVertical: "top" }]}
              multiline
              placeholder="Durable project facts agents should always know."
              placeholderTextColor={C.n600}
              value={memory}
              onChangeText={setMemory}
              onBlur={() => memory !== s.memory && patch({ memory })}
            />
          </View>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
