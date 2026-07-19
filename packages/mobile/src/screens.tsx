import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { RelayClient, SpawnEvent } from "./api";
import { C } from "./theme";

const MODELS = ["haiku", "sonnet", "opus", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// The four phone surfaces: Board, Approvals, Runs, Thread. Deliberately
// lean — RN core components only, Nocturne colors, same daemon payloads as
// the desktop.

const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

const S = {
  card: {
    backgroundColor: C.surface,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  title: { color: C.text, fontSize: 14, fontWeight: "500" as const },
  dim: { color: C.n500, fontSize: 12 },
  tag: {
    color: C.accent300,
    fontSize: 11,
    borderColor: C.accent,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: "hidden" as const,
  },
};

function useSpawnEvents(client: RelayClient, types: string[], cb: (ev: SpawnEvent) => void) {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(
    () => client.onEvent((ev) => {
      if (types.includes(ev.type)) cbRef.current(ev);
    }),
    [client] // eslint-disable-line react-hooks/exhaustive-deps
  );
}

// ── Shared bits: chips, pickers, sheet ─────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={{ color: C.n500, fontSize: 11 }}>{label}</Text>
      {children}
    </View>
  );
}

function Chip({ label, on, onPress, dim }: { label: string; on: boolean; onPress: () => void; dim?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        borderWidth: 1,
        borderColor: on ? C.accent : C.n800,
        backgroundColor: on ? C.accent800 : "transparent",
        borderRadius: 7,
        paddingHorizontal: 11,
        paddingVertical: 5,
        opacity: dim ? 0.4 : 1,
      }}
    >
      <Text style={{ color: on ? C.accent200 : C.n400, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

// Single-select chip row where "" means auto. `allowed` dims disallowed models.
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
      <View style={{ flex: 1, backgroundColor: "#000a", justifyContent: "flex-end" }}>
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
            <Pressable onPress={onClose} hitSlop={12}>
              <Text style={{ color: C.n500, fontSize: 20 }}>✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 32 }}>{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

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
  const canDelegate = editing ? ticket.thread_id == null : true;

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
        {editing && <Btn label="Delete" color={C.err} onPress={doDelete} disabled={busy !== ""} />}
        <View style={{ flex: 1 }} />
        <Btn label={editing ? "Save" : "Create"} color={C.n400} onPress={doSave} disabled={!title.trim() || projectId === "" || busy !== ""} />
        {canDelegate && (
          <Btn
            label={busy === "delegate" ? "Delegating…" : editing ? "Delegate" : "Create & delegate"}
            color={C.accent}
            onPress={doDelegate}
            disabled={!title.trim() || projectId === "" || busy !== ""}
          />
        )}
      </View>
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
        <Btn label={busy ? "Delegating…" : "Delegate"} color={C.accent} onPress={send} disabled={!task.trim() || projectId === "" || busy} />
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
  const [tickets, setTickets] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sheet, setSheet] = useState<null | { kind: "ticket"; ticket: any | null } | { kind: "delegate" }>(null);

  const refresh = useCallback(() => {
    client
      .rpc<any[]>("listTickets")
      .then((t) => {
        setTickets(t);
        setLoaded(true);
      })
      .catch(() => {});
  }, [client]);
  useEffect(refresh, [refresh]);
  useSpawnEvents(client, ["ticket:created", "ticket:updated", "ticket:deleted", "turn:start", "turn:done"], refresh);

  if (!loaded) return <Center spinner />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 }}>
        <Btn label="⚡ Delegate" color={C.accent} onPress={() => setSheet({ kind: "delegate" })} />
        <View style={{ flex: 1 }} />
        <Btn label="+ Ticket" color={C.n400} onPress={() => setSheet({ kind: "ticket", ticket: null })} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
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
                <Pressable
                  key={t.id}
                  style={S.card}
                  onPress={() =>
                    t.thread_id != null ? openThread(t.thread_id, t.title) : setSheet({ kind: "ticket", ticket: t })
                  }
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
                </Pressable>
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
  const [pending, setPending] = useState<any[]>([]);
  const refresh = useCallback(() => {
    client.rpc<any[]>("listApprovals").then(setPending).catch(() => {});
  }, [client]);
  useEffect(refresh, [refresh]);
  useSpawnEvents(client, ["approval:request", "approval:resolved"], refresh);

  const answer = async (id: number, allow: boolean) => {
    await client.rpc("resolveApproval", id, allow);
    refresh();
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
      {pending.map((a) => (
        <View key={a.id} style={[S.card, { borderColor: C.warn, borderWidth: 1 }]}>
          <Text style={S.title}>✋ {a.tool}</Text>
          <Text style={[S.dim, { marginTop: 6 }]} numberOfLines={6}>
            {JSON.stringify(a.input, null, 2)}
          </Text>
          <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
            <Btn label="Allow" color={C.ok} onPress={() => answer(a.id, true)} />
            <Btn label="Deny" color={C.err} onPress={() => answer(a.id, false)} />
          </View>
        </View>
      ))}
      {pending.length === 0 && <Center text="Nothing waiting on you." />}
    </ScrollView>
  );
}

// ── Runs ─────────────────────────────────────────────────────────────────────
export function RunsScreen({
  client,
  openThread,
}: {
  client: RelayClient;
  openThread: (threadId: number, title: string) => void;
}) {
  const [runs, setRuns] = useState<any[]>([]);
  const [live, setLive] = useState<Map<number, number>>(new Map());

  const refresh = useCallback(() => {
    client.rpc<any[]>("listActiveThreads").then(setRuns).catch(() => {});
  }, [client]);
  useEffect(refresh, [refresh]);
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

  return (
    <FlatList
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 14 }}
      data={runs}
      keyExtractor={(t) => String(t.id)}
      ListEmptyComponent={<Center text="Nothing active." />}
      renderItem={({ item: t }) => {
        const lt = live.get(t.id) ?? t.liveTokens;
        return (
          <Pressable style={S.card} onPress={() => openThread(t.id, t.title)}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <Dot color={t.running ? C.ok : C.n600} />
              <Text style={[S.title, { flex: 1 }]} numberOfLines={1}>
                {t.title}
              </Text>
              {t.running && lt != null && lt > 0 && (
                <Text style={{ color: C.ok, fontSize: 12 }}>⚡ {fmtTok(lt)}</Text>
              )}
            </View>
            <Text style={[S.dim, { marginTop: 4 }]}>
              {t.project_name} · {t.kind}
              {t.branch ? ` · ${String(t.branch).replace(/^ticket\//, "")}` : ""}
            </Text>
          </Pressable>
        );
      }}
    />
  );
}

// ── Thread ───────────────────────────────────────────────────────────────────
export function ThreadScreen({
  client,
  threadId,
  onBack,
  title,
}: {
  client: RelayClient;
  threadId: number;
  title: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<any[]>([]);
  const [liveText, setLiveText] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<ScrollView>(null);

  useEffect(() => {
    client.rpc<any[]>("listMessages", threadId).then(setMessages).catch(() => {});
  }, [client, threadId]);
  useSpawnEvents(client, ["turn:delta", "turn:text", "turn:tool", "turn:done"], (ev) => {
    if (ev.payload.threadId !== threadId) return;
    if (ev.type === "turn:delta") setLiveText((p) => p + ev.payload.text);
    else if (ev.type === "turn:done") {
      setLiveText("");
      setBusy(false);
    } else {
      if (ev.type === "turn:text") setLiveText("");
      const msg = ev.payload.message;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    }
  });
  useEffect(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
  }, [messages, liveText]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setBusy(true);
    await client.rpc("sendMessage", threadId, text).catch(() => setBusy(false));
    setMessages(await client.rpc("listMessages", threadId).catch(() => messages));
  };

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          paddingVertical: 10,
          gap: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.n800,
        }}
      >
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ color: C.accent, fontSize: 15 }}>‹ Back</Text>
        </Pressable>
        <Text style={[S.title, { flex: 1 }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <ScrollView ref={listRef} style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
        {messages.map((m) =>
          m.role === "tool" ? (
            <Text key={m.id} style={[S.dim, { marginBottom: 8, fontFamily: "Menlo" }]} numberOfLines={1}>
              ⚙ {m.tool_name}
            </Text>
          ) : (
            <View key={m.id} style={{ marginBottom: 12 }}>
              <Text style={{ color: m.role === "user" ? C.accent300 : C.ok, fontSize: 11, marginBottom: 2 }}>
                {m.role === "user" ? "you" : "agent"}
              </Text>
              <Text style={{ color: m.role === "system" ? C.n500 : C.text, fontSize: 14, lineHeight: 20 }}>
                {m.text}
              </Text>
            </View>
          )
        )}
        {liveText !== "" && (
          <View style={{ marginBottom: 12 }}>
            <Text style={{ color: C.ok, fontSize: 11, marginBottom: 2 }}>agent</Text>
            <Text style={{ color: C.text, fontSize: 14, lineHeight: 20 }}>{liveText}▌</Text>
          </View>
        )}
        {busy && liveText === "" && <Text style={S.dim}>working…</Text>}
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 8, padding: 12, alignItems: "flex-end" }}>
        <TextInput
          style={{
            flex: 1,
            backgroundColor: C.surface,
            borderRadius: 12,
            color: C.text,
            paddingHorizontal: 14,
            paddingVertical: 10,
            maxHeight: 120,
            borderWidth: 1,
            borderColor: C.n800,
          }}
          multiline
          value={draft}
          placeholder="Steer the agent…"
          placeholderTextColor={C.n600}
          onChangeText={setDraft}
        />
        <Btn label="Send" color={C.accent} onPress={send} disabled={busy || !draft.trim()} />
      </View>
    </View>
  );
}

// Provider labels for the MCP section in Settings. Phone flips servers on/off
// (a non-secret write); connecting itself stays on desktop (host browser /
// clipboard / file picker, and those RPCs are relay-denied).
const PROVIDER_LABEL: Record<string, string> = {
  gcloud: "Google Cloud",
  supabase: "Supabase",
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
  const [map, setMap] = useState<any>(null);
  const refresh = useCallback(() => {
    client.rpc<any>("getMap").then(setMap).catch(() => {});
  }, [client]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);
  useSpawnEvents(client, ["thread:created", "thread:updated", "turn:start", "turn:done"], refresh);

  if (!map) return <Center spinner />;
  const projects: any[] = map.projects ?? [];
  const threads: any[] = map.threads ?? [];
  const liveTotal = threads.filter((t) => t.running).length;
  const leadName = projects.find((p) => p.id === map.teamLeadProjectId)?.name;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
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
              <Pressable key={t.id} style={S.card} onPress={() => openThread(t.id, t.title)}>
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
                    <Pressable onPress={() => t.pr.url && Linking.openURL(t.pr.url)}>
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
              </Pressable>
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
  const [u, setU] = useState<any>(null);
  const refresh = useCallback(() => {
    client.rpc<any>("getUsage", days).then(setU).catch(() => {});
  }, [client, days]);
  useEffect(refresh, [refresh]);
  useSpawnEvents(client, ["turn:done"], refresh);

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
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingTop: 6, paddingBottom: 40, gap: 14 }}>
        <View style={S.card}>
          <Text style={{ color: C.text, fontSize: 26, fontWeight: "600" }}>{u ? fmtTok(u.totalTokens) : "—"}</Text>
          <Text style={S.dim}>
            {u ? `tokens · ${u.turns} turns · ${u.threads} threads · $${u.totalCost.toFixed(2)}` : ""}
          </Text>
          {u && u.series.length > 0 && (
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
          {(u?.byModel ?? []).map((m: any) => (
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
          {(!u || u.byModel.length === 0) && <Text style={S.dim}>No runs yet.</Text>}
        </View>

        <View style={S.card}>
          <Text style={[S.title, { marginBottom: 10 }]}>By project</Text>
          {(u?.byProject ?? []).map((p: any) => (
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
          {(!u || u.byProject.length === 0) && <Text style={S.dim}>Nothing in this window.</Text>}
        </View>

        <View style={S.card}>
          <Text style={[S.title, { marginBottom: 10 }]}>Live sessions</Text>
          {(u?.sessions ?? []).map((s: any) => (
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
                <Pressable onPress={() => client.rpc("resetThreadSession", s.threadId).then(refresh).catch(() => {})} hitSlop={8}>
                  <Text style={{ color: C.accent300, fontSize: 14 }}>↺</Text>
                </Pressable>
              </View>
              {s.contextTokens != null && <View style={{ marginTop: 4 }}>{bar(s.contextTokens / 200_000, C.accent500)}</View>}
            </View>
          ))}
          {(!u || u.sessions.length === 0) && <Text style={S.dim}>No live sessions.</Text>}
        </View>
      </ScrollView>
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
  const [saved, setSaved] = useState(0);

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
      setSaved((n) => n + 1);
    }
  };
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
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", padding: 14, paddingBottom: 6, gap: 8 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {projects.map((p) => (
            <Chip key={p.id} label={p.name} on={pid === p.id} onPress={() => setPid(p.id)} />
          ))}
        </ScrollView>
        {saved > 0 && <Text style={{ color: C.ok, fontSize: 11 }}>✓ saved</Text>}
      </View>
      {!s ? (
        <Center spinner />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingTop: 6, paddingBottom: 40, gap: 16 }}>
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
    </View>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────
export function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export function Btn({
  label,
  color,
  onPress,
  disabled,
}: {
  label: string;
  color: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        borderColor: color,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 8,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Text style={{ color, fontSize: 14, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function Center({ text, spinner }: { text?: string; spinner?: boolean }) {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 40 }}>
      {spinner ? <ActivityIndicator color={C.accent} /> : <Text style={S.dim}>{text}</Text>}
    </View>
  );
}
