require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { capturarCardapio } = require('./screenshot');
const { analisarCardapio } = require('./analyzer');
const { validarUrlSegura } = require('./ssrf');

const app = express();
const PORT = process.env.PORT || 3333;

// Render fica atrás de proxy (Cloudflare); confia no primeiro hop pra ler o IP real do cliente
app.set('trust proxy', 1);
app.disable('x-powered-by');

// IP real do cliente. Render fica atrás do Cloudflare, cujo IP de borda rotaciona;
// CF-Connecting-IP traz o IP verdadeiro (o Cloudflare sobrescreve, o cliente não forja).
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || 'desconhecido';
}

// ---------- Headers de segurança ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // CSP: bloqueia object/base, prende exfiltração a mesma origem (connect-src 'self').
  // Mesmo que caia um XSS, não consegue mandar dado pra fora nem injetar <object>/<base>.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https:",
    "script-src 'self' 'unsafe-inline' https:",
    "font-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  next();
});

app.use(cors());
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Rate limit por IP (em memória) ----------
const JANELA_MS = 10 * 60 * 1000; // 10 min
const LIMITE_IP = 8;              // análises por IP na janela
const hits = new Map();           // ip -> [timestamps]

function rateLimited(ip) {
  const agora = Date.now();
  const arr = (hits.get(ip) || []).filter(t => agora - t < JANELA_MS);
  arr.push(agora);
  hits.set(ip, arr);
  return arr.length > LIMITE_IP;
}
// Limpeza periódica pra não crescer memória sem limite
setInterval(() => {
  const agora = Date.now();
  for (const [ip, arr] of hits) {
    const vivos = arr.filter(t => agora - t < JANELA_MS);
    if (vivos.length) hits.set(ip, vivos); else hits.delete(ip);
  }
}, JANELA_MS).unref();

// ---------- Limite de concorrência de Puppeteer (protege RAM do free tier) ----------
let emAndamento = 0;
const MAX_CONCORRENTE = 2;

app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.1.0' }));

// Captura de lead: aceita e registra; encaminha pra um webhook se configurado (LEAD_WEBHOOK_URL)
app.post('/api/lead', async (req, res) => {
  const b = req.body || {};
  const lead = {
    nome: String(b.nome || '').slice(0, 120),
    email: String(b.email || '').slice(0, 160),
    telefone: String(b.telefone || '').slice(0, 40),
    empresa: String(b.empresa || '').slice(0, 160),
    segmento: String(b.segmento || '').slice(0, 60),
    faturamento: String(b.faturamento || '').slice(0, 60),
    urlCardapio: String(b.urlCardapio || '').slice(0, 2048),
    em: new Date().toISOString(),
  };
  console.log(`📥 Lead: ${lead.nome} | ${lead.telefone} | ${lead.empresa}`);
  if (process.env.LEAD_WEBHOOK_URL) {
    try {
      await fetch(process.env.LEAD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lead),
      });
    } catch (e) {
      console.error('Falha ao encaminhar lead:', e.message);
    }
  }
  res.json({ ok: true });
});

app.post('/api/analisar', async (req, res) => {
  const ip = clientIp(req);
  const { url, nome, whatsapp } = req.body || {};

  if (!url || typeof url !== 'string' || url.length > 2048) {
    return res.status(400).json({ error: 'URL inválida. Use o link completo do cardápio (ex: https://...)' });
  }

  // Rate limit primeiro: corta abuso já na entrada, antes de qualquer trabalho
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Muitas análises em pouco tempo. Aguarde alguns minutos e tente de novo.' });
  }

  // ---------- Anti-SSRF: bloqueia loopback/rede interna/metadados de cloud ----------
  const seg = await validarUrlSegura(url);
  if (!seg.ok) {
    const msg = seg.motivo === 'protocolo'
      ? 'Use um link http ou https válido.'
      : seg.motivo === 'url_invalida'
      ? 'URL inválida. Use o link completo do cardápio (ex: https://...).'
      : seg.motivo === 'dns'
      ? 'Não conseguimos acessar esse link. Verifique se o endereço está correto.'
      : 'Esse link não é permitido. Use o endereço público do seu cardápio.';
    return res.status(400).json({ error: msg });
  }

  if (emAndamento >= MAX_CONCORRENTE) {
    return res.status(503).json({ error: 'Estamos com muitas análises agora. Tente de novo em instantes.' });
  }

  emAndamento++;
  try {
    console.log(`\n🔍 Analisando: ${url}`);
    console.log(`👤 Lead: ${String(nome || '').slice(0, 80)} | ${String(whatsapp || '').slice(0, 40)}`);

    // Screenshot com retry (pina o IP público resolvido pra impedir DNS rebinding)
    let resultado;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      try {
        console.log(`📸 Screenshot (tentativa ${tentativa})...`);
        resultado = await capturarCardapio(url, { pinHost: seg.host, pinIp: seg.ip });
        console.log('✅ Screenshots capturados');
        break;
      } catch (e) {
        console.error(`❌ Screenshot tentativa ${tentativa}: ${e.message}`);
        if (tentativa === 2) {
          const msg = e.message.includes('ERR_NAME_NOT_RESOLVED')
            ? 'Não conseguimos acessar esse link. Verifique se o endereço está correto.'
            : (e.message.includes('timeout') || e.message.includes('Timeout'))
            ? 'O cardápio demorou demais para carregar. Tente novamente.'
            : 'Erro ao acessar o cardápio. Verifique se o link está correto e tente novamente.';
          return res.status(502).json({ error: msg });
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Verifica se extraiu texto e produtos suficientes
    if (!resultado.dadosProdutos.textoCompleto || resultado.dadosProdutos.textoCompleto.length < 50) {
      return res.status(422).json({ error: 'Não conseguimos ler o conteúdo desse cardápio. Tente com outro link.' });
    }
    if (!resultado.dadosProdutos.totalDetectados || resultado.dadosProdutos.totalDetectados === 0) {
      return res.status(422).json({ error: 'Não encontramos produtos com preço nesse link. Confira se é a página do cardápio (com os itens e valores) e tente de novo.' });
    }

    // Análise pela IA
    let analise;
    try {
      console.log('🤖 Analisando com IA...');
      analise = await analisarCardapio(resultado);
      console.log(`✅ Análise concluída: ${analise.estabelecimento}`);
    } catch (e) {
      console.error('❌ Análise falhou:', e.message);
      // Não vaza a mensagem interna pro cliente
      return res.status(502).json({ error: 'Não foi possível concluir a análise agora. Tente novamente em instantes.' });
    }

    res.json({
      success: true,
      analise,
      screenshotFull: resultado.screenshotFullBase64,
      secoes: resultado.secoes,
    });
  } finally {
    emAndamento--;
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 MenuCheck Backend v2.1 rodando em http://localhost:${PORT}`);
  console.log(`📋 POST /api/analisar  |  📥 POST /api/lead  |  ❤️  GET /health\n`);
});
