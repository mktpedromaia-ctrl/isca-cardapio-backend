const OpenAI = require('openai');

// Provider de LLM configurável por variáveis de ambiente.
// Funciona com qualquer API compatível com OpenAI: OpenRouter, Gemini (endpoint OpenAI-compat), OpenAI, etc.
// Basta setar LLM_BASE_URL, LLM_MODEL e LLM_API_KEY (no Railway, não no .env do repo).
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
const LLM_MODEL    = process.env.LLM_MODEL    || 'meta-llama/llama-4-scout-17b-16e-instruct';
const LLM_API_KEY  = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

const defaultHeaders = LLM_BASE_URL.includes('openrouter')
  ? { 'HTTP-Referer': 'https://produto-isca-cardapio.pages.dev', 'X-Title': 'Isca Cardapio' }
  : undefined;

const client = new OpenAI({ apiKey: LLM_API_KEY, baseURL: LLM_BASE_URL, defaultHeaders });

function buildPrompt(dadosProdutos) {
  const fotoInfo = dadosProdutos.detalheFotos
    ? `\nDETECÇÃO DE FOTOS (extraído direto do HTML — use estes dados para o campo tem_foto, NÃO tente adivinhar pelas imagens):\nTotal de produtos detectados: ${dadosProdutos.totalDetectados}\nProdutos COM foto: ${dadosProdutos.produtosComFoto}\nProdutos SEM foto: ${dadosProdutos.produtosSemFoto}\nDetalhes por produto:\n${dadosProdutos.detalheFotos.map(p => `- "${p.texto}" → tem_foto: ${p.temFoto}`).join('\n')}`
    : '';

  return `Você é um especialista em engenharia de cardápios e estratégia de preços para restaurantes de delivery no Brasil.

Analise o cardápio deste restaurante com base nas imagens e no texto extraído abaixo. Forneça uma análise detalhada e profissional com dados de mercado.

TEXTO EXTRAÍDO DO CARDÁPIO:
${dadosProdutos.textoCompleto.slice(0, 20000)}
${fotoInfo}

INSTRUÇÕES:
- Analise pelo menos 10 produtos reais encontrados no cardápio
- Use nomes, preços e categorias reais do cardápio
- Use conhecimento do mercado brasileiro para estimar preços de concorrência
- Para o campo tem_foto: use EXCLUSIVAMENTE os dados da seção "DETECÇÃO DE FOTOS" acima, não tente inferir pelas imagens
- Seja específico e detalhado em cada análise

Retorne APENAS JSON válido (sem markdown, sem texto adicional) com esta estrutura:

{
  "estabelecimento": "nome real",
  "score_geral": 0,
  "classificacao": "Precisa de atenção urgente",
  "scores": {
    "organizacao": 0,
    "descricoes": 0,
    "precificacao": 0,
    "fotos": 0,
    "nomes": 0,
    "adicionais": 0
  },
  "primeiras_impressoes": "texto",
  "total_produtos": 0,
  "total_categorias": 0,
  "produtos_com_foto": 0,
  "produtos_sem_foto": 0,
  "faixa_preco": { "menor": "R$ 0,00", "maior": "R$ 0,00", "medio": "R$ 0,00" },
  "categorias": [],
  "analise_produtos": [
    {
      "nome_atual": "nome exato",
      "preco_atual": "R$ 0,00",
      "preco_sugerido": "R$ 0,00",
      "preco_concorrencia_min": "R$ 0,00",
      "preco_concorrencia_max": "R$ 0,00",
      "tem_foto": false,
      "categoria": "categoria",
      "score_nome": 0,
      "score_descricao": 0,
      "score_foto": 0,
      "score_preco": 0,
      "score_produto": 0,
      "nome_sugerido": "nome sugerido",
      "descricao_atual": "texto ou —",
      "descricao_sugerida": "descrição apetitosa completa",
      "problemas": ["problema 1", "problema 2"],
      "melhorias": ["melhoria 1", "melhoria 2"],
      "impacto_financeiro": "estimativa de impacto",
      "posicionamento": "Na média"
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
    {
      "titulo": "ação",
      "impacto": "impacto estimado",
      "exemplo": "exemplo concreto"
    }
  ],
  "analise_descricoes": "texto",
  "analise_precificacao": "texto",
  "analise_fotos": "texto",
  "analise_organizacao": "texto"
}`;
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
    // Tenta reparar JSON truncado adicionando fechamentos
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
  console.log(`📥 Resposta GPT: ${text.length} chars | finish: ${response.choices[0].finish_reason}`);

  if (text.toLowerCase().includes("i'm sorry") || text.toLowerCase().includes("i cannot") || text.toLowerCase().includes("i can't")) {
    throw new Error('GPT_REFUSED');
  }

  const resultado = extrairJSON(text);
  if (!resultado) {
    console.error('JSON inválido:', text.slice(0, 300));
    throw new Error('JSON_INVALIDO');
  }

  return resultado;
}

async function analisarCardapio({ secoes, dadosProdutos }) {
  const prompt = buildPrompt(dadosProdutos);

  // Tentativa 1: todas as seções com detail low
  console.log(`📤 Tentativa 1: ${secoes.length} imagens (low detail)...`);
  try {
    const content = [
      ...secoes.map(s => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${s}`, detail: 'low' } })),
      { type: 'text', text: prompt }
    ];
    return await chamarGPT(content);
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
    return await chamarGPT(content);
  } catch (e) {
    console.warn(`⚠️  Tentativa 2 falhou: ${e.message}`);
  }

  // Tentativa 3: só texto, sem imagens
  console.log('📤 Tentativa 3: apenas texto...');
  try {
    const content = [{ type: 'text', text: prompt }];
    return await chamarGPT(content);
  } catch (e) {
    console.warn(`⚠️  Tentativa 3 falhou: ${e.message}`);
  }

  throw new Error('Não foi possível analisar o cardápio. Tente novamente em instantes.');
}

module.exports = { analisarCardapio };
