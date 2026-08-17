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

// Conta quantas requisições reais saíram pro Sienge nesta execução do processo
// (inclui retries) — a conta Sienge da Solucione tem cota de 20 requisições/dia,
// então cada tentativa gasta cota de verdade, não é "grátis".
let contadorRequisicoesSienge = 0;

// O Sienge bloqueia (status 429) quando recebe requisições rápidas demais OU quando
// a cota diária (20 req/dia) já estourou. Nesse segundo caso, insistir não resolve —
// só queima mais cota esperando. Por isso o retry aqui é curto (poucas tentativas,
// espera menor) — serve pra throttling passageiro, não pra tentar "furar" limite diário.
async function fetchSienge(url, tentativas = 1) {
  for (let i = 0; i < tentativas; i++) {
    contadorRequisicoesSienge++;
    const r = await fetch(url, { headers: { Authorization: authHeader() } });
    if (r.status !== 429) return r;
    if (i === tentativas - 1) return r; // última tentativa: devolve o 429 mesmo, sem esperar de novo
    const jitter = Math.floor(Math.random() * 500);
    await esperar(1500 * (i + 1) + jitter);
  }
}

function safeJson(texto) {
  try { return JSON.parse(texto); } catch { return texto; }
}

function linhaCsv(dataISO, complemento, valor, cc, conta, tipo) {
  const dataLimpa = String(dataISO).slice(0, 10);
  const d = new Date(dataLimpa + 'T00:00:00');
  return {
    data: dataLimpa,
    complemento,
    valor: Number(valor) || 0,
    cc,
    conta,
    tipo,
    mes: d.getMonth(), // 0-indexado, igual ao resto do BI
    ano: d.getFullYear(),
  };
}

// Busca paginada genérica num endpoint da API Bulk Data (envelope {data: [...]})
async function buscarBulkData(recurso, paramsExtras, avisos, nomeParaAviso) {
  let offset = 0;
  const limit = 200;
  let registros = [];
  while (true) {
    const params = new URLSearchParams({ ...paramsExtras, limit: String(limit), offset: String(offset) });
    const r = await fetchSienge(`${SIENGE_BULK_URL}/${recurso}?${params.toString()}`);
    if (!r.ok) { avisos.push(`Falha ao buscar ${nomeParaAviso || recurso}: status ${r.status}`); break; }
    const dados = await r.json();
    const pagina = dados.data || [];
    if (pagina.length > limit) {
      // O Sienge devolveu mais registro do que o "limit" pedido — isso só é possível se ele
      // estiver ignorando o parâmetro e mandando o conjunto inteiro numa resposta só. Pedir
      // "próxima página" nesse caso não traria nada novo, só repetiria o mesmo conjunto
      // completo de novo (foi isso que causou a duplicação investigada antes). Usa essa
      // resposta como o total e para por aqui — economiza a cota que estava sendo
      // desperdiçada em chamadas que não agregavam nada.
      avisos.push(`${nomeParaAviso || recurso}: Sienge devolveu ${pagina.length} registros numa página só (pedimos limit=${limit}) — parece não paginar esse endpoint. Usando a resposta inteira, sem pedir mais páginas.`);
      registros = pagina;
      break;
    }
    registros = registros.concat(pagina);
    if (pagina.length < limit) break;
    offset += limit;
    await esperar(300); // respiro entre páginas
  }
  // Proteção: mesmo com a checagem acima, mantém a deduplicação defensiva — comparando o
  // registro inteiro (JSON), antes de virar linha de CSV — protege contra qualquer outra
  // causa de duplicata que a gente ainda não tenha identificado.
  const vistos = new Set();
  const semDuplicata = [];
  for (const rec of registros) {
    const chave = JSON.stringify(rec);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    semDuplicata.push(rec);
  }
  if (semDuplicata.length < registros.length) {
    avisos.push(`${nomeParaAviso || recurso}: ${registros.length - semDuplicata.length} registro(s) duplicado(s) pelo Sienge foram removidos antes de processar.`);
  }
  return semDuplicata;
}

// ---------- Rotas de diagnóstico ----------

app.get('/', (req, res) => {
  res.json({
    servico: 'sienge-proxymonter',
    status: 'online',
    credenciaisConfiguradas: credenciaisOk(),
  });
});

app.get('/health', (req, res) => res.status(200).send('ok'));

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
    const r = await fetch(`${SIENGE_BASE_URL}/cost-centers?limit=1`, { headers: { Authorization: authHeader() } });
    const texto = await r.text();
    res.status(r.status).json({ status: r.status, ok: r.ok, resposta: safeJson(texto) });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao conectar no Sienge', detalhe: String(err) });
  }
});

// Rota de teste genérica pra qualquer recurso da API Bulk Data — mostra o registro cru,
// sem nenhum mapeamento, pra conferir os nomes reais dos campos antes de programar.
// Uso: /api/sienge/bulk-teste/income?startDate=2026-07-01&endDate=2026-07-31&selectionType=D&correctionIndexerId=0&correctionDate=2026-07-31
app.get('/api/sienge/bulk-teste/:recurso', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const { recurso } = req.params;
  const params = new URLSearchParams(req.query);
  if (!params.has('limit')) params.set('limit', '3');
  try {
    const r = await fetch(`${SIENGE_BULK_URL}/${recurso}?${params.toString()}`, { headers: { Authorization: authHeader() } });
    const texto = await r.text();
    res.status(r.status).json({ status: r.status, ok: r.ok, resposta: safeJson(texto) });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao consultar bulk-data', detalhe: String(err) });
  }
});

// ---------- CONTAS PAGAS (Saídas) — /outcome + /bank-movement (avulsos somados) ----------
// GET /outcome?startDate=&endDate=&selectionType=P&correctionIndexerId=0&correctionDate={endDate}
//   payments[].operationTypeId aceito: 1, 2, 10, 11
//   uma linha por item de buildingsCosts, valor = payment.netAmount × (rate/100)
// GET /bank-movement?startDate=&endDate=&selectionType=M&onlyDetachedMovement=S
//   só bankMovementOperationType === 'S', somado dentro de Contas Pagas
//
// Uso: /api/sienge/sync-contas-pagas?startDate=2026-07-01&endDate=2026-07-31
const OPERATION_TYPES_CONTAS_PAGAS = [1, 2, 10, 11];

function categoriaFinanceira(cat) {
  if (!cat || !cat.financialCategoryId) return null;
  return `${cat.financialCategoryId} - ${cat.financialCategoryName || 'Categoria'}`;
}

app.get('/api/sienge/sync-contas-pagas', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ erro: 'Informe startDate e endDate na URL, formato AAAA-MM-DD.' });
  }

  contadorRequisicoesSienge = 0;
  const linhas = [];
  const avisos = [];

  try {
    // ----- /outcome e /bank-movement rodam em paralelo (são independentes) -----
    // Antes rodava um depois do outro com 1,5s de espera no meio — sem necessidade,
    // já que nenhum depende do resultado do outro.
    const [registrosOutcome, registrosBanco] = await Promise.all([
      buscarBulkData('outcome', {
        startDate, endDate, selectionType: 'P', correctionIndexerId: '0', correctionDate: endDate,
      }, avisos, 'outcome (Contas Pagas)'),
      buscarBulkData('bank-movement', {
        startDate, endDate, selectionType: 'M', onlyDetachedMovement: 'S',
      }, avisos, 'bank-movement'),
    ]);

    registrosOutcome.forEach((rec) => {
      const credorNome = rec.creditorName || 'Fornecedor não identificado';
      const paymentsCategories = rec.paymentsCategories || [];
      const buildingsCosts = rec.buildingsCosts || [];
      (rec.payments || []).forEach((pag) => {
        if (!OPERATION_TYPES_CONTAS_PAGAS.includes(pag.operationTypeId)) return;
        if (!pag.paymentDate) return;
        const netAmount = pag.netAmount ?? pag.amount ?? 0;
        const complemento = `Pagamento - ${credorNome}`;
        if (buildingsCosts.length) {
          buildingsCosts.forEach((bc, idx) => {
            const rate = bc.rate != null ? bc.rate : 100;
            const valor = netAmount * (rate / 100);
            const cat = paymentsCategories[idx] || paymentsCategories[0];
            const conta = categoriaFinanceira(cat) || 'SEM CATEGORIA';
            linhas.push(linhaCsv(pag.paymentDate, complemento, valor, bc.buildingName || 'ADMINISTRATIVO', conta, 'PAGAMENTO'));
          });
        } else if (paymentsCategories.length) {
          paymentsCategories.forEach((cat) => {
            const rate = cat.rate != null ? cat.rate : (100 / paymentsCategories.length);
            const valor = netAmount * (rate / 100);
            linhas.push(linhaCsv(pag.paymentDate, complemento, valor, cat.costCenterName || 'ADMINISTRATIVO', categoriaFinanceira(cat) || 'SEM CATEGORIA', 'PAGAMENTO'));
          });
        } else {
          linhas.push(linhaCsv(pag.paymentDate, complemento, netAmount, 'ADMINISTRATIVO', 'SEM CATEGORIA', 'PAGAMENTO'));
        }
      });
    });

    // ----- /bank-movement (avulsos, sem título vinculado — somados em Contas Pagas) -----
    // (busca já foi feita acima, em paralelo com o /outcome)
    registrosBanco.forEach((rec) => {
      if (rec.bankMovementOperationType !== 'S') return;
      if (!rec.bankMovementDate) return;
      // Transferência entre contas da própria empresa — não é despesa nem receita real, ignora.
      // Identificado por não ter fornecedor/cliente nenhum E o histórico mencionar "transferência".
      const semContraparte = !rec.creditorName && !rec.clientName;
      const historicoTransferencia = /transfer[eê]ncia/i.test(rec.bankMovementHistoricName || '');
      if (semContraparte && historicoTransferencia) return;
      const valorTotal = rec.bankMovementAmount ?? 0;
      const nome = rec.creditorName || rec.clientName || rec.bankMovementHistoricName || 'Movimento avulso';
      const complemento = `Pagamento - ${nome}`;
      // O Sienge grava esse campo como "buldingCosts" (sem "i", grafia real da API)
      const buildingsCosts = rec.buldingCosts || rec.buildingsCosts || [];
      const financialCategories = rec.financialCategories || [];
      if (buildingsCosts.length) {
        buildingsCosts.forEach((bc, idx) => {
          const rate = bc.rate != null ? bc.rate : 100;
          const valor = valorTotal * (rate / 100);
          const cat = financialCategories[idx] || financialCategories[0];
          const conta = categoriaFinanceira(cat) || (bc.costEstimationSheetId ? `${bc.costEstimationSheetId} - ${bc.costEstimationSheetName || 'Orçamento'}` : 'SEM CATEGORIA');
          linhas.push(linhaCsv(rec.bankMovementDate, complemento, valor, bc.buildingName || 'ADMINISTRATIVO', conta, 'PAGAMENTO'));
        });
      } else if (financialCategories.length) {
        financialCategories.forEach((cat) => {
          const rate = cat.rate != null ? cat.rate : (100 / financialCategories.length);
          const valor = valorTotal * (rate / 100);
          linhas.push(linhaCsv(rec.bankMovementDate, complemento, valor, cat.costCenterName || 'ADMINISTRATIVO', categoriaFinanceira(cat) || 'SEM CATEGORIA', 'PAGAMENTO'));
        });
      } else {
        linhas.push(linhaCsv(rec.bankMovementDate, complemento, valorTotal, 'ADMINISTRATIVO', 'SEM CATEGORIA', 'PAGAMENTO'));
      }
    });

    res.json({ status: 200, ok: true, periodo: { startDate, endDate }, totalLinhas: linhas.length, avisos, csv: linhas, chamadasSienge: contadorRequisicoesSienge });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao montar sincronização de Contas Pagas', detalhe: String(err), avisos, chamadasSienge: contadorRequisicoesSienge });
  }
});

// ---------- CONTAS A PAGAR (provisão / pendente) — /outcome ----------
// GET /outcome?startDate=&endDate=&selectionType=D&correctionIndexerId=0&correctionDate={endDate}
//   Aqui só entram os registros que AINDA TÊM SALDO em aberto — o já pago fica de fora
//   dessa aba de propósito (isso é a aba "Contas Pagas", vinda de selectionType=P).
//
// Uso: /api/sienge/sync-contas-a-pagar?startDate=2026-07-01&endDate=2026-07-31
app.get('/api/sienge/sync-contas-a-pagar', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ erro: 'Informe startDate e endDate na URL, formato AAAA-MM-DD.' });
  }

  contadorRequisicoesSienge = 0;
  const linhas = [];
  const avisos = [];

  try {
    const registros = await buscarBulkData('outcome', {
      startDate, endDate, selectionType: 'D', correctionIndexerId: '0', correctionDate: endDate,
    }, avisos, 'outcome (Contas a Pagar)');

    registros.forEach((rec) => {
      const saldo = rec.correctedBalanceAmount ?? rec.balanceAmount ?? 0;
      if (!saldo || saldo <= 0) return; // já foi totalmente pago — entra pela aba Contas Pagas
      if (!rec.dueDate) return;
      const credorNome = rec.creditorName || 'Fornecedor não identificado';
      const complemento = `A pagar - ${credorNome}`;
      const buildingsCosts = rec.buildingsCosts || [];
      const paymentsCategories = rec.paymentsCategories || [];
      // Título pode estar rateado entre mais de uma obra — uma linha por item do rateio,
      // cada uma com sua fatia proporcional do saldo (rate). Antes só pegava o item [0]
      // e jogava o saldo inteiro nele, distorcendo o custo por obra em títulos rateados.
      if (buildingsCosts.length) {
        buildingsCosts.forEach((bc, idx) => {
          const rate = bc.rate != null ? bc.rate : (100 / buildingsCosts.length);
          const valor = saldo * (rate / 100);
          const cat = paymentsCategories[idx] || paymentsCategories[0] || null;
          const conta = categoriaFinanceira(cat) || 'SEM CATEGORIA';
          linhas.push(linhaCsv(rec.dueDate, complemento, valor, bc.buildingName || 'ADMINISTRATIVO', conta, 'PAGAMENTO'));
        });
      } else if (paymentsCategories.length) {
        paymentsCategories.forEach((cat) => {
          const rate = cat.rate != null ? cat.rate : (100 / paymentsCategories.length);
          const valor = saldo * (rate / 100);
          linhas.push(linhaCsv(rec.dueDate, complemento, valor, cat.costCenterName || 'ADMINISTRATIVO', categoriaFinanceira(cat) || 'SEM CATEGORIA', 'PAGAMENTO'));
        });
      } else {
        linhas.push(linhaCsv(rec.dueDate, complemento, saldo, 'ADMINISTRATIVO', 'SEM CATEGORIA', 'PAGAMENTO'));
      }
    });

    res.json({ status: 200, ok: true, periodo: { startDate, endDate }, totalLinhas: linhas.length, avisos, csv: linhas, chamadasSienge: contadorRequisicoesSienge });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao montar sincronização de Contas a Pagar', detalhe: String(err), avisos, chamadasSienge: contadorRequisicoesSienge });
  }
});

// ---------- CONTAS A RECEBER (provisão / pendente) — /income ----------
// GET /income?startDate=&endDate=&selectionType=D&correctionIndexerId=0&correctionDate={endDate}
// Lógica alinhada à documentação do BI Welter (seção 5.2), onde os números batem:
//   - saldo: balanceAmount, com correctedBalanceAmount como reserva (ordem invertida em
//     relação ao que o Monter usava antes)
//   - cliente: clientName, depois customerName, depois creditorName
//   - "já recebido": só descarta o título se ele TEM recebimentos E NENHUM deles é de tipo
//     aceito (1=Pagamento, 2=Outros, 11=Por Bens) — ex: só recebimento cancelado. Um título
//     com recebimento parcial de tipo aceito continua entrando, com o saldo já líquido do
//     que falta receber. Antes o Monter descartava só por ter QUALQUER recebimento.
//
// Uso: /api/sienge/sync-contas-a-receber?startDate=2026-07-01&endDate=2026-07-31
const OPERATION_TYPES_ACEITOS_RECEBIMENTO = [1, 2, 11];
const MAPA_CONTA_RECEBER = {
  CT: '10101 - Receita de Incorporação de Imóveis',
  EMP: '10501 - Empréstimos',
};
const CONTA_RECEBER_PADRAO = '10201 - Receita de Prestação de Serviço';
function contaDeRecebivelFallback(documentId) {
  return MAPA_CONTA_RECEBER[documentId] || CONTA_RECEBER_PADRAO;
}

app.get('/api/sienge/sync-contas-a-receber', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ erro: 'Informe startDate e endDate na URL, formato AAAA-MM-DD.' });
  }

  contadorRequisicoesSienge = 0;
  const linhas = [];
  const avisos = [];

  try {
    const registros = await buscarBulkData('income', {
      startDate, endDate, selectionType: 'D', correctionIndexerId: '0', correctionDate: endDate,
    }, avisos, 'income (Contas a Receber)');

    registros.forEach((rec) => {
      const recebimentos = rec.receipts || [];
      const temRecebimento = recebimentos.length > 0;
      const temRecebimentoAceito = recebimentos.some((p) => OPERATION_TYPES_ACEITOS_RECEBIMENTO.includes(p.operationTypeId));
      if (temRecebimento && !temRecebimentoAceito) return; // só recebimento de tipo não aceito (ex: cancelamento) — descarta
      const saldo = rec.balanceAmount ?? rec.correctedBalanceAmount ?? 0;
      if (!saldo || saldo <= 0) return;
      if (!rec.dueDate) return;
      const cliente = rec.clientName || rec.customerName || rec.creditorName || 'Cliente não identificado';
      const complemento = `A receber - ${cliente}`;
      const receiptsCategories = rec.receiptsCategories || [];
      const fallbackConta = contaDeRecebivelFallback(rec.documentIdentificationId || rec.documentId);
      // Título pode estar rateado entre mais de uma obra — uma linha por item do rateio,
      // cada uma com sua fatia proporcional do saldo. Campo de percentual no /income é
      // "financialCategoryRate" (nome diferente do "rate" usado em /outcome).
      if (receiptsCategories.length) {
        receiptsCategories.forEach((cat) => {
          const rate = cat.financialCategoryRate != null ? cat.financialCategoryRate
            : (cat.rate != null ? cat.rate : (100 / receiptsCategories.length));
          const valor = saldo * (rate / 100);
          const cc = cat.costCenterName || 'ADMINISTRATIVO';
          const conta = categoriaFinanceira(cat) || fallbackConta;
          linhas.push(linhaCsv(rec.dueDate, complemento, valor, cc, conta, 'FATURAMENTO'));
        });
      } else {
        linhas.push(linhaCsv(rec.dueDate, complemento, saldo, 'ADMINISTRATIVO', fallbackConta, 'FATURAMENTO'));
      }
    });

    res.json({ status: 200, ok: true, periodo: { startDate, endDate }, totalLinhas: linhas.length, avisos, csv: linhas, chamadasSienge: contadorRequisicoesSienge });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao montar sincronização de Contas a Receber', detalhe: String(err), avisos, chamadasSienge: contadorRequisicoesSienge });
  }
});

// ---------- Proxy genérico (v1) — útil para testar/explorar endpoints pontualmente ----------
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
    res.status(r.status).set('Content-Type', r.headers.get('content-type') || 'application/json').send(texto);
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao consultar a API do Sienge', detalhe: String(err) });
  }
});

const porta = PORT || 3000;
app.listen(porta, () => {
  console.log(`sienge-proxymonter rodando na porta ${porta}`);
  console.log(`Credenciais do Sienge configuradas: ${credenciaisOk()}`);
});
