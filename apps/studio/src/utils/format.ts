export function formatDateTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(lang === 'es' ? 'es-ES' : 'en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${rest}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

export function timeAgo(iso: string, lang: string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const diffMin = Math.max(0, Math.round((Date.now() - d) / 60000));
  if (diffMin < 1) return lang === 'es' ? 'ahora mismo' : 'just now';
  if (diffMin < 60) return lang === 'es' ? `hace ${diffMin} min` : `${diffMin} min ago`;
  const h = Math.floor(diffMin / 60);
  if (h < 24) return lang === 'es' ? `hace ${h} h` : `${h}h ago`;
  const days = Math.floor(h / 24);
  return lang === 'es' ? `hace ${days} d` : `${days}d ago`;
}
