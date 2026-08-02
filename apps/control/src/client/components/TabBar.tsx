/** Bottom navigation. Fixed to the bottom edge with the home-indicator inset
 *  added as padding, and every target is at least 44 px tall. */

export type TabId = "live" | "matches" | "job" | "youtube" | "log" | "settings" | "proto";

const TABS: Array<{ id: TabId; label: string; icon: string }> = [
  // PROTOTYPE (#173) — poistuu tämän haaran mukana
  { id: "proto", label: "Luonnos", icon: "✎" },
  { id: "live", label: "Live", icon: "●" },
  { id: "matches", label: "Ottelut", icon: "▦" },
  { id: "job", label: "Työ", icon: "▶" },
  { id: "youtube", label: "YouTube", icon: "▷" },
  { id: "log", label: "Loki", icon: "≡" },
  { id: "settings", label: "Asetukset", icon: "⚙" },
];

interface Props {
  active: TabId;
  onChange: (tab: TabId) => void;
  /** Red pip on the Live tab when something is wrong elsewhere in the app. */
  alert?: boolean;
}

export function TabBar({ active, onChange, alert }: Props) {
  return (
    <nav className="tabbar">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tabbar__btn ${active === tab.id ? "tabbar__btn--on" : ""}`}
          onClick={() => onChange(tab.id)}
          aria-current={active === tab.id}
        >
          <span className="tabbar__icon" aria-hidden="true">
            {tab.icon}
            {tab.id === "live" && alert && <span className="tabbar__pip" />}
          </span>
          <span className="tabbar__label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
