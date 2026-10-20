// fetch without a pooled connection. A script that sits idle between two requests (generating a clip, waiting for an
// escalation) longer than the server's keep-alive timeout (5 s in Node) finds its pooled socket closed by the server
// and the next request dies with "other side closed" before the server sees it. One connection per request removes
// the cause instead of retrying over it; on loopback the cost is below the noise of what the scripts measure.
export const freshFetch = (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, connection: "close" } });
