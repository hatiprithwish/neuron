import type * as Schemas from "@app/schemas";

const BASE_URL = import.meta.env.VITE_API_URL;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Schemas.ApiResponse,
  ) {
    super(body.message ?? `API error ${status}`);
    this.name = "ApiError";
  }
}

// DEV_NOTE: getToken is passed as a param (not called via useAuth() here) because this is a plain async function — hooks can only run inside React components/hooks.
export async function apiClient<T>(
  path: string,
  getToken: (() => Promise<string | null>) | null,
  options?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  const token = getToken ? await getToken() : null;

  // DEV_NOTE: a FormData body sets its own multipart Content-Type, boundary included — setting
  // application/json over it makes the server unable to parse the parts (image uploads).
  const isFormData = options?.body instanceof FormData;

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    // DEV_NOTE:signal is provided by TanStack Query — it aborts the fetch automatically when the component unmounts or the query is cancelled/re-triggered.
    signal: options?.signal,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  const body = (await res.json()) as T & Schemas.ApiResponse;

  if (!res.ok || !body.isSuccess) {
    throw new ApiError(res.status, body as Schemas.ApiResponse);
  }

  return body;
}
