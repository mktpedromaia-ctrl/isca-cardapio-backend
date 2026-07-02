// Proteção anti-SSRF: valida se uma URL é segura para o servidor acessar.
// Bloqueia loopback, redes privadas, link-local e endpoints de metadados de cloud.
// Resolve o DNS e checa TODOS os IPs; devolve o IP público pra "pinar" na navegação
// (fecha a janela de DNS rebinding, onde o host resolve público na checagem e privado na hora do fetch).

const dns = require('dns').promises;

function ipv4Privado(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformado = bloqueia
  const [a, b] = p;
  if (a === 0) return true;                     // 0.0.0.0/8
  if (a === 10) return true;                    // 10/8 privado
  if (a === 127) return true;                   // loopback
  if (a === 169 && b === 254) return true;      // link-local + metadados cloud (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 privado
  if (a === 192 && b === 168) return true;      // 192.168/16 privado
  if (a === 192 && b === 0) return true;        // 192.0.0/24 (inclui 192.0.0.x reservado)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmark
  if (a >= 224) return true;                    // multicast/reservado (224+)
  return false;
}

function ipPrivado(ip) {
  if (!ip) return true;
  let addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4 mapeado em IPv6 (::ffff:1.2.3.4)
  const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Privado(mapped[1]);
  if (addr.includes(':')) {
    // IPv6
    if (addr === '::1' || addr === '::') return true;          // loopback / unspecified
    if (/^f[cd]/.test(addr)) return true;                       // fc00::/7 unique-local
    if (/^fe[89ab]/.test(addr)) return true;                    // fe80::/10 link-local
    if (addr === 'fd00:ec2::254' || addr.startsWith('fd00:ec2')) return true; // metadados AWS IPv6
    return false;
  }
  return ipv4Privado(addr);
}

const HOSTS_BLOQUEADOS = new Set([
  'localhost', 'metadata', 'metadata.google.internal', 'metadata.goog',
]);

async function validarUrlSegura(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (_) {
    return { ok: false, motivo: 'url_invalida' };
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    return { ok: false, motivo: 'protocolo' };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (HOSTS_BLOQUEADOS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, motivo: 'host_interno' };
  }
  // Resolve DNS e checa todos os IPs
  let enderecos;
  try {
    enderecos = await dns.lookup(host, { all: true });
  } catch (_) {
    return { ok: false, motivo: 'dns' };
  }
  if (!enderecos.length) return { ok: false, motivo: 'dns' };
  for (const { address } of enderecos) {
    if (ipPrivado(address)) return { ok: false, motivo: 'ip_privado' };
  }
  // Escolhe um IP público pra pinar (evita rebinding na navegação)
  const publico = enderecos.find(e => !ipPrivado(e.address));
  return { ok: true, host, ip: publico ? publico.address : null };
}

module.exports = { validarUrlSegura, ipPrivado };
