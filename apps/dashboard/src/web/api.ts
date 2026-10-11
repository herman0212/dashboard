import type { ApiErrorResponse, ApiResponse, ControlCapabilities } from '../contracts.js';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function controlPost<T>(url: string, body: unknown): Promise<T> {
  // Fetch a current token for every action, including retries after a server restart.
  const capabilities = await get<ControlCapabilities>('/api/control/capabilities', new AbortController().signal);
  if (!capabilities.data) throw new Error('Scan controls are unavailable.');
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-astra-control': capabilities.data.csrfToken },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json()) as ApiErrorResponse;
    throw new ApiError(response.status, error.error.code, error.error.message);
  }
  const result = (await response.json()) as ApiResponse<T>;
  if (!result.data) throw new Error('Control operation response is unavailable.');
  return result.data;
}
export async function get<T>(url: string, signal: AbortSignal): Promise<ApiResponse<T>> {
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) {
    const body = (await response.json()) as ApiErrorResponse;
    throw new ApiError(
      response.status,
      body.error?.code ?? 'ReadUnavailable',
      body.error?.message ?? 'Data is unavailable.',
    );
  }
  return response.json() as Promise<ApiResponse<T>>;
}
