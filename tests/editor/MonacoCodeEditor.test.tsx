vi.unmock("../../src/features/editor/MonacoCodeEditor");
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const runtime = vi.hoisted(() => ({ load: vi.fn(), ensure: vi.fn(async () => "typescript"), setEnabled: vi.fn(), changed: null as null | (() => void), command: null as null | (() => void), value: "", model: null as any, instance: null as any, create: vi.fn() }));
vi.mock("../../src/features/editor/monacoRuntime", () => ({ loadMonaco: runtime.load }));
import { MonacoCodeEditor } from "../../src/features/editor/MonacoCodeEditor";

beforeEach(() => {
  runtime.changed = null;
  runtime.model = { getValue: () => runtime.value, setValue: vi.fn((value: string) => { runtime.value = value; runtime.changed?.(); }), updateOptions: vi.fn(), dispose: vi.fn() };
  runtime.instance = { onDidChangeModelContent: vi.fn((callback: () => void) => { runtime.changed = callback; return { dispose: vi.fn() }; }), addCommand: vi.fn((_key: number, callback: () => void) => { runtime.command = callback; }), updateOptions: vi.fn(), dispose: vi.fn() };
  runtime.create.mockImplementation(() => runtime.instance);
  runtime.load.mockResolvedValue({ monaco: { editor: { createModel: vi.fn((value: string) => { runtime.value = value; return runtime.model; }), create: runtime.create, setModelLanguage: vi.fn(), defineTheme: vi.fn(), setTheme: vi.fn() }, Uri: { parse: (value: string) => value }, KeyMod: { CtrlCmd: 2048 }, KeyCode: { KeyS: 49 } }, languages: { ensure: runtime.ensure, setEnabled: runtime.setEnabled } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const base = { id: "tab-1", path: "C:/repo/a.ts", name: "a.ts", value: "const a = 1;", readOnly: false, enabledLanguages: ["typescript"] as const, fontFamily: "Consolas", fontSize: 13, theme: "obsidian" as const, onChange: vi.fn(), onSave: vi.fn() };

describe("Monaco editor lifecycle", () => {
  it("forwards edits and save to the latest callbacks without recreating the model", async () => {
    const view = render(<MonacoCodeEditor {...base} />);
    await waitFor(() => expect(runtime.instance.addCommand).toHaveBeenCalled());
    const changed = vi.fn(); const save = vi.fn();
    view.rerender(<MonacoCodeEditor {...base} onChange={changed} onSave={save} />);
    act(() => { runtime.value = "new value"; runtime.changed?.(); runtime.command?.(); });
    expect(changed).toHaveBeenCalledWith("new value"); expect(save).toHaveBeenCalledOnce();
    expect(runtime.load).toHaveBeenCalledTimes(1);
  });
  it("does not echo external content changes and does not reset identical content", async () => {
    const onChange = vi.fn();
    const view = render(<MonacoCodeEditor {...base} onChange={onChange} />);
    await waitFor(() => expect(runtime.instance.addCommand).toHaveBeenCalled());
    view.rerender(<MonacoCodeEditor {...base} onChange={onChange} value="disk update" />);
    expect(runtime.model.setValue).toHaveBeenCalledWith("disk update");
    expect(onChange).not.toHaveBeenCalled();
    runtime.model.setValue.mockClear();
    view.rerender(<MonacoCodeEditor {...base} onChange={onChange} value="disk update" fontSize={18} />);
    expect(runtime.model.setValue).not.toHaveBeenCalled();
    expect(runtime.instance.updateOptions).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 18 }));
  });
  it("keeps snapshots read-only and releases the editor and model on close", async () => {
    const onChange = vi.fn(); const onSave = vi.fn();
    const view = render(<MonacoCodeEditor {...base} readOnly onChange={onChange} onSave={onSave} />);
    await waitFor(() => expect(runtime.instance.addCommand).toHaveBeenCalled());
    act(() => { runtime.changed?.(); runtime.command?.(); });
    expect(onChange).not.toHaveBeenCalled(); expect(onSave).not.toHaveBeenCalled();
    view.unmount(); expect(runtime.instance.dispose).toHaveBeenCalledOnce(); expect(runtime.model.dispose).toHaveBeenCalledOnce();
  });
  it("does not create an editor after a pending import resolves on a closed tab", async () => {
    let resolve!: (value: unknown) => void;
    const loaded = await runtime.load(); runtime.load.mockClear();
    runtime.load.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const view = render(<MonacoCodeEditor {...base} />); view.unmount();
    await act(async () => resolve(loaded));
    expect(loaded.monaco.editor.create).not.toHaveBeenCalled();
  });
  it("keeps Monaco's built-in minimap enabled", async () => {
    render(<MonacoCodeEditor {...base} />);
    await waitFor(() => expect(runtime.create).toHaveBeenCalled());
    expect(runtime.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ minimap: { enabled: true } }));
  });
  it("shows an actionable error when the editor fails to load", async () => {
    runtime.load.mockRejectedValueOnce(new Error("chunk unavailable"));
    render(<MonacoCodeEditor {...base} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the editor");
  });
});
