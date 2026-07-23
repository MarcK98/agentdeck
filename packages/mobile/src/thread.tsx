// Thread screen — Discord-style chat: inverted virtualized list, message
// grouping, timestamps + day dividers, markdown agent output, expandable tool
// rows, scroll-to-latest pill, optimistic send, SQLite-cached history.

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { RelayClient } from "./api";
import { useOnReady, useSpawnEvents } from "./hooks";
import { messagesGet, messagesPut } from "./db";
import { Btn, Dot, S, tapHaptic } from "./ui";
import { C, F } from "./theme";

const GROUP_WINDOW_MS = 5 * 60_000;

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayKey = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toDateString();
};

const mdStyles = {
  body: { color: C.text, fontSize: 14, lineHeight: 20, fontFamily: F.ui },
  code_inline: {
    backgroundColor: C.inset,
    color: C.accent,
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: F.mono,
    fontSize: 13,
  },
  code_block: {
    backgroundColor: C.inset,
    color: C.muted,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.line,
    padding: 10,
    fontFamily: F.mono,
    fontSize: 12.5,
  },
  fence: {
    backgroundColor: C.inset,
    color: C.muted,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.line,
    padding: 10,
    fontFamily: F.mono,
    fontSize: 12.5,
  },
  blockquote: { backgroundColor: "transparent", borderLeftColor: C.borderStrong, paddingLeft: 10 },
  bullet_list: { marginBottom: 4 },
  link: { color: C.cyan },
  hr: { backgroundColor: C.border },
} as const;

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; msg: any; grouped: boolean }
  | { kind: "tool"; key: string; msg: any };

const MessageRow = memo(function MessageRow({ row }: { row: Row }) {
  if (row.kind === "day") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 10 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
        <Text style={{ color: C.dim, fontSize: 10, fontFamily: F.mono }}>{row.label}</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
      </View>
    );
  }
  if (row.kind === "tool") return <ToolRow msg={row.msg} />;
  const m = row.msg;
  const mine = m.role === "user";
  return (
    <View style={{ marginTop: row.grouped ? 2 : 12 }}>
      {!row.grouped && m.role !== "system" && (
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
          <Text style={{ color: mine ? C.accent : C.good, fontSize: 11.5, fontWeight: "700", fontFamily: F.uiBold }}>
            {mine ? "you" : "agent"}
          </Text>
          {m.created_at ? (
            <Text style={{ color: C.dim, fontSize: 9.5, fontFamily: F.mono }}>{hhmm(m.created_at)}</Text>
          ) : null}
        </View>
      )}
      {m.pending ? (
        <Text style={{ color: C.muted, fontSize: 14, lineHeight: 20, fontFamily: F.ui }}>{m.text}</Text>
      ) : mine || m.role === "system" ? (
        <Text
          style={{ color: m.role === "system" ? C.dim : C.text, fontSize: 14, lineHeight: 20, fontFamily: F.ui }}
          selectable
        >
          {m.text}
        </Text>
      ) : (
        <Markdown style={mdStyles as any}>{m.text ?? ""}</Markdown>
      )}
    </View>
  );
}, sameRow);

// The rows array is rebuilt (fresh objects) on every message append, which by
// default re-renders — and re-parses the markdown of — every visible row. The
// content of an existing row never changes, so compare by value: only genuinely
// changed rows re-render, keeping append + scroll cheap on long threads.
function sameRow(a: { row: Row }, b: { row: Row }) {
  const x = a.row;
  const y = b.row;
  if (x.kind !== y.kind || x.key !== y.key) return false;
  if (x.kind === "day") return true; // key encodes the label
  if (x.kind === "tool" && y.kind === "tool") return x.msg.id === y.msg.id && x.msg.tool_input === y.msg.tool_input;
  if (x.kind === "msg" && y.kind === "msg")
    return (
      x.grouped === y.grouped &&
      x.msg.id === y.msg.id &&
      x.msg.text === y.msg.text &&
      x.msg.role === y.msg.role &&
      x.msg.pending === y.msg.pending &&
      x.msg.created_at === y.msg.created_at
    );
  return false;
}

const renderRow = ({ item }: { item: Row }) => <MessageRow row={item} />;

function ToolRow({ msg }: { msg: any }) {
  const [open, setOpen] = useState(false);
  let hint = "";
  try {
    const input = JSON.parse(msg.tool_input ?? "{}");
    const v = input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.prompt;
    if (typeof v === "string") hint = v;
  } catch {
    /* no hint */
  }
  return (
    <Pressable
      onPress={() => {
        tapHaptic();
        setOpen((o) => !o);
      }}
      style={({ pressed }) => ({ marginTop: 6, opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={{ color: C.muted, fontSize: 11, fontFamily: F.mono }} numberOfLines={open ? undefined : 1}>
        <Text style={{ color: C.accent, fontFamily: F.monoBold }}>⚙ {msg.tool_name}</Text>
        {hint ? `  ${hint}` : ""}
      </Text>
      {open && msg.tool_input ? (
        <Text
          style={{
            color: C.muted,
            fontSize: 11,
            fontFamily: F.mono,
            backgroundColor: C.inset,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: 8,
            padding: 8,
            marginTop: 4,
          }}
          selectable
        >
          {msg.tool_input}
        </Text>
      ) : null}
    </Pressable>
  );
}

// Live streaming tail — isolated so per-token deltas don't touch the list.
function LiveTail({ client, threadId }: { client: RelayClient; threadId: number }) {
  const [live, setLive] = useState("");
  const [busy, setBusy] = useState(false);
  useSpawnEvents(client, ["turn:start", "turn:delta", "turn:text", "turn:done"], (ev) => {
    if (ev.payload.threadId !== threadId) return;
    if (ev.type === "turn:start") setBusy(true);
    else if (ev.type === "turn:delta") setLive((p) => p + ev.payload.text);
    else if (ev.type === "turn:text") setLive("");
    else {
      setLive("");
      setBusy(false);
    }
  });
  if (live !== "") {
    return (
      <View style={{ marginTop: 12 }}>
        <Text style={{ color: C.good, fontSize: 11.5, fontWeight: "700", fontFamily: F.uiBold, marginBottom: 2 }}>
          agent
        </Text>
        <Text style={{ color: C.text, fontSize: 14, lineHeight: 20, fontFamily: F.ui }}>{live}▌</Text>
      </View>
    );
  }
  if (busy) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
        <Dot color={C.good} pulse />
        <Text style={[S.dim, { color: C.good }]}>working…</Text>
      </View>
    );
  }
  return null;
}

let tmpId = -1;

export function ThreadScreen({
  client,
  threadId,
  title,
  onBack,
}: {
  client: RelayClient;
  threadId: number;
  title: string;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<any[]>(() => messagesGet(threadId));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState("");
  const [queued, setQueued] = useState(0);
  // Scroll pill: how far the user has scrolled up (inverted list: offset 0 =
  // latest) and how many messages arrived while they were up there.
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const listRef = useRef<FlatList>(null);
  const insets = useSafeAreaInsets();

  const refetch = useCallback(() => {
    client
      .rpc<any[]>("listMessages", threadId)
      .then((ms) => {
        setMessages(ms);
        messagesPut(threadId, ms);
      })
      .catch(() => {});
  }, [client, threadId]);

  useEffect(() => {
    setMessages(messagesGet(threadId));
    refetch();
  }, [refetch, threadId]);
  useOnReady(client, refetch);

  useSpawnEvents(client, ["turn:start", "turn:text", "turn:tool", "turn:queued", "turn:done"], (ev) => {
    if (ev.payload.threadId !== threadId) return;
    if (ev.type === "turn:start") setBusy(true);
    else if (ev.type === "turn:queued") setQueued(ev.payload.depth);
    else if (ev.type === "turn:done") {
      setBusy(false);
      setQueued(ev.payload.queued ?? 0);
    } else {
      const msg = ev.payload.message;
      messagesPut(threadId, [msg]);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      if (away) setUnseen((n) => n + 1);
    }
  });

  // Rows for the inverted list: newest first, with grouping + day dividers
  // computed on the ascending order.
  const rows = useMemo(() => {
    const out: Row[] = [];
    let prev: any = null;
    for (const m of messages) {
      if (m.created_at && (!prev?.created_at || dayKey(prev.created_at) !== dayKey(m.created_at))) {
        out.push({ kind: "day", key: `day-${dayKey(m.created_at)}-${m.id}`, label: dayKey(m.created_at) });
      }
      if (m.role === "tool") {
        out.push({ kind: "tool", key: `m${m.id}`, msg: m });
      } else {
        const grouped =
          prev != null &&
          prev.role === m.role &&
          m.role !== "system" &&
          prev.created_at &&
          m.created_at &&
          new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS;
        out.push({ kind: "msg", key: `m${m.id}`, msg: m, grouped: !!grouped });
      }
      prev = m;
    }
    return out.reverse();
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setSendError("");
    const temp = { id: tmpId--, role: "user", text, created_at: new Date().toISOString(), pending: true };
    setMessages((prev) => [...prev, temp]);
    if (busy) setQueued((n) => n + 1);
    else setBusy(true);
    try {
      await client.rpc("sendMessage", threadId, text);
      refetch();
    } catch (e) {
      // Message didn't reach the daemon — put the draft back, drop the ghost.
      setMessages((prev) => prev.filter((m) => m.id !== temp.id));
      setDraft(text);
      setBusy(false);
      setQueued((n) => Math.max(0, n - 1));
      setSendError(e instanceof Error ? e.message : "send failed");
    }
  };

  const jumpToLatest = () => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setUnseen(0);
    setAway(false);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: C.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      // The screen sits below the top safe-area inset (App wraps the nav in a
      // SafeAreaView edges={["top"]}). RN measures the KAV frame relative to its
      // parent (y=0) but the keyboard in absolute window coords, so the computed
      // padding lands short by exactly that inset and the keyboard covers the
      // input. Feed the inset back as the offset to line the input up on top.
      keyboardVerticalOffset={insets.top}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          paddingVertical: 11,
          gap: 10,
          borderBottomWidth: 1,
          borderBottomColor: C.line,
        }}
      >
        <Pressable onPress={onBack} hitSlop={12} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
          <Text style={{ color: C.accent, fontSize: 14, fontFamily: F.ui }}>‹ Back</Text>
        </Pressable>
        <Text style={[S.title, { flex: 1, fontWeight: "700", fontFamily: F.uiBold }]} numberOfLines={1}>
          {title}
        </Text>
      </View>

      <View style={{ flex: 1 }}>
        <FlatList
          ref={listRef}
          inverted
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={renderRow}
          contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 10 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          initialNumToRender={14}
          maxToRenderPerBatch={10}
          windowSize={11}
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            setAway(y > 120);
            if (y <= 120) setUnseen(0);
          }}
          scrollEventThrottle={64}
          ListHeaderComponent={
            <View>
              <LiveTail client={client} threadId={threadId} />
              {queued > 0 && (
                <Text style={{ color: C.accent, fontSize: 12, marginTop: 6, opacity: 0.85 }}>
                  {queued} queued — sends when the agent is free
                </Text>
              )}
            </View>
          }
        />
        {away && (
          <Pressable
            onPress={jumpToLatest}
            style={({ pressed }) => ({
              position: "absolute",
              bottom: 12,
              alignSelf: "center",
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              backgroundColor: pressed ? C.borderStrong : C.selected,
              borderColor: C.accent,
              borderWidth: 1,
              borderRadius: 100,
              paddingHorizontal: 14,
              paddingVertical: 7,
            })}
          >
            <Text style={{ color: C.accent, fontSize: 12, fontWeight: "700", fontFamily: F.uiBold }}>
              ↓ {unseen > 0 ? `${unseen} new` : "latest"}
            </Text>
          </Pressable>
        )}
      </View>

      {sendError !== "" && (
        <Text style={{ color: C.bad, fontSize: 12, fontFamily: F.ui, paddingHorizontal: 14, paddingTop: 6 }}>
          ⚠ {sendError} — draft restored
        </Text>
      )}
      <View
        style={{
          flexDirection: "row",
          gap: 8,
          paddingHorizontal: 12,
          paddingTop: 12,
          // Keep the input clear of the home indicator when the keyboard is down.
          paddingBottom: 12 + insets.bottom,
          alignItems: "flex-end",
        }}
      >
        <TextInput
          style={{
            flex: 1,
            backgroundColor: C.panel,
            borderRadius: 11,
            color: C.text,
            fontFamily: F.ui,
            fontSize: 14,
            paddingHorizontal: 14,
            paddingVertical: 10,
            maxHeight: 120,
            borderWidth: 1,
            borderColor: C.border,
          }}
          multiline
          value={draft}
          placeholder={busy ? "Queue a message…" : "Steer the agent…"}
          placeholderTextColor={C.dim}
          onChangeText={setDraft}
        />
        <Btn label={busy ? "Queue" : "Send"} color={C.accent} onPress={send} disabled={!draft.trim()} fill />
      </View>
    </KeyboardAvoidingView>
  );
}
