import type { ReactNode } from "react";
import "./workspace-view-layout.css";

type Props = { activeView: "code" | "terminals"; code: ReactNode; terminal: ReactNode };

export function WorkspaceViewLayout({ activeView, code, terminal }: Props) {
  return <div className="workspace-view-layout">
    <div className="workspace-view-code" hidden={activeView !== "code"}>{code}</div>
    <div className="workspace-view-terminal" hidden={activeView !== "terminals"}>{terminal}</div>
  </div>;
}
