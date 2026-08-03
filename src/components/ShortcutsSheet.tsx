const IS_MAC = navigator.userAgent.includes("Mac");
const MOD = IS_MAC ? "⌘" : "Ctrl";

const GROUPS: { title: string; rows: [string, string[]][] }[] = [
  {
    title: "Anywhere",
    rows: [
      ["Capture selected text", ["Left Shift", "Left Shift"]],
      ["Show / hide Cooper", ["Right Shift", "Right Shift"]],
      ["Show / hide (fallback)", [`${MOD} Shift Space`]],
      ["Capture (fallback)", [`${MOD} Shift C`]],
    ],
  },
  {
    title: "In Cooper",
    rows: [
      ["Switch section", [`${MOD} K`]],
      ["Copy selected", [`${MOD} C`]],
      ["Copy as list", [`${MOD} ⇧ C`]],
      ["Mark as done", ["Space"]],
      ["Edit", ["Enter"]],
      ["Delete", ["Del"]],
      ["Navigate", ["↑", "↓"]],
      ["This sheet", [`${MOD} /`]],
      ["Hide panel", ["Esc"]],
    ],
  },
];

export default function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sheet-title">Shortcuts</div>
        {GROUPS.map((g) => (
          <div key={g.title} className="sheet-group">
            <div className="sheet-group-title">{g.title}</div>
            {g.rows.map(([label, keys]) => (
              <div key={label} className="sheet-row">
                <span>{label}</span>
                <span className="sheet-keys">
                  {keys.map((k, i) => (
                    <kbd key={i}>{k}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
