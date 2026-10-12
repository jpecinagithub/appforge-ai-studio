import Editor from '@monaco-editor/react';
import { useTheme } from '../theme';
import { Spinner } from './ui';

function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'css':
    case 'scss':
      return 'css';
    case 'html':
      return 'html';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'sql':
      return 'sql';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'svg':
    case 'xml':
      return 'xml';
    default:
      return 'plaintext';
  }
}

export function CodeEditor({
  value,
  onChange,
  path,
  readOnly,
}: {
  value: string;
  onChange?: (v: string) => void;
  path: string;
  readOnly?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <Editor
      height="100%"
      language={languageFor(path)}
      theme={theme === 'dark' ? 'vs-dark' : 'light'}
      value={value}
      onChange={(v) => onChange?.(v ?? '')}
      loading={<Spinner />}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        automaticLayout: true,
        readOnly: !!readOnly,
        scrollBeyondLastLine: false,
        padding: { top: 8 },
      }}
    />
  );
}
