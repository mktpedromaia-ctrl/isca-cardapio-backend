require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { capturarCardapio } = require('./screenshot');
const { analisarCardapio } = require('./analyzer');

const app = express();
const PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0' }));

app.post('/api/analisar', async (req, res) => {
  const { url, nome, whatsapp } = req.body;

  if (!url) return res.status(400).json({ error: 'URL é obrigatória' });

  // Valida URL básica
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
  } catch (_) {
    return res.status(400).json({ error: 'URL inválida. Use o link completo do cardápio (ex: https://...)' });
  }

  console.log(`\n🔍 Analisando: ${url}`);
  console.log(`👤 Lead: ${nome} | ${whatsapp}`);

  // Screenshot com retry
  let resultado;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      console.log(`📸 Screenshot (tentativa ${tentativa})...`);
      resultado = await capturarCardapio(url);
      console.log('✅ Screenshots capturados');
      break;
    } catch (e) {
      console.error(`❌ Screenshot tentativa ${tentativa}: ${e.message}`);
      if (tentativa === 2) {
        const msg = e.message.includes('ERR_NAME_NOT_RESOLVED')
          ? 'Não conseguimos acessar esse link. Verifique se o endereço está correto.'
          : e.message.includes('timeout') || e.message.includes('Timeout')
          ? 'O cardápio demorou demais para carregar. Tente novamente.'
          : 'Erro ao acessar o cardápio. Verifique se o link está correto e tente novamente.';
        return res.status(500).json({ error: msg });
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // Verifica se extraiu texto suficiente
  if (!resultado.dadosProdutos.textoCompleto || resultado.dadosProdutos.textoCompleto.length < 50) {
    return res.status(500).json({ error: 'Não conseguimos ler o conteúdo desse cardápio. Tente com outro link.' });
  }

  // Análise GPT
  let analise;
  try {
    console.log('🤖 Analisando com IA...');
    analise = await analisarCardapio(resultado);
    console.log(`✅ Análise concluída: ${analise.estabelecimento}`);
  } catch (e) {
    console.error('❌ Análise falhou:', e.message);
    return res.status(500).json({ error: e.message || 'Erro na análise. Tente novamente em instantes.' });
  }

  res.json({
    success: true,
    analise,
    screenshotFull: resultado.screenshotFullBase64,
    secoes: resultado.secoes,
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 MenuCheck Backend v2 rodando em http://localhost:${PORT}`);
  console.log(`📋 POST /api/analisar`);
  console.log(`❤️  GET /health\n`);
});
