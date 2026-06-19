const WORKER_BASE = 'https://g2meil.arekutennyson23.workers.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return serveIndex(env);
    }

    if (request.method === 'GET' && url.pathname === '/callback') {
      return handleCallback(url, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/emails') {
      return handleEmails(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/email') {
      return handleEmail(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/send') {
      return handleSend(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// ── GET / ─────────────────────────────────────────────────────────────────────
async function serveIndex(env) {
  // El index.html se sirve como asset estático en Cloudflare Pages/Workers Sites.
  // Si usas Workers con assets binding lo devuelves aquí; si no, lo tenés hardcodeado.
  // Por simplicidad lo importamos como texto desde la variable de entorno o lo servimos inline.
  // Cloudflare Workers con __STATIC_CONTENT o simplemente fetch al mismo worker no funciona recursivo,
  // así que lo más simple es tener el HTML como string o como módulo.
  // Usamos env.ASSETS si existe (Workers + Assets), sino devolvemos 404 con hint.
  if (env.ASSETS) {
    return env.ASSETS.fetch('https://placeholder/index.html');
  }
  return new Response('Configure ASSETS binding or deploy index.html as asset.', { status: 500 });
}

// ── GET /callback ─────────────────────────────────────────────────────────────
async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return Response.redirect(`${WORKER_BASE}/?error=access_denied`, 302);
  }

  // Intercambiar code por tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: `${WORKER_BASE}/callback`,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('Token exchange failed:', err);
    return Response.redirect(`${WORKER_BASE}/?error=token_exchange_failed`, 302);
  }

  const tokens = await tokenRes.json();

  // Generar userCode de 6 dígitos
  const userCode = String(Math.floor(100000 + Math.random() * 900000));

  // Guardar tokens en KV con el userCode como clave (TTL: 7 días)
  await env.G2MEIL_KV.put(userCode, JSON.stringify(tokens), { expirationTtl: 604800 });

  return Response.redirect(`${WORKER_BASE}/?userCode=${userCode}`, 302);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getTokens(userCode, env) {
  const raw = await env.G2MEIL_KV.get(userCode);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function refreshIfNeeded(tokens, env) {
  // access_token suele durar 1h; si tenemos refresh_token lo renovamos
  if (!tokens.refresh_token) return tokens;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) return tokens; // devolver los viejos y que falle en la llamada real
  const refreshed = await res.json();
  return { ...tokens, ...refreshed };
}

function gmailAuthHeader(tokens) {
  return `Bearer ${tokens.access_token}`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Decodifica base64url a string
function decodeBase64Url(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Extrae texto plano de un mensaje de Gmail (partes MIME)
function extractPlainText(payload) {
  if (!payload) return '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }

  // Fallback: si solo hay HTML, stripear tags
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = decodeBase64Url(payload.body.data);
    return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  return '';
}

// ── POST /api/emails ──────────────────────────────────────────────────────────
async function handleEmails(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { userCode, folder = 'INBOX', page = 1 } = body;
  if (!userCode) return jsonResponse({ error: 'userCode required' }, 400);

  let tokens = await getTokens(userCode, env);
  if (!tokens) return jsonResponse({ error: 'Invalid or expired userCode' }, 401);
  tokens = await refreshIfNeeded(tokens, env);

  const maxResults = 20;
  const params = new URLSearchParams({ labelIds: folder, maxResults });

  // Paginación simple: obtenemos más y saltamos
  if (page > 1) {
    // Obtenemos (page * maxResults) y devolvemos la última página
    params.set('maxResults', page * maxResults);
  }

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
    { headers: { Authorization: gmailAuthHeader(tokens) } }
  );

  if (!listRes.ok) return jsonResponse({ error: 'Gmail API error', status: listRes.status }, 502);

  const listData = await listRes.json();
  const allMessages = listData.messages || [];

  // Tomar solo la página actual
  const start = (page - 1) * maxResults;
  const pageMessages = allMessages.slice(start, start + maxResults);

  // Obtener metadata de cada correo en paralelo
  const emails = await Promise.all(
    pageMessages.map(async ({ id }) => {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: { Authorization: gmailAuthHeader(tokens) } }
      );
      if (!msgRes.ok) return { id, error: true };
      const msg = await msgRes.json();
      const headers = msg.payload?.headers || [];
      const get = (name) => headers.find(h => h.name === name)?.value || '';
      return {
        id: msg.id,
        from: get('From'),
        subject: get('Subject'),
        date: get('Date'),
        snippet: msg.snippet || '',
        unread: msg.labelIds?.includes('UNREAD') ?? false,
      };
    })
  );

  return jsonResponse({ emails, total: listData.resultSizeEstimate || allMessages.length, page });
}

// ── POST /api/email ───────────────────────────────────────────────────────────
async function handleEmail(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { userCode, emailId } = body;
  if (!userCode || !emailId) return jsonResponse({ error: 'userCode and emailId required' }, 400);

  let tokens = await getTokens(userCode, env);
  if (!tokens) return jsonResponse({ error: 'Invalid or expired userCode' }, 401);
  tokens = await refreshIfNeeded(tokens, env);

  const msgRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${emailId}?format=full`,
    { headers: { Authorization: gmailAuthHeader(tokens) } }
  );

  if (!msgRes.ok) return jsonResponse({ error: 'Gmail API error', status: msgRes.status }, 502);

  const msg = await msgRes.json();
  const headers = msg.payload?.headers || [];
  const get = (name) => headers.find(h => h.name === name)?.value || '';

  const plainText = extractPlainText(msg.payload);

  return jsonResponse({
    id: msg.id,
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
    body: plainText,
  });
}

// ── POST /api/send ────────────────────────────────────────────────────────────
async function handleSend(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { userCode, to, subject, body: emailBody } = body;
  if (!userCode || !to || !subject || !emailBody) {
    return jsonResponse({ error: 'userCode, to, subject, body required' }, 400);
  }

  let tokens = await getTokens(userCode, env);
  if (!tokens) return jsonResponse({ error: 'Invalid or expired userCode' }, 401);
  tokens = await refreshIfNeeded(tokens, env);

  // Construir el mensaje en formato RFC 2822
  const rawEmail = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    emailBody,
  ].join('\r\n');

  // Codificar en base64url
  const encoded = btoa(unescape(encodeURIComponent(rawEmail)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sendRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: gmailAuthHeader(tokens),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encoded }),
    }
  );

  if (!sendRes.ok) {
    const err = await sendRes.text();
    return jsonResponse({ error: 'Gmail send error', detail: err }, 502);
  }

  const result = await sendRes.json();
  return jsonResponse({ success: true, messageId: result.id });
}
