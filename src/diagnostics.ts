export function diagnostic(context: string, error: unknown) {
  const value = error as { name?: unknown; code?: unknown; errno?: unknown } | null;
  const safe = (input: unknown) => typeof input === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(input) ? input : 'unknown';
  console.error(`${context}: name=${safe(value?.name)} code=${safe(value?.code)} errno=${typeof value?.errno === 'number' ? value.errno : 'unknown'}`);
}
