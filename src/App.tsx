import { getCurrentWindow } from "@tauri-apps/api/window";
import DrawWindow from "./components/DrawWindow";
import Editor from "./components/Editor";
import Panel from "./components/Panel";

// Route by the native window label (set in Rust) rather than a URL fragment,
// which can fail to load for secondary windows on Windows.
export default function App() {
  const label = getCurrentWindow().label;
  if (label === "draw") return <DrawWindow />;
  if (label.startsWith("editor-")) {
    const id = parseInt(label.slice("editor-".length), 10);
    if (!Number.isNaN(id)) return <Editor id={id} />;
  }
  return <Panel />;
}
