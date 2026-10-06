export function networkError(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const item = current as { name?: string; code?: string; cause?: unknown };
    const code = item.code ?? '';
    if (['AbortError', 'TimeoutError'].includes(item.name ?? '') || code === 'ETIMEDOUT') return 'CLOUD_TIMEOUT';
    if (['ENOTFOUND', 'EAI_AGAIN', 'DNS_ENOTFOUND'].includes(code)) return 'CLOUD_DNS_FAILURE';
    if (/^(ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_SSL_)/.test(code)) return 'CLOUD_TLS_FAILURE';
    if (code === 'ECONNREFUSED') return 'CLOUD_CONNECTION_REFUSED';
    if (code === 'ECONNRESET') return 'CLOUD_CONNECTION_RESET';
    current = item.cause;
  }
  return 'CLOUD_UNAVAILABLE';
}
