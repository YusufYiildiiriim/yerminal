export type TreeChange = { path: string; kind: string; staged: boolean; unstaged: boolean };

export type ChangeTreeNode<T extends TreeChange = TreeChange> =
  | { kind: "dir"; name: string; path: string; children: ChangeTreeNode<T>[]; files: T[] }
  | { kind: "file"; name: string; change: T };

type MutableDir<T extends TreeChange> = { name: string; path: string; dirs: Map<string, MutableDir<T>>; files: T[] };

/**
 * Groups changed files by folder, like VS Code's "View as Tree". Folders come first, entries are
 * sorted by name, and a folder that only contains another folder is shown as one `a/b/c` row.
 */
export function buildChangeTree<T extends TreeChange>(changes: T[]): ChangeTreeNode<T>[] {
  const root: MutableDir<T> = { name: "", path: "", dirs: new Map(), files: [] };
  for (const change of changes) {
    const segments = change.path.split("/").filter(Boolean);
    let cursor = root;
    for (const segment of segments.slice(0, -1)) {
      let next = cursor.dirs.get(segment);
      if (!next) {
        next = { name: segment, path: cursor.path ? `${cursor.path}/${segment}` : segment, dirs: new Map(), files: [] };
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push(change);
  }
  return convert(root);
}

function allFiles<T extends TreeChange>(dir: MutableDir<T>): T[] {
  return [...dir.files, ...[...dir.dirs.values()].flatMap(allFiles)];
}

function convert<T extends TreeChange>(dir: MutableDir<T>): ChangeTreeNode<T>[] {
  const folders: ChangeTreeNode<T>[] = [...dir.dirs.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((child) => {
      let current = child;
      let name = child.name;
      while (current.files.length === 0 && current.dirs.size === 1) {
        current = [...current.dirs.values()][0];
        name = `${name}/${current.name}`;
      }
      return { kind: "dir", name, path: current.path, children: convert(current), files: allFiles(current) } as ChangeTreeNode<T>;
    });
  const files: ChangeTreeNode<T>[] = [...dir.files]
    .sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)))
    .map((change) => ({ kind: "file", name: baseName(change.path), change }) as ChangeTreeNode<T>);
  return [...folders, ...files];
}

export function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
