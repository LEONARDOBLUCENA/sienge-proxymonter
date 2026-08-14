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
  SIENGE_SUBDOMINIO,   // ex: "solucioneimoveis" -> https://api.sienge.com.br/solucioneimoveis/public/api/v1
  SIENGE_USUARIO,      // usuário de integração cadastrado no Sienge
  SIENGE_SENHA,        // senha do usuário de integração
  ALLOWED_ORIGIN,      // ex: https://leonardoblucena.github.io (separar por vírgula se mais de um)
  PORT
} = process.env;

const SIENGE_BASE_URL = SIENGE_SUBDOMINIO
  ? `https://api.sienge.com.br/${SIENGE_SUBDOMINIO}/public/api/v1`
  : null;

const SIENGE_BULK_URL = SIENGE_SUBDOMINIO
  ? `https://api.sienge.com.br/${SIENGE_SUBDOMINIO}/public/api/bulk-data/v1`
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

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// O Sienge bloqueia (status 429) quando recebe requisições rápidas demais.
// Essa função tenta de novo, esperando um pouco mais a cada tentativa (com uma variação
// aleatória, pra evitar que chamadas em paralelo tentem de novo todas no mesmo instante).
async function fetchSienge(url, tentativas = 8) {
  for (let i = 0; i < tentativas; i++) {
    const r = await fetch(url, { headers: { Authorization: authHeader() } });
    if (r.status !== 429) return r;
    const jitter = Math.floor(Math.random() * 500);
    await esperar(1200 * (i + 1) + jitter);
  }
  return fetch(url, { headers: { Authorization: authHeader() } });
}

function safeJson(texto) {
  try { return JSON.parse(texto); } catch { return texto; }
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

// Cache de obra por recebível (usado em Contas a Receber) — guardado em memória enquanto
// o servidor está no ar. Essa rota limpa esse cache, útil se algum resultado errado tiver
// ficado guardado (ex: por causa de um bloqueio 429 no meio de uma sincronização).
app.get('/api/limpar-cache', (req, res) => {
  const antes = { empreendimentos: cacheEmpreendimentos.size };
  cacheEmpreendimentos.clear();
  res.json({ ok: true, limpo: antes });
});

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

// ---------- Sync completo: devolve linhas prontas no formato DATA.csv do BI ----------
// Junta Contas a Pagar e Contas a Receber, já mapeados para {data, complemento, valor, cc, conta, tipo, mes, ano}.
// Isso é o que o botão "Sync Sienge" do BI chama.
//
// Uso: /api/sienge/sync-completo?startDate=2026-01-01&endDate=2026-01-31
//
// Contas a Pagar vem da API Bulk Data /outcome (bem mais rápida que ir título por título):
//   selectionType=D (vencimento) -> parcelas com saldo em aberto = "A pagar"
//   selectionType=P (data de pagamento) -> pagamentos de verdade, na data real = "Pagamento"
// Já traz fornecedor, obra (costCenterName) e conta financeira (financialCategory) prontos.
//
// Contas a Receber vem de /current-debit-balance por cliente (não tem endpoint Bulk Data
// equivalente conhecido) — não tem um "plano financeiro" como o Contas a Pagar, só um
// código de documento (CT/EMP/REC/FAT/...), mapeado abaixo:
const MAPA_CONTA_RECEBER = {
  CT: '10101 - Receita de Incorporação de Imóveis',
  EMP: '10501 - Empréstimos',
};
const CONTA_RECEBER_PADRAO = '10201 - Receita de Prestação de Serviço';
function contaDeRecebivel(documentId) {
  return MAPA_CONTA_RECEBER[documentId] || CONTA_RECEBER_PADRAO;
}

// Cache em memória de obra por recebível — evita repetir a mesma consulta várias vezes
// dentro da mesma sincronização (um cliente pode ter várias parcelas do mesmo recebível).
const cacheEmpreendimentos = new Map();
async function obraDoRecebivel(billReceivableId) {
  const chave = `recebivel-${billReceivableId}`;
  if (cacheEmpreendimentos.has(chave)) return cacheEmpreendimentos.get(chave);
  try {
    const r = await fetchSienge(`${SIENGE_BASE_URL}/accounts-receivable/receivable-bills/${billReceivableId}`);
    if (r.status === 404) { cacheEmpreendimentos.set(chave, 'ADMINISTRATIVO'); return 'ADMINISTRATIVO'; }
    if (!r.ok) return null; // falha real na consulta (ex: 429 persistente) — não assume ADMINISTRATIVO
    const d = await r.json();
    const nome = d.enterpriseName || 'ADMINISTRATIVO';
    cacheEmpreendimentos.set(chave, nome);
    return nome;
  } catch {
    return null;
  }
}

function linhaCsv(dataISO, complemento, valor, cc, conta, tipo) {
  const d = new Date(dataISO + 'T00:00:00');
  return {
    data: dataISO,
    complemento,
    valor: Number(valor) || 0,
    cc,
    conta,
    tipo,
    mes: d.getMonth(), // 0-indexado, igual ao resto do BI
    ano: d.getFullYear(),
  };
}

app.get('/api/sienge/sync-completo', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ erro: 'Informe startDate e endDate na URL, formato AAAA-MM-DD.' });
  }

  const linhas = [];
  const avisos = [];
  const debugAtivo = req.query.debug === '1';

  try {
    // ===== CONTAS A PAGAR (via bulk-data /outcome) =====
    async function buscarOutcome(tipoSelecao) {
      let offset = 0;
      const limit = 200;
      let registros = [];
      while (true) {
        const params = new URLSearchParams({
          startDate, endDate, selectionType: tipoSelecao,
          correctionIndexerId: '0',
          correctionDate: endDate,
          limit: String(limit),
          offset: String(offset),
        });
        const r = await fetchSienge(`${SIENGE_BULK_URL}/outcome?${params.toString()}`);
        if (!r.ok) { avisos.push(`Falha ao buscar outcome (${tipoSelecao}): status ${r.status}`); break; }
        const dados = await r.json();
        const pagina = dados.data || [];
        registros = registros.concat(pagina);
        if (pagina.length < limit) break;
        offset += limit;
        await esperar(300); // respiro entre páginas — evita bloqueio em períodos grandes com muitas páginas
      }
      return registros;
    }

    const categoriaDoRegistro = (rec) => {
      const cat = (rec.paymentsCategories && rec.paymentsCategories[0]) || {};
      return cat.financialCategoryId ? `${cat.financialCategoryId} - ${cat.financialCategoryName || 'Categoria'}` : 'SEM CATEGORIA';
    };
    const obraDoRegistro = (rec) => {
      const cat = (rec.paymentsCategories && rec.paymentsCategories[0]) || {};
      return cat.costCenterName || 'ADMINISTRATIVO';
    };

    // Vencimento (D) — só interessa quem AINDA TEM SALDO em aberto (vira "A pagar")
    const registrosD = await buscarOutcome('D');
    await esperar(1500); // respiro antes da segunda busca
    registrosD.forEach((rec) => {
      const saldo = rec.correctedBalanceAmount ?? rec.balanceAmount ?? 0;
      if (!saldo || saldo <= 0) return; // já foi totalmente pago — o pagamento entra pela busca de pagamento (P)
      if (!rec.dueDate) return;
      linhas.push(linhaCsv(rec.dueDate, `A pagar - ${rec.creditorName || 'Fornecedor não identificado'}`, saldo, obraDoRegistro(rec), categoriaDoRegistro(rec), 'PAGAMENTO'));
    });

    // Pagamento (P) — cada pagamento de verdade, na data real em que aconteceu
    const registrosP = await buscarOutcome('P');
    let totalPagamentosEncontrados = 0;
    registrosP.forEach((rec) => {
      (rec.payments || []).forEach((pag) => {
        if (!pag.paymentDate) return;
        const valor = pag.netAmount ?? pag.amount ?? 0;
        linhas.push(linhaCsv(pag.paymentDate, `Pagamento - ${rec.creditorName || 'Fornecedor não identificado'}`, valor, obraDoRegistro(rec), categoriaDoRegistro(rec), 'PAGAMENTO'));
        totalPagamentosEncontrados++;
      });
    });

    if (debugAtivo) {
      avisos.push(`[debug] registros D: ${registrosD.length}, registros P: ${registrosP.length}, pagamentos individuais: ${totalPagamentosEncontrados}`);
    }

    // ===== CONTAS A RECEBER =====
    await esperar(2000); // pausa maior entre as duas fases, para o limite do Sienge "resetar"
    const limitePorPagina = 100;
    let offset = 0;
    let clientes = [];
    while (true) {
      const url = `${SIENGE_BASE_URL}/customers?limit=${limitePorPagina}&offset=${offset}`;
      const r = await fetchSienge(url);
      if (!r.ok) { avisos.push(`Falha ao buscar customers: status ${r.status}`); break; }
      const dados = await r.json();
      const pagina = dados.results || [];
      clientes = clientes.concat(pagina);
      const total = (dados.resultSetMetadata && dados.resultSetMetadata.count) || 0;
      offset += limitePorPagina;
      if (pagina.length === 0 || offset >= total) break;
    }
    const clientesComDocumento = clientes.filter(c => c.cpf || c.cnpj);

    const TAMANHO_LOTE_CLIENTES = 1; // sequencial de propósito — essa etapa foi a que mais travou no Sienge
    for (let i = 0; i < clientesComDocumento.length; i += TAMANHO_LOTE_CLIENTES) {
      const lote = clientesComDocumento.slice(i, i + TAMANHO_LOTE_CLIENTES);
      await Promise.all(lote.map(async (cliente) => {
        const paramDoc = cliente.cnpj ? `cnpj=${cliente.cnpj}` : `cpf=${cliente.cpf}`;
        try {
          const rSaldo = await fetchSienge(`${SIENGE_BASE_URL}/current-debit-balance?${paramDoc}`);
          if (!rSaldo.ok) { avisos.push(`Erro no cliente ${cliente.name}: status ${rSaldo.status}`); return; }
          const dadosSaldo = await rSaldo.json();
          const contasRecebiveis = dadosSaldo.results || [];

          for (const conta of contasRecebiveis) {
            const contaTexto = contaDeRecebivel(conta.documentId);
            let obraNome = await obraDoRecebivel(conta.billReceivableId);
            if (obraNome === null) { obraNome = 'FALHA NA CONSULTA (sincronize de novo)'; avisos.push(`Falha ao buscar obra do recebível ${conta.billReceivableId} (cliente ${cliente.name}) — linha marcada, sincronize de novo`); }

            (conta.paidInstallments || []).forEach((inst) => {
              (inst.receipts || []).forEach((rec) => {
                if (!rec.receiptDate) return;
                if (rec.receiptDate < startDate || rec.receiptDate > endDate) return; // filtra pelo período pedido
                linhas.push(linhaCsv(rec.receiptDate, `Recebimento - ${cliente.name}`, rec.receiptValue, obraNome, contaTexto, 'FATURAMENTO'));
              });
            });
            (conta.payableInstallments || []).forEach((inst) => {
              if (!inst.dueDate) return;
              if (inst.dueDate < startDate || inst.dueDate > endDate) return;
              linhas.push(linhaCsv(inst.dueDate, `A receber - ${cliente.name}`, inst.currentBalance, obraNome, contaTexto, 'FATURAMENTO'));
            });
          }
        } catch (e) {
          avisos.push(`Erro no cliente ${cliente.name}: ${String(e)}`);
        }
      }));
      await esperar(400);
    }

    res.json({
      status: 200,
      ok: true,
      periodo: { startDate, endDate },
      totalLinhas: linhas.length,
      avisos,
      csv: linhas,
    });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao montar sincronização completa', detalhe: String(err), avisos });
  }
});

// ---------- Proxy genérico ----------
// Encaminha qualquer caminho para a API REST "normal" do Sienge (v1), adicionando a
// autenticação no servidor. Útil para testar/explorar endpoints pontualmente.
// Exemplo: /api/sienge/bills?startDate=2026-01-01&endDate=2026-01-31
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

const porta = PORT || 3000;
app.listen(porta, () => {
  console.log(`sienge-proxymonter rodando na porta ${porta}`);
  console.log(`Credenciais do Sienge configuradas: ${credenciaisOk()}`);
});
