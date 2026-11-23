import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shared WCAG contrast helpers for the style guards: theme tokens are read from src/styles/themes.css. */
export const THEMES = ["obsidian", "nordic", "foundry"] as const;
export const SURFACES = ["--theme-background", "--theme-surface", "--theme-raised", "--theme-chrome", "--theme-editor", "--theme-terminal"];

/** WCAG 2.x relative luminance and contrast ratio. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseDeclarations(body: string): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const part of body.split(";")) {
    const match = part.match(/^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/s);
    if (match) decls[match[1]] = match[2];
  }
  return decls;
}

/** Effective custom properties per theme: the shared `.app-shell[data-theme]` block, then the theme block. */
export function themeTokens(): Record<string, Record<string, string>> {
  const themesCss = stripComments(readFileSync(join(process.cwd(), "src", "styles", "themes.css"), "utf8"));
  const base: Record<string, string> = {};
  const overrides: Record<string, Record<string, string>> = {};
  for (const match of themesCss.matchAll(/\.app-shell\[data-theme(?:="(\w+)")?\]\s*\{([^}]*)\}/g)) {
    const [, theme, body] = match;
    const decls = parseDeclarations(body);
    if (theme) overrides[theme] = { ...(overrides[theme] ?? {}), ...decls };
    else Object.assign(base, decls);
  }
  return Object.fromEntries(THEMES.map((theme) => [theme, { ...base, ...(theme === "obsidian" ? {} : overrides[theme]) }]));
}
