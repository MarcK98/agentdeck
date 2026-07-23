import { useState } from "react";
import Brand from "./Brand";

// Sign-in gate (mockup: "Sign in to AgentDeck"). AgentDeck is bring-your-own-
// subscription: agents run on the user's own Claude account, so "login"
// authorizes Anthropic rather than creating an AgentDeck account. The provider
// button opens Anthropic's own auth in the browser (the daemon's `claude`
// CLI owns the actual OAuth handshake); pasting a key or exploring the demo both
// complete locally. Real in-app OAuth token capture needs a registered provider
// client ID — tracked as a blocker in the SPWN-39 spec. ChatGPT + Google login
// are deferred (SPWN-39 scope cut) — Anthropic only for now.

type Provider = { id: string; name: string; mark: string; markC: string; sub: string; url: string };

const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    mark: "✦",
    markC: "#d97757",
    sub: "run agents on your Claude Pro / Max plan",
    url: "https://claude.ai/login",
  },
];

export default function LoginView({ onAuthed }: { onAuthed: () => void }) {
  const [connecting, setConnecting] = useState<Provider | null>(null);
  const [apiKey, setApiKey] = useState("");

  const startProvider = (p: Provider) => {
    setConnecting(p);
    try {
      window.agentdeck.openExternal?.(p.url);
    } catch {
      /* browser mock — no external open */
    }
  };

  return (
    <div className="auth-screen login">
      <div className="auth-card">
        <div className="auth-head">
          <Brand s={22} />
          <div className="auth-title">Sign in to AgentDeck</div>
          <div className="auth-sub">
            Bring your own subscription. Your keys and your code stay on machines you control.
          </div>
        </div>

        {connecting ? (
          <div className="auth-connecting">
            <div className="conn-line">
              <span className="dot-live pulse" />
              Authorizing with {connecting.name}…
            </div>
            <div className="conn-note">a browser window opened — approve there, then continue</div>
            <button className="btn btn-primary btn-block" onClick={onAuthed}>
              I&apos;ve authorized — continue
            </button>
            <button className="linklike" onClick={() => setConnecting(null)}>
              ← use a different method
            </button>
          </div>
        ) : (
          <>
            <div className="provider-list">
              {PROVIDERS.map((p) => (
                <button key={p.id} className="provider-row" onClick={() => startProvider(p)}>
                  <span className="pmark" style={{ color: p.markC }}>
                    {p.mark}
                  </span>
                  <div className="pbody">
                    <div className="pname">Continue with {p.name}</div>
                    <div className="psub">{p.sub}</div>
                  </div>
                  <span className="pchev">›</span>
                </button>
              ))}
            </div>

            <div className="auth-or">
              <div className="line" />
              <span>OR PASTE AN API KEY</span>
              <div className="line" />
            </div>
            <div className="auth-key">
              <input
                className="key-input"
                placeholder="sk-ant-… / sk-…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && apiKey.trim()) onAuthed();
                }}
              />
              <button className="btn btn-primary" disabled={!apiKey.trim()} onClick={() => apiKey.trim() && onAuthed()}>
                Continue
              </button>
            </div>
          </>
        )}

        <div className="auth-foot">
          MIT-licensed · self-host with <span className="mono">agentdeck auth login</span>
          <br />
          <button className="linklike accent" onClick={onAuthed}>
            Explore the demo without signing in →
          </button>
        </div>
      </div>
    </div>
  );
}
