import { DiffView } from "../features/git/DiffView";
import "../styles/app.css";
import "../styles/themes.css";
import "../styles/git-ux.css";

// Real git diff output captured from a throwaway sample repository:
// meta lines, hunk header, added/removed/context lines, a fully empty line,
// a whitespace-only line, a tab-indented line, a 300+ character line,
// unicode (ğüşöİı) and one CRLF-terminated line.
const MOCK_DIFF = "diff --git a/settings.json b/settings.json\nindex 88f36bc..5022d32 100644\n--- a/settings.json\n+++ b/settings.json\n@@ -1,12 +1,20 @@\n {\n   \"name\": \"yerminal-sample\",\n-  \"version\": \"1.4.2\",\n+  \"version\": \"1.5.0\",\n   \"features\": {\n     \"autoSave\": true,\n-    \"minimap\": true,\n-    \"tabSize\": 4\n+    \"minimap\": false,\n+    \"tabSize\": 4,\n+    \"diffGutter\": true\n   },\n-  \"paths\": [\"src\", \"src-tauri\"],\n+\t\"experimental\": \"value indented with a real tab character\",\n+  \"paths\": [\"src\", \"src-tauri\", \"scripts\"],\n   \"locale\": \"tr-TR\",\n-  \"notes\": \"Base configuration committed to the sample repository.\"\n+  \"unicode\": \"ğüşöİıçÇ — Türkçe karakter denemesi: başlık örüntüsü\",\n+  \"long\": \"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\",\n+\n+   \n+  \"\",\n+   ,\n+  \"crlf\": \"this line terminates with CRLF\"\r\n }\n";

export function DiffMock() {
  return <main style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", placeItems: "center", height: "100%", padding: 32, overflow: "hidden" }}>
    <section
      aria-label="Diff view mock"
      style={{ width: "min(1180px, 100%)", minWidth: 0, height: 600, display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--theme-border, #34343c)", borderRadius: 10, background: "var(--theme-editor, #101114)" }}
    >
      <DiffView diff={MOCK_DIFF} path="config/settings.json" root="C:/dev/sample-repo" staged={false} emptyMessage="No diff available." />
    </section>
  </main>;
}
