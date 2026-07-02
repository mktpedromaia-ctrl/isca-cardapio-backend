const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

async function fecharModais(page) {
  // 1. Tenta pressionar Escape
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 400));

  // 2. Tenta clicar em botões de fechar conhecidos
  const seletores = [
    'button.MuiIconButton-root[class*="z-20"]',
    'button[aria-label="Fechar"]',
    'button[aria-label="Close"]',
    'button[aria-label="fechar"]',
    '[data-testid="modal-close"]',
    '[class*="close-button"]',
    '[class*="closeButton"]',
    '[class*="btn-close"]',
    // Cardápio Web — botão X do modal de promoções
    'button[class*="CloseButton"]',
    'button[class*="close"]',
    'svg[class*="close"]',
  ];
  for (const sel of seletores) {
    try { await page.click(sel); await new Promise(r => setTimeout(r, 300)); } catch (_) {}
  }

  // 3. Remove overlays diretamente do DOM
  await page.evaluate(() => {
    // Clica em qualquer botão que pareça ser de fechar modal
    document.querySelectorAll('button, [role="button"]').forEach(btn => {
      const txt = (btn.textContent || '').trim().toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const cls = (btn.className || '').toLowerCase();
      if (txt === 'x' || txt === '×' || txt === 'fechar' || txt === 'close' ||
          aria.includes('fecha') || aria.includes('close') ||
          cls.includes('close') || cls.includes('dismiss')) {
        try { btn.click(); } catch(_) {}
      }
    });

    // Remove elementos que cobrem a tela inteira (modais, overlays, backdrops)
    const toRemove = [
      '.MuiDialog-root', '.MuiModal-root', '.MuiBackdrop-root',
      '[class*="Modal"]', '[class*="modal"]',
      '[class*="Dialog"]', '[class*="dialog"]',
      '[class*="Overlay"]', '[class*="overlay"]',
      '[class*="Backdrop"]', '[class*="backdrop"]',
      '[class*="Popup"]',  '[class*="popup"]',
      '[class*="Sheet"]',  '[class*="sheet"]',
      '[class*="Drawer"]', '[class*="drawer"]',
    ];
    toRemove.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        const rect = el.getBoundingClientRect();
        // Remove apenas se for grande o suficiente para ser um overlay
        if (rect.width > 250 && rect.height > 150) el.remove();
      });
    });

    // Remove elementos com position:fixed que cobrem a tela
    document.querySelectorAll('*').forEach(el => {
      const s = window.getComputedStyle(el);
      if (s.position === 'fixed' || s.position === 'sticky') {
        const rect = el.getBoundingClientRect();
        // Só remove se cobrir mais de 40% da largura e 30% da altura da tela
        if (rect.width > window.innerWidth * 0.4 && rect.height > window.innerHeight * 0.3) {
          el.remove();
        }
      }
    });

    // Restaura scroll
    document.body.style.overflow = 'auto';
    document.body.style.overflowY = 'auto';
    document.body.style.paddingRight = '0';
    document.documentElement.style.overflow = 'auto';
  });

  await new Promise(r => setTimeout(r, 600));
}

async function capturarCardapio(url) {
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--single-process',
    ]
  };

  // Usa executablePath customizado se definido (ex: via env var)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteerExtra.launch(launchOptions);

  const page = await browser.newPage();

  // Simula iPhone 14 Pro — a página renderiza exatamente como o usuário vê no celular
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 4000));

  // Sem manipulação de modal aqui — modal será removido logo antes do screenshot

  // Fecha modais genéricos — tenta duas vezes pois alguns aparecem com delay
  await fecharModais(page);
  await new Promise(r => setTimeout(r, 1200));
  await fecharModais(page);
  await new Promise(r => setTimeout(r, 800));

  // Detecta se o scroll está num container interno (ex: cardapioweb usa #root)
  const scrollContainer = await page.evaluate(() => {
    const root = document.getElementById('root');
    const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    return (root && root.scrollHeight > docHeight) ? 'root' : 'document';
  });

  // Scrolla devagar pra disparar lazy loading de imagens
  await page.evaluate(async (container) => {
    const el = container === 'root' ? document.getElementById('root') : null;
    await new Promise(resolve => {
      let total = 0;
      const step = 250;
      const max = el ? el.scrollHeight : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const timer = setInterval(() => {
        if (el) el.scrollTop += step; else window.scrollBy(0, step);
        total += step;
        if (total >= max) { clearInterval(timer); resolve(); }
      }, 150);
    });
  }, scrollContainer);

  await new Promise(r => setTimeout(r, 3000));

  // Fecha modais que aparecem durante o scroll
  await fecharModais(page);
  await new Promise(r => setTimeout(r, 800));

  // Aguarda todas as imagens terminarem de carregar
  await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('img')];
    await Promise.all(imgs.map(img =>
      img.complete ? Promise.resolve() :
        new Promise(res => { img.onload = res; img.onerror = res; setTimeout(res, 3000); })
    ));
  });

  // Extrai texto dos produtos + detecta fotos direto no DOM
  const dadosProdutos = await page.evaluate(() => {
    const textoCompleto = document.body.innerText;
    const produtosMap = new Map();

    document.querySelectorAll('*').forEach(el => {
      const texto = el.innerText || '';
      if (texto.match(/R\$\s*\d+[,\.]\d{2}/) && texto.length < 500) {
        const linhas = texto.split('\n').filter(l => l.trim());
        if (linhas.length < 2) return;
        const chave = texto.trim().slice(0, 300);
        if (produtosMap.has(chave)) return;

        // Verifica se este container de produto tem imagem real (não ícone/logo)
        // Verifica <img> tags
        const imgs = el.querySelectorAll('img');
        const temFotoImg = [...imgs].some(img => {
          const src = img.src || img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
          if (!src || src.startsWith('data:image/svg') || src.startsWith('data:image/gif')) return false;
          const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0');
          const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '0');
          const grande = (w === 0 || w > 50) && (h === 0 || h > 50);
          const naoEhLogo = !src.toLowerCase().includes('logo') &&
                            !src.toLowerCase().includes('banner') &&
                            !src.toLowerCase().includes('icon') &&
                            !src.toLowerCase().includes('avatar') &&
                            !src.toLowerCase().includes('placeholder');
          return grande && naoEhLogo;
        });
        // Verifica background-image via CSS (iFood e outros usam isso para foto do produto)
        const temFotoBg = !temFotoImg && [...el.querySelectorAll('*')].some(child => {
          try {
            const bg = window.getComputedStyle(child).backgroundImage;
            if (!bg || bg === 'none' || bg.includes('gradient')) return false;
            const urlMatch = bg.match(/url\(["']?([^"')]+)/);
            if (!urlMatch) return false;
            const url = urlMatch[1];
            const rect = child.getBoundingClientRect();
            const grande = rect.width > 50 && rect.height > 50;
            const naoEhLogo = !url.toLowerCase().includes('logo') &&
                              !url.toLowerCase().includes('banner') &&
                              !url.toLowerCase().includes('icon') &&
                              !url.toLowerCase().includes('placeholder');
            return grande && naoEhLogo;
          } catch(_) { return false; }
        });
        const temFoto = temFotoImg || temFotoBg;

        produtosMap.set(chave, temFoto);
      }
    });

    const produtosArray = [...produtosMap.entries()].slice(0, 500);
    const totalComFoto = produtosArray.filter(([, f]) => f).length;

    return {
      textoCompleto: textoCompleto.slice(0, 40000),
      produtos: produtosArray.map(([t]) => t),
      produtosComFoto: totalComFoto,
      produtosSemFoto: produtosArray.length - totalComFoto,
      totalDetectados: produtosArray.length,
      detalheFotos: produtosArray.map(([texto, temFoto]) => ({ texto: texto.slice(0, 80), temFoto })),
    };
  });

  // Viewport já está em 390px mobile desde o início — sem necessidade de mudar

  // Calcula altura real da página (considerando container #root se necessário)
  const alturaTotal = await page.evaluate((container) => {
    if (container === 'root') {
      const el = document.getElementById('root');
      return el ? el.scrollHeight : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    }
    return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  }, scrollContainer);

  // Screenshots de 5 seções distribuídas pela página inteira
  const secoes = [];
  const numSecoes = 5;
  for (let i = 0; i < numSecoes; i++) {
    const posY = Math.floor((alturaTotal / (numSecoes - 1)) * i);
    await page.evaluate((y, container) => {
      if (container === 'root') {
        const el = document.getElementById('root');
        if (el) { el.scrollTop = y; return; }
      }
      window.scrollTo({ top: y, behavior: 'instant' });
    }, posY, scrollContainer);
    await new Promise(r => setTimeout(r, 600));
    const secao = await page.screenshot({ type: 'jpeg', quality: 75 });
    secoes.push(secao.toString('base64'));
  }

  // Volta pro topo
  await page.evaluate((container) => {
    if (container === 'root') document.getElementById('root').scrollTop = 0;
    window.scrollTo(0, 0);
  }, scrollContainer);
  await new Promise(r => setTimeout(r, 600));

  // Captura altura total real (qualquer container)
  const fullHeight = await page.evaluate((container) => {
    if (container === 'root') {
      const el = document.getElementById('root');
      if (el) return el.scrollHeight;
    }
    return Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight
    );
  }, scrollContainer);

  // Redimensiona o viewport para a altura total da página
  await page.setViewport({ width: 390, height: Math.min(fullHeight + 100, 20000) });
  await new Promise(r => setTimeout(r, 1000));

  // Remove modais/popups do DOM imediatamente antes do screenshot
  await page.evaluate(() => {
    ['.MuiDialog-root','.MuiModal-root','.MuiBackdrop-root',
     '[class*="DialogOverlay"]','[class*="ModalOverlay"]'].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });
    document.body.style.overflow = 'auto';
    document.documentElement.style.overflow = 'auto';
  });
  await new Promise(r => setTimeout(r, 300));

  // Screenshot da página inteira (viewport = página toda)
  const screenshotFull = await page.screenshot({
    type: 'jpeg',
    quality: 80
  });

  await browser.close();

  return {
    screenshotFull,
    screenshotFullBase64: screenshotFull.toString('base64'),
    secoes,
    dadosProdutos,
  };
}

module.exports = { capturarCardapio };
