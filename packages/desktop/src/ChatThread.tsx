import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import type { Message } from "./types";

// One thread's transcript + composer — Discord-shaped: grouped messages with
// timestamps and day dividers, markdown + highlighted code for agent output,
// scroll anchoring (auto-follow only when pinned to the bottom, a jump pill
// otherwise), per-thread draft persistence, and load-older pagination.

const GROUP_WINDOW_MS = 5 * 60_000;
const PAGE = 100;

const toolHint = (m: Message): string => {
  if (!m.tool_input) return "";
  try {
    const input = JSON.parse(m.tool_input) as Record<string, unknown>;
    const v =
      input.command ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.prompt;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
};

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ""
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

const draftKey = (id: number) => `spawn.draft.${id}`;

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const raw = String(children ?? "").replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  const html = useMemo(() => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(raw, { language: lang }).value;
    } catch {
      /* fall through to plain */
    }
    return null;
  }, [raw, lang]);
  const copy = () => {
    navigator.clipboard.writeText(raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="codeblock">
      <div className="cb-head">
        {lang ?? "text"}
        <button className="cb-copy" title="Copy code" onClick={copy}>
          <i className={`ph ${copied ? "ph-check" : "ph-copy"}`} />
          {copied ? "copied" : ""}
        </button>
      </div>
      {html != null ? (
        <pre>
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      ) : (
        <pre>
          <code>{raw}</code>
        </pre>
      )}
    </div>
  );
}

const mdComponents = {
  code({ className, children, ...props }: any) {
    // Block code arrives wrapped in <pre> — react-markdown marks it via the
    // node position; the practical tell is a newline or a language class.
    const isBlock = className != null || String(children ?? "").includes("\n");
    if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ children }: any) {
    return <>{children}</>; // CodeBlock renders its own <pre>
  },
  a({ href, children }: any) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
};

const Md = memo(function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

const MessageRow = memo(function MessageRow({ m, grouped }: { m: Message; grouped: boolean }) {
  if (m.role === "tool") {
    return (
      <div className="msg tool">
        <span className="ts">{hhmm(m.created_at)}</span>
        <span className="tool-name">{m.tool_name}</span>
        <span className="tool-in mono">{toolHint(m)}</span>
      </div>
    );
  }
  return (
    <div className={`msg ${m.role} ${grouped ? "grouped" : ""}`}>
      {!grouped && m.role !== "system" && (
        <div className="who">
          {m.role === "user" ? "you" : "agent"}
          {m.created_at && <span className="ts">{hhmm(m.created_at)}</span>}
        </div>
      )}
      {m.role === "assistant" ? <Md text={m.text ?? ""} /> : <pre>{m.text}</pre>}
    </div>
  );
});

// The streaming tail subscribes to turn:delta itself so per-token renders
// stay inside this component instead of reconciling the whole transcript.
const LiveTail = memo(function LiveTail({
  threadId,
  busy,
  onGrow,
}: {
  threadId: number;
  busy: boolean;
  onGrow: () => void;
}) {
  const [live, setLive] = useState("");
  const onGrowRef = useRef(onGrow);
  onGrowRef.current = onGrow;
  useEffect(() => {
    setLive("");
    return window.agentdeck.onEvent((ev) => {
      if (ev.type === "turn:delta" && ev.payload.threadId === threadId) {
        setLive((prev) => prev + ev.payload.text);
        onGrowRef.current();
      }
      if ((ev.type === "turn:text" || ev.type === "turn:done") && ev.payload.threadId === threadId) {
        setLive("");
      }
    });
  }, [threadId]);
  if (live) {
    return (
      <div className="msg assistant">
        <div className="who">agent</div>
        <pre>
          {live}
          <span className="caret" />
        </pre>
      </div>
    );
  }
  if (busy) {
    return (
      <div className="working">
        <span className="dot-live pulse" />
        working…
      </div>
    );
  }
  return null;
});

export default function ChatThread({
  threadId,
  busy,
  markBusy,
  placeholder = "Message the agent — add context, change course…",
}: {
  threadId: number;
  busy: boolean;
  markBusy: (threadId: number) => void;
  placeholder?: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState("");
  const [hasOlder, setHasOlder] = useState(false);
  // How many messages are waiting behind the running turn (queued while busy).
  const [queued, setQueued] = useState(0);
  // Scroll anchoring: follow the tail only while the user is at the bottom.
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const atBottomRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setQueued(0);
    setSendError("");
    setAway(false);
    setUnseen(0);
    atBottomRef.current = true;
    setDraft(localStorage.getItem(draftKey(threadId)) ?? "");
    window.agentdeck.listMessages(threadId).then((ms) => {
      setMessages(ms);
      setHasOlder(ms.length >= 200);
    });
  }, [threadId]);

  const setDraftPersist = (v: string) => {
    setDraft(v);
    try {
      if (v) localStorage.setItem(draftKey(threadId), v);
      else localStorage.removeItem(draftKey(threadId));
    } catch {
      /* storage unavailable — draft just won't survive a restart */
    }
  };

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    atBottomRef.current = true;
    setAway(false);
    setUnseen(0);
  }, []);

  const followIfPinned = useCallback(() => {
    if (atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, []);

  useEffect(() => {
    return window.agentdeck.onEvent((ev) => {
      if (ev.type === "turn:queued") {
        if (ev.payload.threadId === threadId) setQueued(ev.payload.depth);
        return;
      }
      if (ev.type === "turn:done") {
        if (ev.payload.threadId === threadId) setQueued(ev.payload.queued ?? 0);
        return;
      }
      if (ev.type !== "turn:text" && ev.type !== "turn:tool") return;
      if (ev.payload.threadId !== threadId) return;
      const msg = ev.payload.message;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      if (!atBottomRef.current) setUnseen((n) => n + 1);
    });
  }, [threadId]);

  // Follow the tail on new rows (only when pinned); initial load jumps hard.
  const lastId = messages.length ? messages[messages.length - 1].id : 0;
  useEffect(() => {
    followIfPinned();
  }, [lastId, followIfPinned]);
  useEffect(() => {
    scrollToBottom();
  }, [threadId, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = atBottom;
    setAway(!atBottom);
    if (atBottom) setUnseen(0);
  };

  const loadOlder = async () => {
    const el = scrollRef.current;
    const first = messages[0];
    if (!first || !el) return;
    const prevHeight = el.scrollHeight;
    const older = await window.agentdeck.listMessages(threadId, { before: first.id, limit: PAGE } as any);
    setHasOlder(older.length >= PAGE);
    setMessages((prev) => [...older, ...prev]);
    // Keep the viewport anchored on the row the user was reading.
    requestAnimationFrame(() => {
      el.scrollTop += el.scrollHeight - prevHeight;
    });
  };

  // Sending while the agent is busy doesn't start a second run — the daemon
  // queues the message and fires it as its own turn when the current one ends.
  const send = async (textOverride?: string) => {
    const text = (textOverride ?? draft).trim();
    if (!text) return;
    setDraftPersist("");
    setSendError("");
    const wasBusy = busy;
    if (wasBusy) setQueued((n) => n + 1);
    else markBusy(threadId);
    try {
      await window.agentdeck.sendMessage(threadId, text);
      setMessages(await window.agentdeck.listMessages(threadId));
      scrollToBottom();
    } catch (e) {
      // The daemon never saw it — restore the draft so nothing is lost.
      setDraftPersist(text);
      if (wasBusy) setQueued((n) => Math.max(0, n - 1));
      setSendError(e instanceof Error ? e.message : "send failed");
    }
  };

  // Grouping + day dividers, computed once per messages change.
  const rows = useMemo(() => {
    const out: { m: Message; grouped: boolean; day: string | null }[] = [];
    let prev: Message | null = null;
    for (const m of messages) {
      const day =
        m.created_at && (!prev?.created_at || dayLabel(prev.created_at) !== dayLabel(m.created_at))
          ? dayLabel(m.created_at)
          : null;
      const grouped =
        day == null &&
        prev != null &&
        prev.role === m.role &&
        m.role !== "system" &&
        m.role !== "tool" &&
        !!prev.created_at &&
        !!m.created_at &&
        new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS;
      out.push({ m, grouped, day });
      prev = m;
    }
    return out;
  }, [messages]);

  return (
    <>
      <div className="chat-scroll-wrap">
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {hasOlder && (
            <button className="load-older" onClick={loadOlder}>
              ↑ Load older messages
            </button>
          )}
          {rows.map(({ m, grouped, day }) => (
            <div key={m.id} style={{ display: "contents" }}>
              {day && (
                <div className="day-div">
                  <span className="line" />
                  <span className="lbl">{day}</span>
                  <span className="line" />
                </div>
              )}
              <MessageRow m={m} grouped={grouped} />
            </div>
          ))}
          <LiveTail threadId={threadId} busy={busy} onGrow={followIfPinned} />
          {queued > 0 && (
            <div className="queued-note">
              {queued} message{queued > 1 ? "s" : ""} queued — will send when the agent is free
            </div>
          )}
        </div>
        {away && (
          <button className="jump-pill" onClick={() => scrollToBottom(true)}>
            <i className="ph ph-arrow-down" />
            {unseen > 0 ? `${unseen} new message${unseen > 1 ? "s" : ""}` : "Jump to latest"}
          </button>
        )}
      </div>
      {sendError && (
        <div className="send-error">
          <i className="ph ph-warning" />
          Couldn't send — {sendError}. Draft restored.
          <button onClick={() => send()}>Retry</button>
        </div>
      )}
      <div className="composer">
        <div className="box">
          <textarea
            value={draft}
            placeholder={busy ? "Queue a message — sends when the agent finishes…" : placeholder}
            onChange={(e) => setDraftPersist(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn btn-primary small-btn" onClick={() => send()} disabled={!draft.trim()}>
            {busy ? "Queue" : "Send"}
          </button>
        </div>
      </div>
    </>
  );
}
