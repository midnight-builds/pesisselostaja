import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { LiveState } from "../shared/types";
import { connectLive, type LiveConnectionStatus } from "./api";
import { TabBar, type TabId } from "./components/TabBar";
import { Toast, type ToastMessage } from "./components/Toast";
import { JobView } from "./views/JobView";
import { LiveView } from "./views/LiveView";
import { LogView } from "./views/LogView";
import { MatchesView } from "./views/MatchesView";

/** App shell: one SSE-backed LiveState for the whole UI, plus tab state.
 *  No router — four tabs do not justify a dependency, and a URL-less shell is
 *  what an installed PWA behaves like anyway.
 *
 *  All four views stay MOUNTED; the tab only decides which one is displayed.
 *  Unmounting them threw away each view's own state — the Ottelut filters and
 *  ticks, the log level, the selected job — and refetched the day on the way
 *  back. On a camp day of 200 matches that means re-picking the field filter
 *  every single time the operator glances at Live, which is a thing they do
 *  constantly mid-broadcast. The state lives where it is used; only its
 *  visibility is lifted here. */

export function App() {
  const [live, setLive] = useState<LiveState | null>(null);
  const [connection, setConnection] = useState<LiveConnectionStatus>("connecting");
  const [tab, setTab] = useState<TabId>("live");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [jobReloadToken, setJobReloadToken] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => connectLive({ onState: setLive, onStatus: setConnection }), []);

  const notify = useCallback((kind: "ok" | "error", text: string) => {
    setToast({ id: Date.now(), kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    // Errors linger; confirmations get out of the way fast.
    toastTimer.current = setTimeout(() => setToast(null), kind === "error" ? 8000 : 3000);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  const alert = live?.health === "fail" || connection === "down";

  return (
    <div className="app">
      <div className="safe-top" />
      <header className="topbar">
        <span className="topbar__title">Ohjaamo</span>
        <span className="topbar__spacer" />
        <span className={`conn conn--${connection}`}>
          {connection === "open" ? "yhteys ok" : connection === "connecting" ? "yhdistetään" : "yhteys poikki"}
        </span>
      </header>

      <main className="scroll">
        <TabPanel id="live" active={tab === "live"}>
          <LiveView live={live} connection={connection} notify={notify} />
        </TabPanel>
        <TabPanel id="matches" active={tab === "matches"}>
          <MatchesView
            notify={notify}
            onJobCreated={() => {
              setJobReloadToken((n) => n + 1);
              setTab("job");
            }}
          />
        </TabPanel>
        <TabPanel id="job" active={tab === "job"}>
          <JobView live={live} notify={notify} reloadToken={jobReloadToken} />
        </TabPanel>
        <TabPanel id="log" active={tab === "log"}>
          <LogView lines={live?.log ?? []} notify={notify} />
        </TabPanel>
      </main>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <TabBar active={tab} onChange={setTab} alert={alert} />
    </div>
  );
}

/** One always-mounted view, shown or hidden.
 *
 *  The wrapper is `display: contents` when shown, so it adds no box of its own
 *  and each view lays out inside the scroll region exactly as it did when the
 *  shell rendered it directly — including the log view's height: 100%. When
 *  hidden it is `display: none`, which also takes it out of the accessibility
 *  tree, so a hidden view's buttons cannot be focused or read out. */
function TabPanel({
  id,
  active,
  children,
}: {
  id: TabId;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div className="tabpanel" data-view={id} hidden={!active}>
      {children}
    </div>
  );
}
