import { useMemo, useState } from 'react';
import {
  Braces,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
} from 'lucide-react';
import type { FileNode } from '../api/types';

function FileTypeIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const className = 'shrink-0 text-zinc-400 dark:text-zinc-500';
  if (ext === 'md' || ext === 'txt') return <FileText size={15} className={className} />;
  if (ext === 'json') return <Braces size={15} className={className} />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'].includes(ext)) {
    return <FileImage size={15} className={className} />;
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'html', 'sql', 'yml', 'yaml'].includes(ext))
    return <FileCode2 size={15} className={className} />;
  return <File size={15} className={className} />;
}

function flattenFiles(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n);
    else if (n.children) flattenFiles(n.children, out);
  }
  return out;
}

interface NodeRowProps {
  node: FileNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  expanded: Record<string, boolean>;
  toggle: (path: string, currentlyOpen: boolean) => void;
}

function NodeRow({ node, depth, selected, onSelect, expanded, toggle }: NodeRowProps) {
  const isDir = node.type === 'dir';
  const open = expanded[node.path] ?? depth < 2;
  const isSelected = selected === node.path;

  return (
    <div>
      <button
        type="button"
        onClick={() => (isDir ? toggle(node.path, open) : onSelect(node.path))}
        style={{ paddingLeft: depth * 14 + 8 }}
        title={node.path}
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] transition-colors ${
          isSelected
            ? 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-200'
            : 'text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800'
        }`}
      >
        {isDir ? (
          open ? (
            <FolderOpen size={15} className="shrink-0 text-amber-500 dark:text-amber-400" />
          ) : (
            <Folder size={15} className="shrink-0 text-amber-500 dark:text-amber-400" />
          )
        ) : (
          <FileTypeIcon name={node.name} />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir && open && node.children && (
        <div>
          {node.children.map((child) => (
            <NodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({
  tree,
  selected,
  onSelect,
  filter,
}: {
  tree: FileNode[];
  selected: string | null;
  onSelect: (path: string) => void;
  filter?: string;
}) {
  // Overrides explícitos de expandido; por defecto, expandidos los 2 primeros niveles.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggle = (path: string, currentlyOpen: boolean) =>
    setExpanded((prev) => ({ ...prev, [path]: !currentlyOpen }));

  const q = (filter ?? '').trim().toLowerCase();
  const flat = useMemo(() => (q ? flattenFiles(tree).filter((n) => n.name.toLowerCase().includes(q)) : []), [tree, q]);

  if (q) {
    return (
      <div>
        {flat.length === 0 && (
          <p className="px-3 py-4 text-xs text-zinc-400 dark:text-zinc-500">—</p>
        )}
        {flat.map((n) => {
          const isSelected = selected === n.path;
          return (
            <button
              key={n.path}
              type="button"
              onClick={() => onSelect(n.path)}
              title={n.path}
              className={`flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-left text-[13px] ${
                isSelected
                  ? 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-200'
                  : 'text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800'
              }`}
            >
              <FileTypeIcon name={n.name} />
              <span className="truncate">{n.name}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div>
      {tree.map((n) => (
        <NodeRow
          key={n.path}
          node={n}
          depth={0}
          selected={selected}
          onSelect={onSelect}
          expanded={expanded}
          toggle={toggle}
        />
      ))}
    </div>
  );
}
