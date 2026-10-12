export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const multipart = data instanceof FormData;
  const res = await fetch("/menu/api" + path, {
    method,
    credentials: "same-origin",
    headers:
      data && !multipart ? { "Content-Type": "application/json" } : undefined,
    body: data ? (multipart ? data : JSON.stringify(data)) : undefined,
  });
  const result = await res
    .json()
    .catch(() => ({ error: "服务响应异常，请稍后重试" }));
  if (
    res.status === 401 &&
    !["/auth/login", "/auth/register", "/auth/me"].includes(path)
  )
    window.dispatchEvent(new Event("shiji-session-expired"));
  if (!res.ok)
    throw new ApiError(
      result.error || "请求失败",
      result.code || "",
      res.status,
    );
  return result as T;
}
