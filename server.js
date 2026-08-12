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

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// O Sienge bloqueia (status 429) quando recebe requisições rápidas demais.
// Essa função tenta de novo, esperando um pouco mais a cada tentativa.
async function fetchSienge(url, tentativas = 4) {
  for (let i = 0; i < tentativas; i++) {
    const r = await fetch(url, { headers: { Authorization: authHeader() } });
    if (r.status !== 429) return r;
    await esperar(700 * (i + 1));
  }
  return fetch(url, { headers: { Authorization: authHeader() } });
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

// ---------- Contas a Pagar completo (títulos + parcelas, pago x a pagar) ----------
// Isso resolve o trabalho manual de abrir /bills e depois cada /bills/{id}/installments
// um por um. Aqui o servidor já faz tudo isso e devolve pronto, uma linha por parcela.
//
// Uso: /api/sienge/contas-pagar-completo?startDate=2026-01-01&endDate=2026-01-31
app.get('/api/sienge/contas-pagar-completo', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ erro: 'Informe startDate e endDate na URL, formato AAAA-MM-DD. Ex: ?startDate=2026-01-01&endDate=2026-01-31' });
  }

  try {
    // 1) Busca todos os títulos (bills) do período, paginando (a API devolve no máximo 100/200 por vez)
    const limitePorPagina = 100;
    let offset = 0;
    let bills = [];
    while (true) {
      const url = `${SIENGE_BASE_URL}/bills?startDate=${startDate}&endDate=${endDate}&selectionType=D&limit=${limitePorPagina}&offset=${offset}`;
      const r = await fetch(url, { headers: { Authorization: authHeader() } });
      if (!r.ok) {
        const texto = await r.text();
        return res.status(r.status).json({ erro: 'Falha ao buscar títulos (bills)', resposta: safeJson(texto) });
      }
      const dados = await r.json();
      const pagina = dados.results || [];
      bills = bills.concat(pagina);
      const total = (dados.resultSetMetadata && dados.resultSetMetadata.count) || 0;
      offset += limitePorPagina;
      if (pagina.length === 0 || offset >= total) break;
    }

    // 2) Para cada título, busca as parcelas (installments) — em lotes, para não sobrecarregar a API do Sienge
    const TAMANHO_LOTE = 5;
    const comInstallments = [];
    for (let i = 0; i < bills.length; i += TAMANHO_LOTE) {
      const lote = bills.slice(i, i + TAMANHO_LOTE);
      const respostasLote = await Promise.all(lote.map(async (bill) => {
        try {
          const rInst = await fetch(`${SIENGE_BASE_URL}/bills/${bill.id}/installments`, {
            headers: { Authorization: authHeader() },
          });
          if (!rInst.ok) return { bill, installments: [], erroParcelas: `status ${rInst.status}` };
          const dadosInst = await rInst.json();
          const installments = Array.isArray(dadosInst) ? dadosInst : (dadosInst.results || []);
          return { bill, installments };
        } catch (e) {
          return { bill, installments: [], erroParcelas: String(e) };
        }
      }));
      comInstallments.push(...respostasLote);
    }

    // 3) Achata tudo em uma lista simples: uma linha por parcela, já classificada
    const parcelas = [];
    comInstallments.forEach(({ bill, installments, erroParcelas }) => {
      if (!installments.length) {
        parcelas.push({
          billId: bill.id,
          documentNumber: bill.documentNumber,
          documentIdentificationId: bill.documentIdentificationId,
          creditorId: bill.creditorId,
          debtorId: bill.debtorId,
          issueDate: bill.issueDate,
          totalInvoiceAmount: bill.totalInvoiceAmount,
          erroParcelas: erroParcelas || 'Sem parcelas retornadas',
        });
        return;
      }
      installments.forEach((inst) => {
        // Campos de saldo/valor variam um pouco conforme a API do Sienge — mantemos o "raw"
        // para você conferir os nomes exatos e eu ajustar aqui se precisar.
        const saldo = inst.balanceAmount ?? inst.currentBalance ?? null;
        const pago = saldo !== null ? saldo <= 0 : (inst.status === 'paid' || inst.status === 2 || inst.status === 3);
        parcelas.push({
          billId: bill.id,
          documentNumber: bill.documentNumber,
          documentIdentificationId: bill.documentIdentificationId,
          creditorId: bill.creditorId,
          debtorId: bill.debtorId,
          issueDate: bill.issueDate,
          installmentId: inst.id ?? inst.installmentId,
          dueDate: inst.dueDate,
          amount: inst.amount ?? inst.originalValue ?? null,
          balance: saldo,
          pago,
          raw: inst,
        });
      });
    });

    res.json({
      status: 200,
      ok: true,
      periodo: { startDate, endDate },
      totalTitulos: bills.length,
      totalParcelas: parcelas.length,
      resultados: parcelas,
    });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao montar contas a pagar completo', detalhe: String(err) });
  }
});

// ---------- Contas a Receber completo (clientes + parcelas, recebido x a receber) ----------
// Busca todos os clientes e, para cada um, consulta o saldo devedor (que já traz as
// parcelas pagas e as parcelas em aberto). Devolve tudo achatado, uma linha por parcela.
//
// Uso: /api/sienge/contas-receber-completo
app.get('/api/sienge/contas-receber-completo', async (req, res) => {
  if (!credenciaisOk()) {
    return res.status(500).json({ erro: 'Variáveis de ambiente do Sienge não configuradas no Railway.' });
  }

  try {
    // 1) Busca todos os clientes, paginando
    const limitePorPagina = 100;
    let offset = 0;
    let clientes = [];
    while (true) {
      const url = `${SIENGE_BASE_URL}/customers?limit=${limitePorPagina}&offset=${offset}`;
      const r = await fetch(url, { headers: { Authorization: authHeader() } });
      if (!r.ok) {
        const texto = await r.text();
        return res.status(r.status).json({ erro: 'Falha ao buscar clientes (customers)', resposta: safeJson(texto) });
      }
      const dados = await r.json();
      const pagina = dados.results || [];
      clientes = clientes.concat(pagina);
      const total = (dados.resultSetMetadata && dados.resultSetMetadata.count) || 0;
      offset += limitePorPagina;
      if (pagina.length === 0 || offset >= total) break;
    }

    // Só interessam os clientes que têm CPF ou CNPJ (current-debit-balance exige um dos dois)
    const clientesComDocumento = clientes.filter(c => c.cpf || c.cnpj);

    // 2) Para cada cliente, busca o saldo devedor presente (em lotes, para não sobrecarregar o Sienge)
    const TAMANHO_LOTE = 5;
    const comSaldo = [];
    for (let i = 0; i < clientesComDocumento.length; i += TAMANHO_LOTE) {
      const lote = clientesComDocumento.slice(i, i + TAMANHO_LOTE);
      const respostasLote = await Promise.all(lote.map(async (cliente) => {
        const paramDoc = cliente.cnpj ? `cnpj=${cliente.cnpj}` : `cpf=${cliente.cpf}`;
        try {
          const rSaldo = await fetch(`${SIENGE_BASE_URL}/current-debit-balance?${paramDoc}`, {
            headers: { Authorization: authHeader() },
          });
          if (!rSaldo.ok) return { cliente, contas: [], erroSaldo: `status ${rSaldo.status}` };
          const dadosSaldo = await rSaldo.json();
          const contas = dadosSaldo.results || [];
          return { cliente, contas };
        } catch (e) {
          return { cliente, contas: [], erroSaldo: String(e) };
        }
      }));
      comSaldo.push(...respostasLote);
    }

    // 3) Achata tudo em uma lista simples: uma linha por parcela, já classificada
    const parcelas = [];
    comSaldo.forEach(({ cliente, contas, erroSaldo }) => {
      if (erroSaldo) {
        parcelas.push({
          customerId: cliente.id,
          customerName: cliente.name,
          erroSaldo,
        });
        return;
      }
      contas.forEach((conta) => {
        (conta.paidInstallments || []).forEach((inst) => {
          parcelas.push({
            customerId: cliente.id,
            customerName: cliente.name,
            billReceivableId: conta.billReceivableId,
            documentId: conta.documentId,
            installmentId: inst.installmentId,
            dueDate: inst.dueDate,
            originalValue: inst.originalValue,
            adjustedValue: inst.adjustedValue,
            recebido: true,
            recibos: inst.receipts || [],
          });
        });
        (conta.payableInstallments || []).forEach((inst) => {
          parcelas.push({
            customerId: cliente.id,
            customerName: cliente.name,
            billReceivableId: conta.billReceivableId,
            documentId: conta.documentId,
            installmentId: inst.installmentId,
            dueDate: inst.dueDate,
            originalValue: inst.originalValue,
            adjustedValue: inst.adjustedValue,
            currentBalance: inst.currentBalance,
            recebido: false,
          });
        });
      });
    });

    res.json({
      status: 200,
      ok: true,
      totalClientes: clientesComDocumento.length,
      totalParcelas: parcelas.length,
      resultados: parcelas,
    });
  } catch (err) {
    res.status(502).json({ erro: 'Falha ao montar contas a receber completo', detalhe: String(err) });
  }
});

// ---------- Sync completo: devolve linhas prontas no formato DATA.csv do BI ----------
// Junta Contas a Pagar e Contas a Receber, já mapeados para {data, complemento, valor, cc, conta, tipo, mes, ano}.
// Isso é o que o botão "Sync Sienge" do BI vai chamar.
//
// Uso: /api/sienge/sync-completo?startDate=2026-01-01&endDate=2026-01-31
//
// Mapeamento de Contas a Receber (não tem plano financeiro, só um código de documento):
//   CT  -> 10101 - Receita de Incorporação de Imóveis (venda de imóvel)
//   EMP -> 10501 - Empréstimos
//   REC, FAT, outros -> 10201 - Receita de Prestação de Serviço
const MAPA_CONTA_RECEBER = {
  CT: '10101 - Receita de Incorporação de Imóveis',
  EMP: '10501 - Empréstimos',
};
const CONTA_RECEBER_PADRAO = '10201 - Receita de Prestação de Serviço';

function contaDeRecebivel(documentId) {
  return MAPA_CONTA_RECEBER[documentId] || CONTA_RECEBER_PADRAO;
}

// Caches simples em memória (duram enquanto o servidor está no ar) — evitam repetir
// chamadas ao Sienge para o mesmo fornecedor/conta/obra dentro da mesma sincronização.
const cacheCredores = new Map();
const cacheCategorias = new Map();
const cacheEmpreendimentos = new Map();

async function nomeCredor(creditorId) {
  if (!creditorId) return 'Fornecedor não identificado';
  if (cacheCredores.has(creditorId)) return cacheCredores.get(creditorId);
  try {
    const r = await fetchSienge(`${SIENGE_BASE_URL}/creditors/${creditorId}`);
    if (!r.ok) { cacheCredores.set(creditorId, `Credor ${creditorId}`); return cacheCredores.get(creditorId); }
    const d = await r.json();
    const nome = d.name || d.tradeName || `Credor ${creditorId}`;
    cacheCredores.set(creditorId, nome);
    return nome;
  } catch {
    return `Credor ${creditorId}`;
  }
}

async function nomeCategoria(categoriaId) {
  if (!categoriaId) return null;
  if (cacheCategorias.has(categoriaId)) return cacheCategorias.get(categoriaId);
  try {
    const r = await fetchSienge(`${SIENGE_BASE_URL}/payment-categories/${categoriaId}`);
    if (!r.ok) { cacheCategorias.set(categoriaId, `${categoriaId} - Categoria`); return cacheCategorias.get(categoriaId); }
    const d = await r.json();
    const texto = `${categoriaId} - ${d.name || 'Categoria'}`;
    cacheCategorias.set(categoriaId, texto);
    return texto;
  } catch {
    return `${categoriaId} - Categoria`;
  }
}

async function obraDoTitulo(billId) {
  const chave = `bill-${billId}`;
  if (cacheEmpreendimentos.has(chave)) return cacheEmpreendimentos.get(chave);
  try {
    const r = await fetchSienge(`${SIENGE_BASE_URL}/bills/${billId}/buildings-cost`);
    if (!r.ok) { cacheEmpreendimentos.set(chave, 'ADMINISTRATIVO'); return 'ADMINISTRATIVO'; }
    const d = await r.json();
    const nome = (d.results && d.results[0] && d.results[0].buildingName) || 'ADMINISTRATIVO';
    cacheEmpreendimentos.set(chave, nome);
    return nome;
  } catch {
    return 'ADMINISTRATIVO';
  }
}

async function obraDoRecebivel(billReceivableId) {
  const chave = `recebivel-${billReceivableId}`;
  if (cacheEmpreendimentos.has(chave)) return cacheEmpreendimentos.get(chave);
  try {
    const r = await fetchSienge(`${SIENGE_BASE_URL}/accounts-receivable/receivable-bills/${billReceivableId}`);
    if (!r.ok) { cacheEmpreendimentos.set(chave, 'ADMINISTRATIVO'); return 'ADMINISTRATIVO'; }
    const d = await r.json();
    const nome = d.enterpriseName || 'ADMINISTRATIVO';
    cacheEmpreendimentos.set(chave, nome);
    return nome;
  } catch {
    return 'ADMINISTRATIVO';
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

  try {
    // ===== CONTAS A PAGAR =====
    const limitePorPagina = 100;
    let offset = 0;
    let bills = [];
    while (true) {
      const url = `${SIENGE_BASE_URL}/bills?startDate=${startDate}&endDate=${endDate}&selectionType=D&limit=${limitePorPagina}&offset=${offset}`;
      const r = await fetchSienge(url);
      if (!r.ok) { avisos.push(`Falha ao buscar bills: status ${r.status}`); break; }
      const dados = await r.json();
      const pagina = dados.results || [];
      bills = bills.concat(pagina);
      const total = (dados.resultSetMetadata && dados.resultSetMetadata.count) || 0;
      offset += limitePorPagina;
      if (pagina.length === 0 || offset >= total) break;
    }

    const TAMANHO_LOTE = 3; // devagar de propósito, o Sienge bloqueia (429) se for rápido demais
    for (let i = 0; i < bills.length; i += TAMANHO_LOTE) {
      const lote = bills.slice(i, i + TAMANHO_LOTE);
      await Promise.all(lote.map(async (bill) => {
        try {
          const [rInst, rCat, credorNome, obraNome] = await Promise.all([
            fetchSienge(`${SIENGE_BASE_URL}/bills/${bill.id}/installments`),
            fetchSienge(`${SIENGE_BASE_URL}/bills/${bill.id}/budget-categories`),
            nomeCredor(bill.creditorId),
            obraDoTitulo(bill.id),
          ]);
          const instData = rInst.ok ? await rInst.json() : { results: [] };
          const installments = instData.results || [];
          const catData = rCat.ok ? await rCat.json() : { results: [] };
          const categoriaId = (catData.results && catData.results[0] && catData.results[0].paymentCategoriesId) || null;
          const contaTexto = categoriaId ? await nomeCategoria(categoriaId) : `${bill.documentIdentificationId || 'SEM CATEGORIA'}`;

          installments.forEach((inst) => {
            const pago = inst.situation === 'Totalmente paga';
            const prefixo = pago ? 'Pagamento' : 'A pagar';
            const dataRef = inst.dueDate || bill.issueDate;
            linhas.push(linhaCsv(dataRef, `${prefixo} - ${credorNome}`, inst.amount, obraNome, contaTexto, 'PAGAMENTO'));
          });
        } catch (e) {
          avisos.push(`Erro no título ${bill.id}: ${String(e)}`);
        }
      }));
      await esperar(250); // respiro entre lotes para não estourar o limite do Sienge
    }

    // ===== CONTAS A RECEBER =====
    let clientes = [];
    offset = 0;
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

    for (let i = 0; i < clientesComDocumento.length; i += TAMANHO_LOTE) {
      const lote = clientesComDocumento.slice(i, i + TAMANHO_LOTE);
      await Promise.all(lote.map(async (cliente) => {
        const paramDoc = cliente.cnpj ? `cnpj=${cliente.cnpj}` : `cpf=${cliente.cpf}`;
        try {
          const rSaldo = await fetchSienge(`${SIENGE_BASE_URL}/current-debit-balance?${paramDoc}`);
          if (!rSaldo.ok) { avisos.push(`Erro no cliente ${cliente.name}: status ${rSaldo.status}`); return; }
          const dadosSaldo = await rSaldo.json();
          const contasRecebiveis = dadosSaldo.results || [];

          for (const conta of contasRecebiveis) {
            const contaTexto = contaDeRecebivel(conta.documentId);
            const obraNome = await obraDoRecebivel(conta.billReceivableId);

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
      await esperar(250);
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
