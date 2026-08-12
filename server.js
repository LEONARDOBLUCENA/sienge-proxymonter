// sienge-proxymonter
// Proxy server para a API REST do Sienge, usado pelo Monter Adm | BI (GitHub Pages).
//
// Por que esse proxy existe:
// 1. A API do Sienge exige Basic Auth com usuário/senha de integração — isso NUNCA pode
//    ficar exposto no HTML do GitHub Pages (qualquer visitante veria no código-fonte).
// 2. A API do Sienge não libera CORS para chamadas diretas do navegador.
// Esse servidor resolve os dois problemas: guarda as credenciais em variáveis de
// ambiente (só existem aqui no Railway) e libera CORS para o domínio do BI.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());

// ---------- Configuração ----------
const {
  SIENGE_SUBDOMINIO,   // ex: "monter" -> https://api.sienge.com.br/monter/public/api/v1
  SIENGE_USUARIO,      // usuário de integração cadastrado no Sienge
  SIENGE_SENHA,        // senha do usuário de integração
  ALLOWED_ORIGIN,       // ex: https://leonardoblucena.github.io (separar por vírgula se mais de um)
  PORT
} = process.env;

const SIENGE_BASE_URL = SIENGE_SUBDOMINIO
  ? `https://api.sienge.com.br/${SIENGE_SUBDOMINIO}/public/api/v1`
  : null;

const originsPermitidos = (ALLOWED_ORIGIN || '*')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: originsPermitidos.includes('*') ? true : originsPermitidos,
  methods: ['GET', 'POST', 'OPTIONS'],
}));

function credenciaisOk() {
  return Boolean(SIENGE_SUBDOMINIO && SIENGE_USUARIO && SIENGE_SENHA);
}

function authHeader() {
  const token = Buffer.from(`${SIENGE_USUARIO}:${SIENGE_SENHA}`).toString('base64');
  return `Basic ${token}`;
}

// ---------- Rotas de diagnóstico ----------

// Raiz - confirma que o serviço subiu
app.get('/', (req, res) => {
  res.json({
    servico: 'sienge-proxymonter',
    status: 'online',
    credenciaisConfiguradas: credenciaisOk(),
  });
});

// Healthcheck simples (Railway usa isso para saber se o deploy está saudável)
app.get('/health', (req, res) => res.status(200).send('ok'));

// Testa se as credenciais do Sienge estão funcionando de fato
app.get('/api/test', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({
      erro: 'Variáveis de ambiente do Sienge não configuradas.',
      faltando: {
        SIENGE_SUBDOMINIO: !SIENGE_SUBDOMINIO,
        SIENGE_USUARIO: !SIENGE_USUARIO,
        SIENGE_SENHA: !SIENGE_SENHA,
      },
    });
  }
  try {
    // /cost-centers é um endpoint leve, bom para só confirmar que a autenticação funciona
    const r = await fetch(`${SIENGE_BASE_URL}/cost-centers?limit=1`, {
      headers: { Authorization: authHeader() },
    });
    const texto = await r.text();
    res.status(r.status).json({
      status: r.status,
      ok: r.ok,
      resposta: safeJson(texto),
    });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao conectar no Sienge', detalhe: String(err) });
  }
});

// ---------- Proxy genérico ----------
// Encaminha qualquer caminho para a API do Sienge, adicionando a autenticação no servidor.
// Exemplo de uso no front-end:
//   fetch('https://sienge-proxymonter.up.railway.app/api/sienge/income?limit=200')
//   fetch('https://sienge-proxymonter.up.railway.app/api/sienge/bills?startDate=2026-01-01&endDate=2026-01-31')
app.get('/api/sienge/*', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const caminho = req.params[0];
  const queryString = req.originalUrl.split('?')[1];
  const url = `${SIENGE_BASE_URL}/${caminho}${queryString ? `?${queryString}` : ''}`;

  try {
    const r = await fetch(url, { headers: { Authorization: authHeader(), Accept: 'application/json' } });
    const texto = await r.text();
    res
      .status(r.status)
      .set('Content-Type', r.headers.get('content-type') || 'application/json')
      .send(texto);
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao consultar a API do Sienge', detalhe: String(err) });
  }
});

function safeJson(texto) {
  try { return JSON.parse(texto); } catch { return texto; }
}

const porta = PORT || 3000;
app.listen(porta, () => {
  console.log(`sienge-proxymonter rodando na porta ${porta}`);
  console.log(`Credenciais do Sienge configuradas: ${credenciaisOk()}`);
});
