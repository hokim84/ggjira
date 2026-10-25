// Fetch wrapper for the Router's admin and setup APIs. The token lives in sessionStorage only.

const TOKEN_KEY = "ggjira.router.token";
let memoryToken = null;
let localUiAccess = false;
export function setLocalUiAccess(enabled) {
  localUiAccess = enabled === true;
}

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode etc.: the token then lasts until reload only.
  }
  memoryToken = token || null;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error;
    this.issues = body?.issues || [];
    this.currentTargetId = body?.currentTargetId;
  }
}

export async function request(method, url, body, extraHeaders = {}) {
  const token = getToken();
  const headers = { ...extraHeaders };
  if (localUiAccess) headers["x-ggjira-local-ui"] = "1";
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: "bad_response", message: text.slice(0, 200) };
    }
  }
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

/** `actor`: the name recorded in audit and review records (the CLI sends the OS user name).
 *  Percent-encoded: headers carry only ISO-8859-1 and names are often Korean. */
export const admin = (method, path, body, actor) =>
  request(
    method,
    `/api/v1/admin${path}`,
    body,
    actor ? { "x-ggjira-actor": encodeURIComponent(actor) } : {},
  );
export const setup = (method, path, body) => request(method, `/api/v1/setup${path}`, body);

export async function health() {
  const response = await fetch("/health");
  return response.json();
}
