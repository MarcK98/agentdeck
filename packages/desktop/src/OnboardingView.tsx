import { useState } from "react";
import Brand from "./Brand";

// First-run setup (mockup: 3 steps). Visual/onboarding flow — picks a projects
// root, sets defaults (model/effort/approvals/isolation), and enables the team
// lead. State is local; "Finish" marks onboarding complete. Actual repo import
// happens through the daemon once a root is chosen in Settings.

const STEPS = ["Projects", "Defaults", "Team lead"];
const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SAMPLE_REPOS = [
  ["agentdeck", "TS"],
  ["fable-engine", "TS"],
  ["relay", "JS"],
  ["site-refresh", "CSS"],
  ["mobile", "TSX"],
  ["infra", "HCL"],
];

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <span className={`onb-chip ${on ? "on" : ""}`} onClick={onClick}>
      {children}
    </span>
  );
}

export default function OnboardingView({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState("~/Documents/projects");
  const [scanned, setScanned] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(SAMPLE_REPOS.map((r) => r[0])));
  const [allowed, setAllowed] = useState<Set<string>>(new Set(["opus", "sonnet", "haiku"]));
  const [defModel, setDefModel] = useState("auto");
  const [effort, setEffort] = useState("high");
  const [approvals, setApprovals] = useState("ask");
  const [isolation, setIsolation] = useState(true);
  const [teamLead, setTeamLead] = useState(true);

  const toggle = (set: Set<string>, v: string, apply: (s: Set<string>) => void) => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    apply(n);
  };

  const next = () => (step < STEPS.length - 1 ? setStep(step + 1) : onDone());
  const nextLabel = step < STEPS.length - 1 ? "Continue" : "Finish setup";

  return (
    <div className="auth-screen onboarding">
      <div className="onb-nav">
        <div className="onb-brand">
          <Brand s={12} glow={false} />
          <span>Setup</span>
        </div>
        <div className="onb-steps">
          {STEPS.map((s, i) => (
            <div key={s} className={`onb-step ${i === step ? "on" : ""}`} onClick={() => setStep(i)}>
              <span className="num">{i + 1}</span>
              <span className="lbl">{s}</span>
            </div>
          ))}
        </div>
        <button className="linklike onb-skip" onClick={onDone}>
          Skip setup →
        </button>
      </div>

      <div className="onb-main">
        <div className="onb-body">
          {step === 0 && (
            <>
              <h2 className="onb-h">Where do your projects live?</h2>
              <p className="onb-p">
                AgentDeck watches one root directory. Every repo inside becomes a project agents can be delegated
                into — each on its own branch and worktree. Pick which to import.
              </p>
              <div className="onb-dir">
                <input className="key-input" value={dir} onChange={(e) => setDir(e.target.value)} />
                <button className="btn btn-primary" onClick={() => setScanned(true)}>
                  {scanned ? "Rescan" : "Scan"}
                </button>
              </div>
              {scanned && (
                <>
                  <div className="onb-count">
                    <span className="mono cyan">
                      {picked.size} OF {SAMPLE_REPOS.length} REPOS SELECTED
                    </span>
                    <div className="line" />
                    <button className="linklike accent" onClick={() => setPicked(new Set(SAMPLE_REPOS.map((r) => r[0])))}>
                      All
                    </button>
                    <button className="linklike" onClick={() => setPicked(new Set())}>
                      None
                    </button>
                  </div>
                  <div className="onb-repos">
                    {SAMPLE_REPOS.map(([name, lang]) => {
                      const on = picked.has(name);
                      return (
                        <div
                          key={name}
                          className={`onb-repo ${on ? "on" : ""}`}
                          onClick={() => toggle(picked, name, setPicked)}
                        >
                          <span className="mark">{on ? "✓" : ""}</span>
                          <span className="rname">{name}</span>
                          <span className="rlang mono">{lang}</span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="onb-h">Defaults for every project</h2>
              <p className="onb-p">
                These apply to all imported projects. Any project can override any of them later in Settings — the
                badge shows you where.
              </p>
              <div className="onb-fields">
                <div>
                  <div className="onb-flabel mono">ALLOWED MODELS</div>
                  <div className="onb-chips">
                    {MODELS.map((m) => (
                      <Chip key={m} on={allowed.has(m)} onClick={() => toggle(allowed, m, setAllowed)}>
                        {m}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="onb-flabel mono">DEFAULT MODEL — THE TEAM LEAD RIGHT-SIZES PER TASK</div>
                  <div className="onb-chips">
                    {["auto", ...MODELS].map((m) => (
                      <Chip key={m} on={defModel === m} onClick={() => setDefModel(m)}>
                        {m}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="onb-flabel mono">DEFAULT EFFORT</div>
                  <div className="onb-chips">
                    {EFFORTS.map((e) => (
                      <Chip key={e} on={effort === e} onClick={() => setEffort(e)}>
                        {e}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="onb-flabel mono">APPROVALS</div>
                  <div className="onb-chips">
                    {["ask", "auto"].map((a) => (
                      <Chip key={a} on={approvals === a} onClick={() => setApprovals(a)}>
                        {a === "ask" ? "ask every time" : "auto-approve"}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div className="onb-toggle">
                  <div>
                    <div className="tt">Worktree per ticket</div>
                    <div className="ts">agents never touch your checkout</div>
                  </div>
                  <button className={`toggle ${isolation ? "on" : ""}`} onClick={() => setIsolation(!isolation)} />
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="onb-h">Meet your team lead</h2>
              <p className="onb-p">
                One standing agent that manages the rest. You talk to the board; the team lead does the routing.
              </p>
              <div className="onb-lead">
                <div className="lead-head">
                  <span className="dot-live pulse" style={{ background: "#8f88ff" }} />
                  <span className="lead-title">Enable the team-lead agent</span>
                  <button className={`toggle ${teamLead ? "on" : ""}`} onClick={() => setTeamLead(!teamLead)} />
                </div>
                <div className="lead-points">
                  <div>
                    <span className="b">▸</span>Triages every new ticket and picks the right model + effort
                  </div>
                  <div>
                    <span className="b">▸</span>Wakes when you comment on a ticket — from desktop or phone
                  </div>
                  <div>
                    <span className="b">▸</span>Posts progress back to the board and opens the PR when done
                  </div>
                  <div>
                    <span className="b">▸</span>Runs on your subscription like everything else — no extra fee
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="onb-foot">
          {step > 0 && (
            <button className="btn btn-secondary" onClick={() => setStep(step - 1)}>
              ‹ Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn btn-grad" onClick={next}>
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
