import type { ReactNode } from "react";
import "./workspace-view-layout.css";

export type WorkspaceMainView = "code" | "terminals" | "graph";

type Props = { activeView: WorkspaceMainView; code: ReactNode; terminal: ReactNode; graph: ReactNode };

export function WorkspaceViewLayout({ activeView, code, terminal, graph }: Props) {
  return <div className="workspace-view-layout">
    <div className="workspace-view-code" hidden={activeView !== "code"}>{code}</div>
    <div className="workspace-view-terminal" hidden={activeView !== "terminals"}>{terminal}</div>
    <div className="workspace-view-graph" hidden={activeView !== "graph"}>{graph}</div>
  </div>;
}
