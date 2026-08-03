import Editor from "./components/Editor";
import Panel from "./components/Panel";

export default function App() {
  const hash = window.location.hash;
  if (hash.startsWith("#/edit/")) {
    const id = parseInt(hash.slice("#/edit/".length), 10);
    if (!Number.isNaN(id)) return <Editor id={id} />;
  }
  return <Panel />;
}
