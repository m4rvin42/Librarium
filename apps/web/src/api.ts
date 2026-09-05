let csrf = '';
export const setCsrf = (value: string) => {
  csrf = value;
};
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(init.method || 'GET')) headers.set('x-csrf-token', csrf);
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(data?.error?.message || data?.message || `Request failed (${response.status})`);
  return data;
}
