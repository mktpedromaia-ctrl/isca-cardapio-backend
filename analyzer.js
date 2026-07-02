const OpenAI = require('openai');

// Provider de LLM configurável por variáveis de ambiente.
// Funciona com qualquer API compatível com OpenAI: OpenRouter, Gemini (endpoint OpenAI-compat), OpenAI, etc.
// Basta setar LLM_BASE_URL, LLM_MODEL e LLM_API_KEY (no ambiente, não no .env do repo).
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
const LLM_MODEL    = process.env.LLM_MODEL    || 'meta-llama/llama-4-scout-17b-16e-instruct';
const LLM_API_KEY  = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

const defaultHeaders = LLM_BASE_URL.includes('openrouter')
  ? { 'HTTP-Referer': 'https://isca-cardapio-backend.onrender.com', 'X-Title': 'Isca Cardapio' }
  : undefined;

const client = new OpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL, defaultHeaders });

// ============================================================
// SCORING HÍBRIDO
// O que dá pra medir por código é medido por código (determinístico, reproduzível).
// O LLM só julga o que é subjetivo (qualidade de nome, apetite da descrição), com rubrica travada.
// O score geral é média ponderada calculada aqui, nunca inventada pelo modelo.
// Escala: sub-scores 0 a 10; score_geral 0 a 100.
// ============================================================

const PESOS = { fotos: 25, descricoes: 20, precificacao: 15, organizacao: 15, nomes: 15, adicionais: 10 };

const clamp10 = (n) => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));

function calcularMetricas(dados) {
  const prods = Array.isArray(dados.produtos)
    ? dados.produtos.filter(p => p && typeof p === 'object')
    : [];
  const total = prods.length || dados.totalDetectados || 0;

  // FOTOS: % de produtos com foto (fato extraído do DOM)
  const comFoto = typeof dados.produtosComFoto === 'number'
    ? dados.produtosComFoto
    : prods.filter(p => p.temFoto).length;
  const pctFoto = total ? comFoto / total : 0;
  const scoreFotos = clamp10(pctFoto * 10);

  // DESCRIÇÕES (cobertura): % de produtos com descrição real (>= 15 chars)
  const comDesc = prods.filter(p => p.descricao && p.descricao.length >= 15).length;
  const pctDesc = total ? comDesc / total : 0;
  const scoreDescCobertura = clamp10(pctDesc * 10);

  // PRECIFICAÇÃO: terminação psicológica (,90 ,99 ,00 ,50) + amplitude de preço (arquitetura de âncoras)
  const precos = prods.map(p => p.precoNum).filter(n => n > 0);
  let scorePreco = 5;
  let faixaPreco = null;
  if (precos.length) {
    // Terminação psicológica: ,90/,99/,95 puxam conversão; ,50 é neutro; ,00 é preço "preguiçoso"
    const psico = precos.filter(n => {
      const cent = Math.round((n % 1) * 100);
      return cent === 90 || cent === 99 || cent === 95;
    }).length;
    const neutro = precos.filter(n => Math.round((n % 1) * 100) === 50).length;
    const pctTerm = (psico + neutro * 0.5) / precos.length;
    const min = Math.min(...precos), max = Math.max(...precos);
    const media = precos.reduce((a, b) => a + b, 0) / precos.length;
    const temAmplitude = precos.length > 3 && (max / min) >= 2.5; // tem entrada barata e item premium
    scorePreco = clamp10(pctTerm * 6 + (temAmplitude ? 4 : 1.5));
    const fmt = (n) => 'R$ ' + n.toFixed(2).replace('.', ',');
    faixaPreco = { menor: fmt(min), maior: fmt(max), medio: fmt(media) };
  }

  // ORGANIZAÇÃO: calculada com o nº de categorias (refinado depois com o dado do LLM em mesclar)
  const nCat = (dados.categorias || []).length;
  const scoreOrg = scoreOrganizacao(nCat, total);

  return {
    total, comFoto, nCat,
    scoreFotos, scoreDescCobertura, scorePreco, scoreOrg,
    pctFoto: Math.round(pctFoto * 100),
    pctDesc: Math.round(pctDesc * 100),
    faixaPreco,
  };
}

// Score de organização (0-10) a partir do nº de categorias e densidade por categoria.
// Contagem absurda (mais categorias que metade dos produtos) = ruído de extração → neutro.
function scoreOrganizacao(nCat, total) {
  if (total > 0 && nCat > total * 0.5) return 6; // contagem não confiável, nota neutra
  const porCat = nCat ? total / nCat : total;
  let s = 5;
  if (nCat >= 2) s += 2.5;
  if (nCat >= 4) s += 1;
  if (porCat >= 3 && porCat <= 15) s += 1.5;
  return clamp10(s);
}

function classificar(s) {
  if (s >= 80) return 'Cardápio de alta performance';
  if (s >= 65) return 'Bom, com espaço para crescer';
  if (s >= 50) return 'Mediano, precisa de ajustes';
  if (s >= 35) return 'Precisa de atenção';
  return 'Precisa de atenção urgente';
}

function scoreGeral(s) {
  const soma = s.fotos * PESOS.fotos
             + s.descricoes * PESOS.descricoes
             + s.precificacao * PESOS.precificacao
             + s.organizacao * PESOS.organizacao
             + s.nomes * PESOS.nomes
             + s.adicionais * PESOS.adicionais;
  return Math.round(soma / 10); // sub-scores 0-10, pesos somam 100 → geral 0-100
}

// Funde a análise do LLM com as métricas determinísticas: os números viram fato,
// o LLM só entra no que é qualitativo. O score geral é recalculado aqui.
function mesclar(llm, metricas, dados) {
  llm.scores = llm.scores || {};

  // Categorias reais: o LLM enxerga as seções de verdade; a raspagem de HTML é ruidosa.
  // Usa a lista do LLM quando for sã (2 a 25 categorias distintas), senão cai no dado raspado.
  const catsLLM = Array.isArray(llm.categorias)
    ? [...new Set(llm.categorias.map(c => String(c).trim()).filter(Boolean))]
    : [];
  const nCatFinal = (catsLLM.length >= 2 && catsLLM.length <= 25) ? catsLLM.length : metricas.nCat;

  // Determinísticos (fatos, sobrescrevem o que o LLM tenha chutado)
  llm.scores.fotos        = metricas.scoreFotos;
  llm.scores.precificacao = metricas.scorePreco;
  llm.scores.organizacao  = scoreOrganizacao(nCatFinal, metricas.total);

  // Descrições: cobertura (determinístico, 60%) + apetite (LLM, 40%)
  const apetite = clamp10(llm.scores.descricoes_apetite != null ? llm.scores.descricoes_apetite : llm.scores.descricoes);
  llm.scores.descricoes = clamp10(metricas.scoreDescCobertura * 0.6 + apetite * 0.4);

  // Qualitativos (LLM, com rubrica)
  llm.scores.nomes      = clamp10(llm.scores.nomes != null ? llm.scores.nomes : 5);
  llm.scores.adicionais = clamp10(llm.scores.adicionais != null ? llm.scores.adicionais : 5);
  delete llm.scores.descricoes_apetite;

  // Contagens e faixa de preço = fato
  llm.total_produtos    = metricas.total;
  llm.total_categorias  = nCatFinal || 0;
  if (catsLLM.length >= 2 && catsLLM.length <= 25) llm.categorias = catsLLM;
  llm.produtos_com_foto = metricas.comFoto;
  llm.produtos_sem_foto = metricas.total - metricas.comFoto;
  if (metricas.faixaPreco) llm.faixa_preco = metricas.faixaPreco;

  // Score geral e classificação = calculados, nunca inventados
  llm.score_geral   = scoreGeral(llm.scores);
  llm.classificacao = classificar(llm.score_geral);

  // Corrige tem_foto por produto com o dado real (match por início do nome)
  if (Array.isArray(llm.analise_produtos) && Array.isArray(dados.produtos)) {
    llm.analise_produtos.forEach(ap => {
      const alvo = String(ap.nome_atual || '').toLowerCase().slice(0, 20);
      if (!alvo) return;
      const real = dados.produtos.find(p => p.nome && p.nome.toLowerCase().slice(0, 20) === alvo);
      if (real) ap.tem_foto = real.temFoto;
    });
  }

  return llm;
}

function buildPrompt(dados, metricas) {
  const listaProdutos = (dados.produtos || [])
    .slice(0, 60)
    .map((p, i) => `${i + 1}. ${p.nome}${p.preco ? ' | ' + p.preco : ''}${p.temFoto ? ' | tem foto' : ' | SEM foto'}${p.descricao ? ' | desc: "' + p.descricao + '"' : ' | SEM descrição'}`)
    .join('\n');

  return `Você é um especialista em engenharia de cardápios e estratégia de preços para restaurantes de delivery no Brasil.

Já medimos por código os dados objetivos deste cardápio. NÃO recalcule nada abaixo, use como VERDADE:
- Total de produtos: ${metricas.total}
- Produtos COM foto: ${metricas.comFoto} de ${metricas.total} (${metricas.pctFoto}%)
- Produtos COM descrição: ${metricas.pctDesc}%
- Faixa de preço: ${metricas.faixaPreco ? `${metricas.faixaPreco.menor} a ${metricas.faixaPreco.maior} (médio ${metricas.faixaPreco.medio})` : 'não detectada'}

PRODUTOS EXTRAÍDOS:
${listaProdutos}

TEXTO BRUTO DO CARDÁPIO (contexto):
${(dados.textoCompleto || '').slice(0, 12000)}

SEU TRABALHO é apenas o julgamento QUALITATIVO. Dê nota de 0 a 10 em duas dimensões, seguindo a rubrica exata:

1) scores.nomes — qualidade dos NOMES dos produtos:
   - 0 a 3: nomes genéricos ("X-Burguer", "Pizza Calabresa", "Combo 1"), sem diferenciação.
   - 4 a 6: nomes claros mas sem apelo ("Hambúrguer Artesanal", "Pizza Margherita").
   - 7 a 8: nomes descritivos com ingrediente-chave ("Smash Duplo com Cheddar e Bacon").
   - 9 a 10: nomes que vendem sozinhos, com assinatura/origem/sensorial ("Smash Costela 180g ao Barbecue Defumado").

2) scores.descricoes_apetite — quão APETITOSAS são as descrições existentes:
   - 0 a 3: sem descrição ou só lista fria de ingredientes.
   - 4 a 6: descreve o que é, mas sem gerar desejo.
   - 7 a 8: usa linguagem sensorial (textura, sabor, preparo).
   - 9 a 10: descrição irresistível, que dá vontade de pedir só de ler.

3) scores.adicionais — de 0 a 10, o quanto o cardápio aparenta explorar adicionais/complementos/upsell (inferido pelo tipo de produto e pelo texto).

Retorne APENAS JSON válido (sem markdown, sem texto fora do JSON) com esta estrutura. Os campos de nota que você NÃO deve preencher já serão calculados por nós; preencha só scores.nomes, scores.descricoes_apetite e scores.adicionais:

{
  "estabelecimento": "nome real do restaurante",
  "scores": { "nomes": 0, "descricoes_apetite": 0, "adicionais": 0 },
  "primeiras_impressoes": "2 a 3 frases sobre a impressão geral do cardápio",
  "categorias": ["liste aqui as categorias/seções REAIS e distintas do cardápio, ex: Hambúrgueres, Combos, Acompanhamentos, Bebidas, Sobremesas"],
  "analise_produtos": [
    {
      "nome_atual": "nome exato do produto",
      "preco_atual": "R$ 0,00",
      "preco_sugerido": "R$ 0,00",
      "preco_concorrencia_min": "R$ 0,00",
      "preco_concorrencia_max": "R$ 0,00",
      "categoria": "categoria",
      "score_nome": 0,
      "score_descricao": 0,
      "score_produto": 0,
      "nome_sugerido": "nome melhorado que vende",
      "descricao_atual": "descrição atual ou vazio",
      "descricao_sugerida": "descrição apetitosa completa reescrita",
      "problemas": ["problema 1", "problema 2"],
      "melhorias": ["melhoria 1", "melhoria 2"],
      "impacto_financeiro": "estimativa de impacto",
      "posicionamento": "Abaixo da média | Na média | Acima da média"
    }
  ],
  "analise_concorrencia": {
    "resumo": "texto",
    "preco_medio_mercado": "R$ 0,00",
    "oportunidades": ["oportunidade 1"],
    "ameacas": ["ameaça 1"],
    "diferenciais_a_explorar": ["diferencial 1"]
  },
  "pontos_fortes": ["ponto 1", "ponto 2"],
  "pontos_fracos": ["ponto 1", "ponto 2"],
  "acoes_prioritarias": [
    { "titulo": "ação", "impacto": "impacto estimado", "exemplo": "exemplo concreto" }
  ],
  "analise_descricoes": "análise textual das descrições, citando dados reais",
  "analise_precificacao": "análise textual da precificação, citando a faixa real",
  "analise_fotos": "análise textual sobre as fotos, citando o % real com foto",
  "analise_organizacao": "análise textual da organização e categorias reais"
}

REGRAS OBRIGATÓRIAS:
- analise_produtos DEVE conter de 12 a 15 produtos (nunca menos que 12), escolhendo os mais representativos e de categorias diferentes. Isto é obrigatório: um relatório com poucos produtos é inaceitável.
- Use nomes e preços reais exatamente como aparecem na lista de produtos.
- Use conhecimento do mercado brasileiro para estimar preços de concorrência.
- Nas análises textuais, cite os números reais informados acima (% com foto, faixa de preço etc.).
- Seja específico, direto e sem enrolação.`;
}

function extrairJSON(text) {
  const semMarkdown = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const match = semMarkdown.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch (_) {
    // Tenta reparar JSON truncado
    try {
      const reparado = match[0]
        .replace(/,\s*$/, '')
        .replace(/,\s*\]/, ']')
        .replace(/,\s*\}/, '}');
      return JSON.parse(reparado);
    } catch (_) {
      return null;
    }
  }
}

async function chamarGPT(content) {
  const response = await client.chat.completions.create({
    model: LLM_MODEL,
    max_tokens: 8000,
    messages: [
      {
        role: 'system',
        content: 'Você é um especialista em engenharia de cardápios e estratégia de preços para restaurantes de delivery no Brasil. Sempre responda exclusivamente em JSON válido, sem markdown, sem texto adicional.'
      },
      { role: 'user', content }
    ]
  });

  const text = response.choices[0].message.content;
  console.log(`📥 Resposta LLM: ${text.length} chars | finish: ${response.choices[0].finish_reason}`);

  if (text.toLowerCase().includes("i'm sorry") || text.toLowerCase().includes("i cannot") || text.toLowerCase().includes("i can't")) {
    throw new Error('LLM_REFUSED');
  }

  const resultado = extrairJSON(text);
  if (!resultado) {
    console.error('JSON inválido:', text.slice(0, 300));
    throw new Error('JSON_INVALIDO');
  }

  return resultado;
}

async function analisarCardapio({ secoes, dadosProdutos }) {
  const metricas = calcularMetricas(dadosProdutos);
  console.log(`📊 Métricas: ${metricas.total} produtos | ${metricas.pctFoto}% com foto | ${metricas.pctDesc}% com descrição | ${metricas.nCat} categorias`);

  const prompt = buildPrompt(dadosProdutos, metricas);

  // Tentativa 1: todas as seções com detail low
  console.log(`📤 Tentativa 1: ${secoes.length} imagens (low detail)...`);
  try {
    const content = [
      ...secoes.map(s => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${s}`, detail: 'low' } })),
      { type: 'text', text: prompt }
    ];
    return mesclar(await chamarGPT(content), metricas, dadosProdutos);
  } catch (e) {
    console.warn(`⚠️  Tentativa 1 falhou: ${e.message}`);
  }

  // Tentativa 2: só 2 seções (topo e meio)
  console.log('📤 Tentativa 2: 2 imagens...');
  try {
    const content = [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${secoes[0]}`, detail: 'low' } },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${secoes[Math.floor(secoes.length / 2)]}`, detail: 'low' } },
      { type: 'text', text: prompt }
    ];
    return mesclar(await chamarGPT(content), metricas, dadosProdutos);
  } catch (e) {
    console.warn(`⚠️  Tentativa 2 falhou: ${e.message}`);
  }

  // Tentativa 3: só texto, sem imagens
  console.log('📤 Tentativa 3: apenas texto...');
  try {
    const content = [{ type: 'text', text: prompt }];
    return mesclar(await chamarGPT(content), metricas, dadosProdutos);
  } catch (e) {
    console.warn(`⚠️  Tentativa 3 falhou: ${e.message}`);
  }

  throw new Error('Não foi possível analisar o cardápio. Tente novamente em instantes.');
}

module.exports = { analisarCardapio, calcularMetricas, scoreGeral, classificar };
